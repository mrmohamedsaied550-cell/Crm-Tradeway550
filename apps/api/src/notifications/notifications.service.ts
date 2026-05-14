import { Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { requireTenantId } from '../tenants/tenant-context';

/** Sprint 9 (D9) — severity vocabulary persisted on the row. */
export type NotificationSeverity = 'info' | 'success' | 'warning' | 'danger';

/**
 * Sprint 9 (D9) — shared shape for both `createInTx` and `create`.
 *
 * Exactly one of `recipientUserId` / `recipientTeamId` must be set
 * (the database CHECK constraint enforces this; the service throws
 * before reaching the DB so the audit log isn't polluted). Severity
 * and actionUrl are optional but recommended — the bell renders a
 * neutral dot when severity is null, and a non-clickable row when
 * actionUrl is null.
 */
export interface CreateNotificationInput {
  recipientUserId?: string | null;
  recipientTeamId?: string | null;
  kind: string;
  title: string;
  body?: string | null;
  severity?: NotificationSeverity | null;
  actionUrl?: string | null;
  payload?: Prisma.InputJsonValue;
}

/**
 * P2-02 — in-app notifications service.
 *
 * `createInTx` appends inside an existing transaction so the parent
 * write + the notification land or roll back together. `create` is
 * the best-effort outside-tx variant — failures are warned and
 * swallowed, never bubbling up to break the calling write.
 *
 * Sprint 9 (D9): now accepts severity / actionUrl / recipientTeamId
 * inline. The bell's list/unread endpoints widen to include rows
 * where (a) the row is user-targeted at the caller OR (b) the row
 * is team-targeted at the caller's team.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  /**
   * RealtimeService is `@Optional` so unit tests that build a thin
   * NotificationsService without the full DI graph still work — the
   * realtime push is a fire-and-forget enhancement on top of the
   * persisted row.
   */
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly realtime?: RealtimeService,
  ) {}

  async createInTx(
    tx: Prisma.TransactionClient,
    tenantId: string,
    input: CreateNotificationInput,
  ): Promise<void> {
    const recipientUserId = input.recipientUserId ?? null;
    const recipientTeamId = input.recipientTeamId ?? null;
    if (!recipientUserId && !recipientTeamId) {
      throw new Error('Notification requires recipientUserId or recipientTeamId');
    }
    const row = await tx.notification.create({
      data: {
        tenantId,
        recipientUserId,
        recipientTeamId,
        kind: input.kind,
        title: input.title,
        body: input.body ?? null,
        severity: input.severity ?? null,
        actionUrl: input.actionUrl ?? null,
        ...(input.payload !== undefined && { payload: input.payload }),
      },
      select: { id: true },
    });
    // P3-02 — push the new notification id to the recipient's open
    // SSE connections. The client uses it as a hint to refetch the
    // notifications inbox + unread-count over REST. Emit AFTER the
    // insert so the client never sees a stale list when it refetches.
    // Wrap in try/catch so a misbehaving sink can never poison the
    // outer transaction commit.
    try {
      if (recipientUserId) {
        this.realtime?.emitToUser(tenantId, recipientUserId, {
          type: 'notification.created',
          notificationId: row.id,
          recipientUserId,
          kind: input.kind,
        });
      }
      // Team-targeted realtime fan-out is deferred — the bell's
      // 30-s poll fallback covers Sprint 9. A future sprint can add
      // a team subscription channel without changing this surface.
    } catch (err) {
      this.logger.warn(`realtime emit skipped: ${(err as Error).message}`);
    }
  }

  /** Best-effort write outside a transaction. Failures are swallowed. */
  async create(input: CreateNotificationInput): Promise<void> {
    const tenantId = requireTenantId();
    try {
      await this.prisma.withTenant(tenantId, (tx) => this.createInTx(tx, tenantId, input));
    } catch (err) {
      this.logger.warn(`notification.create swallowed: ${(err as Error).name}`);
    }
  }

  /**
   * Sprint 9 (D9) — every read endpoint widens to "user-targeted OR
   * team-targeted to my team". The caller's `teamId` is looked up
   * fresh per call so a user who switches teams immediately stops
   * seeing the old team's notifications.
   *
   * Cross-tenant safety is unchanged: `withTenant` opens the
   * Postgres GUC + RLS chain, so a notification from another
   * tenant can never join the response even if a row id leaks.
   */
  private async visibilityFilter(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<Prisma.NotificationWhereInput> {
    const me = await tx.user.findUnique({
      where: { id: userId },
      select: { teamId: true },
    });
    const teamId = me?.teamId ?? null;
    if (teamId) {
      return { OR: [{ recipientUserId: userId }, { recipientTeamId: teamId }] };
    }
    return { recipientUserId: userId };
  }

  list(userId: string, opts: { unreadOnly?: boolean; limit?: number } = {}) {
    const tenantId = requireTenantId();
    return this.prisma.withTenant(tenantId, async (tx) => {
      const visibility = await this.visibilityFilter(tx, userId);
      return tx.notification.findMany({
        where: {
          ...visibility,
          ...(opts.unreadOnly && { readAt: null }),
        },
        orderBy: [{ readAt: 'asc' }, { createdAt: 'desc' }],
        take: Math.min(opts.limit ?? 50, 200),
      });
    });
  }

  async unreadCount(userId: string): Promise<number> {
    const tenantId = requireTenantId();
    return this.prisma.withTenant(tenantId, async (tx) => {
      const visibility = await this.visibilityFilter(tx, userId);
      return tx.notification.count({ where: { ...visibility, readAt: null } });
    });
  }

  async markRead(id: string, userId: string) {
    const tenantId = requireTenantId();
    return this.prisma.withTenant(tenantId, async (tx) => {
      const visibility = await this.visibilityFilter(tx, userId);
      const row = await tx.notification.findFirst({
        where: { id, ...visibility },
        select: { id: true, readAt: true },
      });
      if (!row) {
        throw new NotFoundException({
          code: 'notification.not_found',
          message: `Notification ${id} not found for the calling user`,
        });
      }
      if (row.readAt) return tx.notification.findUnique({ where: { id } });
      return tx.notification.update({
        where: { id: row.id },
        data: { readAt: new Date() },
      });
    });
  }

  async markAllRead(userId: string): Promise<{ count: number }> {
    const tenantId = requireTenantId();
    const res = await this.prisma.withTenant(tenantId, async (tx) => {
      const visibility = await this.visibilityFilter(tx, userId);
      return tx.notification.updateMany({
        where: { ...visibility, readAt: null },
        data: { readAt: new Date() },
      });
    });
    return { count: res.count };
  }
}
