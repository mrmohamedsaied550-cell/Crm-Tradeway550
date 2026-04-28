import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { TenantsService } from '../tenants/tenants.service';
import { type RoleWithCapabilities } from '../rbac/rbac.service';
import { verifyPassword } from './password.util';
import { LockoutService } from './lockout.service';
import { SessionsService } from './sessions.service';
import { TokensService } from './tokens.service';

export interface LoginInput {
  email: string;
  password: string;
  tenantCode: string;
  userAgent?: string | undefined;
  ip?: string | undefined;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface AuthResult extends AuthTokens {
  user: {
    id: string;
    email: string;
    name: string;
    language: string;
    roleId: string;
    role: { id: string; code: string; nameAr: string; nameEn: string; level: number };
    capabilities: readonly string[];
  };
}

/**
 * Public auth flows. Constructed from the smaller services (tenants,
 * users, sessions, tokens, lockout, rbac) so each piece is independently
 * testable. Errors are normalised to UnauthorizedException with stable
 * `code` strings so the frontend can branch without parsing prose.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenants: TenantsService,
    private readonly sessions: SessionsService,
    private readonly tokens: TokensService,
    private readonly lockout: LockoutService,
  ) {}

  // ───────────────────────────────────────────────────────────────────────
  // login
  // ───────────────────────────────────────────────────────────────────────

  async login(input: LoginInput): Promise<AuthResult> {
    const tenant = await this.tenants.findByCode(input.tenantCode);
    if (!tenant || !tenant.isActive) {
      throw this.invalidCredentials();
    }
    const tenantId = tenant.id;

    const email = input.email.trim().toLowerCase();
    const userRow = await this.prisma.withTenant(tenantId, (tx) =>
      tx.user.findUnique({
        where: { tenantId_email: { tenantId, email } },
        select: {
          id: true,
          tenantId: true,
          email: true,
          passwordHash: true,
          name: true,
          phone: true,
          language: true,
          roleId: true,
          status: true,
          mfaEnabled: true,
          lastLoginAt: true,
          failedLoginCount: true,
          lockedUntil: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
    );

    if (!userRow) throw this.invalidCredentials();
    if (userRow.status === 'disabled') throw this.disabled();
    if (this.lockout.isLocked(userRow)) throw this.lockedOut(userRow.lockedUntil);

    const ok = await verifyPassword(input.password, userRow.passwordHash);
    if (!ok) {
      const after = await this.lockout.recordFailure(tenantId, userRow.id);
      if (after.lockedUntil && this.lockout.isLocked(after)) {
        throw this.lockedOut(after.lockedUntil);
      }
      throw this.invalidCredentials();
    }

    await this.lockout.recordSuccess(tenantId, userRow.id);

    const role = await this.resolveRoleOrThrow(tenantId, userRow.roleId);

    // Pre-allocate the session id so the signed refresh JWT and the row both
    // reference the same identifier. The JWT body itself is what we hash and
    // store — that way refresh can verify both the signature and the
    // server-side revocation state from the same input.
    const sessionId = randomUUID();
    const refreshToken = this.tokens.signRefresh({
      sub: userRow.id,
      tid: tenantId,
      sid: sessionId,
    });
    await this.sessions.create({
      id: sessionId,
      tenantId,
      userId: userRow.id,
      refreshTokenHash: this.tokens.hash(refreshToken),
      userAgent: input.userAgent,
      ip: input.ip,
    });

    return {
      accessToken: this.tokens.signAccess({
        sub: userRow.id,
        tid: tenantId,
        rid: userRow.roleId,
      }),
      refreshToken,
      user: this.publicUserShape(userRow, role),
    };
  }

  // ───────────────────────────────────────────────────────────────────────
  // refresh
  // ───────────────────────────────────────────────────────────────────────

  async refresh(
    rawRefreshToken: string,
    opts: {
      userAgent?: string | undefined;
      ip?: string | undefined;
    },
  ): Promise<AuthResult> {
    const claims = this.safeVerifyRefresh(rawRefreshToken);

    // Look the session up by hash (rather than by id from the claim) so a
    // forged JWT carrying a real session id but the wrong body cannot
    // succeed. The hash we compute here MUST match the hash stored at
    // login/rotation time.
    const session = await this.sessions.findByHash(claims.tid, this.tokens.hash(rawRefreshToken));
    if (!session) {
      // Token verifies but no session row matches — possible hash drift;
      // safest to reject without disclosing which fact is wrong.
      throw this.invalidCredentials();
    }

    if (session.revokedAt !== null) {
      // REUSE DETECTED — revoke every descendant in the chain. Original
      // session is already revoked; this revokes the rotated children too.
      this.logger.warn(`refresh reuse detected: session=${session.id}`);
      await this.sessions.revokeChainFrom(claims.tid, session.id);
      throw this.invalidCredentials();
    }

    if (session.expiresAt.getTime() <= Date.now()) {
      throw this.invalidCredentials();
    }

    // Rotate. New session id is pre-allocated so the new refresh JWT can
    // include it as `sid`, and the row can use the same id.
    const newSessionId = randomUUID();
    const newRefreshToken = this.tokens.signRefresh({
      sub: claims.sub,
      tid: claims.tid,
      sid: newSessionId,
    });
    await this.sessions.rotate({
      newId: newSessionId,
      tenantId: claims.tid,
      userId: claims.sub,
      oldSessionId: session.id,
      newRefreshTokenHash: this.tokens.hash(newRefreshToken),
      userAgent: opts.userAgent,
      ip: opts.ip,
    });

    // Reload user + role so callers see the freshest snapshot.
    const userRow = await this.prisma.withTenant(claims.tid, (tx) =>
      tx.user.findUniqueOrThrow({
        where: { id: claims.sub },
        select: {
          id: true,
          email: true,
          name: true,
          phone: true,
          language: true,
          roleId: true,
          status: true,
          mfaEnabled: true,
          lastLoginAt: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
    );

    if (userRow.status === 'disabled') {
      // The user was disabled mid-session — revoke everything.
      await this.sessions.revokeAllForUser(claims.tid, userRow.id);
      throw this.disabled();
    }

    const role = await this.resolveRoleOrThrow(claims.tid, userRow.roleId);

    return {
      accessToken: this.tokens.signAccess({
        sub: userRow.id,
        tid: claims.tid,
        rid: userRow.roleId,
      }),
      refreshToken: newRefreshToken,
      user: this.publicUserShape(userRow, role),
    };
  }

  // ───────────────────────────────────────────────────────────────────────
  // logout
  // ───────────────────────────────────────────────────────────────────────

  async logout(rawRefreshToken: string): Promise<void> {
    const claims = this.tryVerifyRefresh(rawRefreshToken);
    if (!claims) return; // silent no-op for tokens we can't verify
    const session = await this.sessions.findByHash(claims.tid, this.tokens.hash(rawRefreshToken));
    if (session && session.revokedAt === null) {
      await this.sessions.revoke(claims.tid, session.id);
    }
  }

  async logoutAll(tenantId: string, userId: string): Promise<void> {
    await this.sessions.revokeAllForUser(tenantId, userId);
  }

  // ───────────────────────────────────────────────────────────────────────
  // /me
  // ───────────────────────────────────────────────────────────────────────

  async me(tenantId: string, userId: string): Promise<AuthResult['user']> {
    const userRow = await this.prisma.withTenant(tenantId, (tx) =>
      tx.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          name: true,
          phone: true,
          language: true,
          roleId: true,
          status: true,
          mfaEnabled: true,
          lastLoginAt: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
    );
    if (!userRow || userRow.status === 'disabled') {
      throw this.invalidCredentials();
    }
    const role = await this.resolveRoleOrThrow(tenantId, userRow.roleId);
    return this.publicUserShape(userRow, role);
  }

  // ───────────────────────────────────────────────────────────────────────
  // helpers
  // ───────────────────────────────────────────────────────────────────────

  private async resolveRoleOrThrow(
    tenantId: string,
    roleId: string,
  ): Promise<RoleWithCapabilities> {
    // RbacService.listRoles uses requireTenantId(); here we re-enter the
    // tenant scope explicitly via withTenant so login (pre-context) can work.
    const roles = await this.prisma.withTenant(tenantId, (tx) =>
      tx.role.findMany({
        include: { capabilities: { include: { capability: { select: { code: true } } } } },
      }),
    );
    const r = roles.find((row) => row.id === roleId);
    if (!r) throw this.invalidCredentials();
    return {
      id: r.id,
      code: r.code as RoleWithCapabilities['code'],
      nameAr: r.nameAr,
      nameEn: r.nameEn,
      level: r.level,
      isActive: r.isActive,
      capabilities: r.capabilities.map((rc) => rc.capability.code as string),
    } as RoleWithCapabilities;
  }

  private publicUserShape(
    u: {
      id: string;
      email: string;
      name: string;
      language: string;
      roleId: string;
    },
    role: RoleWithCapabilities,
  ): AuthResult['user'] {
    return {
      id: u.id,
      email: u.email,
      name: u.name,
      language: u.language,
      roleId: u.roleId,
      role: {
        id: role.id,
        code: role.code,
        nameAr: role.nameAr,
        nameEn: role.nameEn,
        level: role.level,
      },
      capabilities: role.capabilities,
    };
  }

  // Stable error envelopes — controllers will map these to the global
  // exception filter's standard shape.
  private invalidCredentials(): UnauthorizedException {
    return new UnauthorizedException({
      code: 'auth.invalid_credentials',
      message: 'Invalid credentials',
    });
  }

  private disabled(): UnauthorizedException {
    return new UnauthorizedException({
      code: 'auth.disabled',
      message: 'Account is disabled',
    });
  }

  private lockedOut(until: Date | null): UnauthorizedException {
    return new UnauthorizedException({
      code: 'auth.locked',
      message: 'Account is temporarily locked',
      details: { until: until?.toISOString() },
    });
  }

  private safeVerifyRefresh(token: string) {
    try {
      return this.tokens.verifyRefresh(token);
    } catch {
      throw this.invalidCredentials();
    }
  }

  private tryVerifyRefresh(token: string) {
    try {
      return this.tokens.verifyRefresh(token);
    } catch {
      return null;
    }
  }
}
