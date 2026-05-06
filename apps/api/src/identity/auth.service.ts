import { Injectable, Logger, Optional, UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
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

/**
 * Phase D5 — D5.9: pure helper that derives the public permission
 * shape (`fieldPermissions` flat list + per-resource deny maps +
 * scope map) from a role row. Exported so the auth tests can
 * exercise the projection without standing up Postgres + a full
 * `AuthService` instance.
 *
 * Behaviour:
 *   • super-admin                  → empty `fieldPermissions`
 *                                    AND empty deny maps. The
 *                                    `scopesByResource` ships
 *                                    verbatim (super-admin's
 *                                    bypass lives elsewhere; the
 *                                    payload reports the actual
 *                                    persisted scopes for
 *                                    transparency).
 *   • role.fieldPermissions        → grouped by resource into the
 *                                    deny maps when `canRead` /
 *                                    `canWrite` is false.
 *   • role.scopes                  → flattened into a flat
 *                                    `Record<resource, scope>`.
 *
 * Pure function — no I/O, no mutation of the input.
 */
export function derivePublicPermissionShape(role: RoleWithCapabilities): {
  fieldPermissions: ReadonlyArray<{
    resource: string;
    field: string;
    canRead: boolean;
    canWrite: boolean;
  }>;
  deniedReadFieldsByResource: Record<string, readonly string[]>;
  deniedWriteFieldsByResource: Record<string, readonly string[]>;
  scopesByResource: Record<string, string>;
} {
  const isSuperAdmin = role.code === 'super_admin';
  const fieldPermissions = isSuperAdmin
    ? []
    : role.fieldPermissions.map((p) => ({
        resource: p.resource,
        field: p.field,
        canRead: p.canRead,
        canWrite: p.canWrite,
      }));
  const deniedReadFieldsByResource: Record<string, string[]> = {};
  const deniedWriteFieldsByResource: Record<string, string[]> = {};
  if (!isSuperAdmin) {
    for (const p of role.fieldPermissions) {
      if (!p.canRead) {
        (deniedReadFieldsByResource[p.resource] ??= []).push(p.field);
      }
      if (!p.canWrite) {
        (deniedWriteFieldsByResource[p.resource] ??= []).push(p.field);
      }
    }
  }
  const scopesByResource: Record<string, string> = {};
  for (const s of role.scopes) {
    scopesByResource[s.resource as string] = s.scope as string;
  }
  return {
    fieldPermissions,
    deniedReadFieldsByResource,
    deniedWriteFieldsByResource,
    scopesByResource,
  };
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
    /**
     * Phase C — C4: per-(resource × field) read/write toggles for the
     * user's role. Empty array when the role has no field-permission
     * rows OR when the bypass kicks in (super_admin returns []).
     * The frontend uses this to mirror the server-side filter:
     * fields with `canRead = false` should be hidden from forms /
     * detail surfaces. The server is the source of truth — the
     * client list is only a UX guide so that nothing renders that
     * the API would strip anyway.
     */
    fieldPermissions: ReadonlyArray<{
      resource: string;
      field: string;
      canRead: boolean;
      canWrite: boolean;
    }>;
    /**
     * Phase D5 — D5.9: derived `Record<resource, field[]>` projections
     * of the role's deny rows. Empty objects on the super_admin
     * bypass. The SPA's permission helpers consult these instead of
     * re-walking the flat `fieldPermissions` list on every render.
     * The server remains the source of truth — the client maps are
     * UX guidance ONLY (server-side redaction at C3/C4/C5/D5.x is
     * what actually keeps data out of responses).
     *
     * Important: these maps describe ROLE METADATA only — they
     * never carry hidden field VALUES. An admin reviewing the
     * payload sees "this role can't read lead.phone" but never the
     * phone numbers themselves.
     */
    deniedReadFieldsByResource: Record<string, readonly string[]>;
    deniedWriteFieldsByResource: Record<string, readonly string[]>;
    /**
     * Phase D5 — D5.9: per-resource role scope (own / team /
     * company / country / global). Drives banners like
     * "Showing leads from your team only". Resources without an
     * explicit `role_scopes` row default to `'global'` server-side;
     * absent keys here mean the same on the client.
     */
    scopesByResource: Record<string, string>;
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
    // Optional so the existing hand-instantiated test harnesses keep
    // compiling. Production wiring always supplies AuditService via
    // the global AuditModule.
    @Optional() private readonly audit?: AuditService,
  ) {}

  /**
   * P2-04 — audit write for an authentication flow.
   *
   * Awaited so the row is on disk before the auth method returns
   * (and before a test or a subsequent request reads from the
   * audit table). The underlying `AuditService.writeForTenant`
   * already swallows its own errors, so an audit-table outage
   * never breaks authentication.
   */
  private async auditAuth(
    tenantId: string,
    action: string,
    actorUserId: string | null,
    payload: Prisma.InputJsonValue,
  ): Promise<void> {
    if (!this.audit) return;
    await this.audit.writeForTenant(tenantId, {
      action,
      entityType: 'user',
      entityId: actorUserId,
      actorUserId,
      payload,
    });
  }

  /**
   * P2-04 — uniform shape for the `payload` JSON of every
   * `auth.*` audit row: `{ ip, userAgent, email?, reason? }`.
   * Empty values are dropped so the JSONB column stays compact.
   */
  private authPayload(input: {
    ip?: string | undefined;
    userAgent?: string | undefined;
    email?: string | undefined;
    reason?: string | undefined;
    extra?: Record<string, unknown>;
  }): Prisma.InputJsonValue {
    const out: Record<string, unknown> = { ...(input.extra ?? {}) };
    if (input.ip) out.ip = input.ip;
    if (input.userAgent) out.userAgent = input.userAgent;
    if (input.email) out.email = input.email;
    if (input.reason) out.reason = input.reason;
    return out as Prisma.InputJsonValue;
  }

  // ───────────────────────────────────────────────────────────────────────
  // login
  // ───────────────────────────────────────────────────────────────────────

  async login(input: LoginInput): Promise<AuthResult> {
    const tenant = await this.tenants.findByCode(input.tenantCode);
    if (!tenant || !tenant.isActive) {
      // No tenantId → can't write to audit_events. Pino already
      // logs login attempts at the http-access layer, so this is
      // intentionally silent at the audit layer.
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

    if (!userRow) {
      await this.auditAuth(
        tenantId,
        'auth.login.failed',
        null,
        this.authPayload({
          ip: input.ip,
          userAgent: input.userAgent,
          email,
          reason: 'user_not_found',
        }),
      );
      throw this.invalidCredentials();
    }
    if (userRow.status === 'disabled') {
      await this.auditAuth(
        tenantId,
        'auth.login.failed',
        userRow.id,
        this.authPayload({
          ip: input.ip,
          userAgent: input.userAgent,
          email,
          reason: 'disabled',
        }),
      );
      throw this.disabled();
    }
    if (this.lockout.isLocked(userRow)) {
      await this.auditAuth(
        tenantId,
        'auth.login.failed',
        userRow.id,
        this.authPayload({
          ip: input.ip,
          userAgent: input.userAgent,
          email,
          reason: 'locked',
          extra: { lockedUntil: userRow.lockedUntil?.toISOString() ?? null },
        }),
      );
      throw this.lockedOut(userRow.lockedUntil);
    }

    const ok = await verifyPassword(input.password, userRow.passwordHash);
    if (!ok) {
      const after = await this.lockout.recordFailure(tenantId, userRow.id);
      await this.auditAuth(
        tenantId,
        'auth.login.failed',
        userRow.id,
        this.authPayload({
          ip: input.ip,
          userAgent: input.userAgent,
          email,
          reason: 'wrong_password',
        }),
      );
      if (after.lockedUntil && this.lockout.isLocked(after)) {
        // The latest failure tipped the user into a locked state.
        // Emit a separate audit row so the lockout is searchable
        // even if the operator filters on `auth.lockout`.
        await this.auditAuth(
          tenantId,
          'auth.lockout',
          userRow.id,
          this.authPayload({
            ip: input.ip,
            userAgent: input.userAgent,
            email,
            extra: {
              lockedUntil: after.lockedUntil.toISOString(),
              lockMinutes: LockoutService.LOCK_MINUTES,
            },
          }),
        );
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

    await this.auditAuth(
      tenantId,
      'auth.login.success',
      userRow.id,
      this.authPayload({
        ip: input.ip,
        userAgent: input.userAgent,
        email,
        extra: { sessionId },
      }),
    );

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
      await this.auditAuth(
        claims.tid,
        'auth.token.refresh.failed',
        claims.sub,
        this.authPayload({
          ip: opts.ip,
          userAgent: opts.userAgent,
          reason: 'session_not_found',
        }),
      );
      throw this.invalidCredentials();
    }

    if (session.revokedAt !== null) {
      // REUSE DETECTED — revoke every descendant in the chain. Original
      // session is already revoked; this revokes the rotated children too.
      this.logger.warn(`refresh reuse detected: session=${session.id}`);
      await this.sessions.revokeChainFrom(claims.tid, session.id);
      await this.auditAuth(
        claims.tid,
        'auth.token.refresh.reuse_detected',
        claims.sub,
        this.authPayload({
          ip: opts.ip,
          userAgent: opts.userAgent,
          extra: { sessionId: session.id },
        }),
      );
      throw this.invalidCredentials();
    }

    if (session.expiresAt.getTime() <= Date.now()) {
      await this.auditAuth(
        claims.tid,
        'auth.token.refresh.failed',
        claims.sub,
        this.authPayload({
          ip: opts.ip,
          userAgent: opts.userAgent,
          reason: 'expired',
          extra: { sessionId: session.id },
        }),
      );
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
      await this.auditAuth(
        claims.tid,
        'auth.token.refresh.failed',
        userRow.id,
        this.authPayload({
          ip: opts.ip,
          userAgent: opts.userAgent,
          reason: 'disabled',
        }),
      );
      throw this.disabled();
    }

    const role = await this.resolveRoleOrThrow(claims.tid, userRow.roleId);

    await this.auditAuth(
      claims.tid,
      'auth.token.refresh',
      userRow.id,
      this.authPayload({
        ip: opts.ip,
        userAgent: opts.userAgent,
        extra: { oldSessionId: session.id, newSessionId },
      }),
    );

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

  async logout(
    rawRefreshToken: string,
    opts: { ip?: string | undefined; userAgent?: string | undefined } = {},
  ): Promise<void> {
    const claims = this.tryVerifyRefresh(rawRefreshToken);
    if (!claims) return; // silent no-op for tokens we can't verify
    const session = await this.sessions.findByHash(claims.tid, this.tokens.hash(rawRefreshToken));
    if (session && session.revokedAt === null) {
      await this.sessions.revoke(claims.tid, session.id);
      await this.auditAuth(
        claims.tid,
        'auth.logout',
        claims.sub,
        this.authPayload({
          ip: opts.ip,
          userAgent: opts.userAgent,
          extra: { sessionId: session.id },
        }),
      );
    }
  }

  async logoutAll(
    tenantId: string,
    userId: string,
    opts: { ip?: string | undefined; userAgent?: string | undefined } = {},
  ): Promise<void> {
    await this.sessions.revokeAllForUser(tenantId, userId);
    await this.auditAuth(
      tenantId,
      'auth.logout.all',
      userId,
      this.authPayload({ ip: opts.ip, userAgent: opts.userAgent }),
    );
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
        include: {
          capabilities: { include: { capability: { select: { code: true } } } },
          scopes: { select: { resource: true, scope: true } },
          fieldPermissions: {
            select: { resource: true, field: true, canRead: true, canWrite: true },
          },
        },
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
      isSystem: r.isSystem,
      description: r.description,
      capabilities: r.capabilities.map((rc) => rc.capability.code as string),
      scopes: r.scopes.map((s) => ({
        resource: s.resource as RoleWithCapabilities['scopes'][number]['resource'],
        scope: s.scope as RoleWithCapabilities['scopes'][number]['scope'],
      })),
      fieldPermissions: r.fieldPermissions.map((p) => ({
        resource: p.resource,
        field: p.field,
        canRead: p.canRead,
        canWrite: p.canWrite,
      })),
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
    const perms = derivePublicPermissionShape(role);
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
      fieldPermissions: perms.fieldPermissions,
      deniedReadFieldsByResource: perms.deniedReadFieldsByResource,
      deniedWriteFieldsByResource: perms.deniedWriteFieldsByResource,
      scopesByResource: perms.scopesByResource,
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
