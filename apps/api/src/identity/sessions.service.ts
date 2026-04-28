import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TokensService } from './tokens.service';

export interface CreateSessionInput {
  /** Pre-allocated session id — must match the `sid` claim of the refresh JWT. */
  id: string;
  tenantId: string;
  userId: string;
  /** SHA-256 of the signed refresh JWT (caller hashes via TokensService.hash). */
  refreshTokenHash: string;
  userAgent?: string | undefined;
  ip?: string | undefined;
}

/**
 * SessionsService — refresh token storage and rotation.
 *
 * All queries pass through PrismaService.withTenant(), so the database's
 * RLS policy is the actual gate. The service receives the tenantId
 * explicitly because the login flow runs *before* any tenant context is
 * established (the JWT that would carry the claim doesn't exist yet).
 */
@Injectable()
export class SessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokensService,
  ) {}

  /** Persist a freshly-issued refresh token. Returns the new session row. */
  async create(input: CreateSessionInput): Promise<{ id: string; expiresAt: Date }> {
    const expiresAt = new Date(Date.now() + this.tokens.refreshTtlSeconds() * 1000);
    return this.prisma.withTenant(input.tenantId, (tx) =>
      tx.userSession.create({
        data: {
          id: input.id,
          tenantId: input.tenantId,
          userId: input.userId,
          refreshTokenHash: input.refreshTokenHash,
          userAgent: input.userAgent ?? null,
          ip: input.ip ?? null,
          expiresAt,
        },
        select: { id: true, expiresAt: true },
      }),
    );
  }

  /**
   * Find a session by refresh-token hash (signed-JWT digest), regardless of
   * revoked state. Reuse-detection inspects `revokedAt` to decide whether
   * the chain has already been retired.
   */
  async findByHash(tenantId: string, refreshTokenHash: string) {
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.userSession.findFirst({ where: { refreshTokenHash } }),
    );
  }

  /**
   * Rotate a session: revoke the old row, create a new row, link old →
   * new via `replaced_by_id`. Returns the new row.
   *
   * Atomic per-row but not across the pair — both writes happen inside the
   * same transaction so an interrupted rotation cannot leave the chain in
   * a half-state.
   */
  async rotate(input: {
    /** Pre-allocated id for the NEW session — matches the new JWT's `sid` claim. */
    newId: string;
    tenantId: string;
    userId: string;
    oldSessionId: string;
    /** SHA-256 of the new signed refresh JWT. */
    newRefreshTokenHash: string;
    userAgent?: string | undefined;
    ip?: string | undefined;
  }): Promise<{ id: string; expiresAt: Date }> {
    const expiresAt = new Date(Date.now() + this.tokens.refreshTtlSeconds() * 1000);

    return this.prisma.withTenant(input.tenantId, async (tx) => {
      const created = await tx.userSession.create({
        data: {
          id: input.newId,
          tenantId: input.tenantId,
          userId: input.userId,
          refreshTokenHash: input.newRefreshTokenHash,
          userAgent: input.userAgent ?? null,
          ip: input.ip ?? null,
          expiresAt,
        },
        select: { id: true, expiresAt: true },
      });
      await tx.userSession.update({
        where: { id: input.oldSessionId },
        data: { revokedAt: new Date(), replacedById: created.id },
      });
      return created;
    });
  }

  /** Revoke a single session (used by /auth/logout). Idempotent. */
  async revoke(tenantId: string, sessionId: string): Promise<void> {
    await this.prisma.withTenant(tenantId, (tx) =>
      tx.userSession.updateMany({
        where: { id: sessionId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    );
  }

  /** Revoke every active session for a user (used by /auth/logout-all). */
  async revokeAllForUser(tenantId: string, userId: string): Promise<void> {
    await this.prisma.withTenant(tenantId, (tx) =>
      tx.userSession.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    );
  }

  /**
   * Reuse-detection helper.
   *
   * Walks the rotation chain starting from `sessionId` (a previously-revoked
   * row whose hash was just presented again) and revokes every descendant.
   * Stops at the first unrevoked row (which it also revokes), or when the
   * chain ends.
   */
  async revokeChainFrom(tenantId: string, sessionId: string): Promise<void> {
    await this.prisma.withTenant(tenantId, async (tx) => {
      type ChainRow = { id: string; replacedById: string | null; revokedAt: Date | null };
      let cursor: string | null = sessionId;
      const seen = new Set<string>();
      while (cursor && !seen.has(cursor)) {
        seen.add(cursor);
        const row: ChainRow | null = await tx.userSession.findUnique({
          where: { id: cursor },
          select: { id: true, replacedById: true, revokedAt: true },
        });
        if (!row) break;
        if (row.revokedAt === null) {
          await tx.userSession.update({
            where: { id: row.id },
            data: { revokedAt: new Date() },
          });
        }
        cursor = row.replacedById;
      }
    });
  }

  /** List active sessions for a user — used by /me future enhancements. */
  async listActiveForUser(tenantId: string, userId: string) {
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.userSession.findMany({
        where: { userId, revokedAt: null },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          userAgent: true,
          ip: true,
          createdAt: true,
          expiresAt: true,
        },
      }),
    );
  }
}
