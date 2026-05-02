import { Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { requireTenantId } from '../tenants/tenant-context';

/**
 * P2-02 — in-app notifications service.
 *
 * `createInTx` appends inside an existing transaction so the parent
 * write + the notification land or roll back together. `create` is
 * the best-effort outside-tx variant — failures are warned and
 * swallowed, never bubbling up to break the calling write.
 *
 * The unread / list / markRead surface is consumed by the AuthBar's
 * polling endpoint and a future inbox page.
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
    input: {
      recipientUserId: string;
      kind: string;
      title: string;
      body?: string | null;
      payload?: Prisma.InputJsonValue;
    },
  ): Promise<void> {
    const row = await tx.notification.create({
      data: {
        tenantId,
        recipientUserId: input.recipientUserId,
        kind: input.kind,
        title: input.title,
        body: input.body ?? null,
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
      this.realtime?.emitToUser(tenantId, input.recipientUserId, {
        type: 'notification.created',
        notificationId: row.id,
        recipientUserId: input.recipientUserId,
        kind: input.kind,
      });
    } catch (err) {
      this.logger.warn(`realtime emit skipped: ${(err as Error).message}`);
    }
  }

  /** Best-effort write outside a transaction. Failures are swallowed. */
  async create(input: {
    recipientUserId: string;
    kind: string;
    title: string;
    body?: string | null;
    payload?: Prisma.InputJsonValue;
  }): Promise<void> {
    const tenantId = requireTenantId();
    try {
      await this.prisma.withTenant(tenantId, (tx) => this.createInTx(tx, tenantId, input));
    } catch (err) {
      this.logger.warn(`notification.create swallowed: ${(err as Error).name}`);
    }
  }

  list(userId: string, opts: { unreadOnly?: boolean; limit?: number } = {}) {
    const tenantId = requireTenantId();
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.notification.findMany({
        where: {
          recipientUserId: userId,
          ...(opts.unreadOnly && { readAt: null }),
        },
        orderBy: [{ readAt: 'asc' }, { createdAt: 'desc' }],
        take: Math.min(opts.limit ?? 50, 200),
      }),
    );
  }

  unreadCount(userId: string): Promise<number> {
    const tenantId = requireTenantId();
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.notification.count({
        where: { recipientUserId: userId, readAt: null },
      }),
    );
  }

  async markRead(id: string, userId: string) {
    const tenantId = requireTenantId();
    return this.prisma.withTenant(tenantId, async (tx) => {
      const row = await tx.notification.findUnique({
        where: { id },
        select: { recipientUserId: true, readAt: true },
      });
      if (!row || row.recipientUserId !== userId) {
        throw new NotFoundException({
          code: 'notification.not_found',
          message: `Notification ${id} not found for the calling user`,
        });
      }
      if (row.readAt) return tx.notification.findUnique({ where: { id } });
      return tx.notification.update({
        where: { id },
        data: { readAt: new Date() },
      });
    });
  }

  async markAllRead(userId: string): Promise<{ count: number }> {
    const tenantId = requireTenantId();
    const res = await this.prisma.withTenant(tenantId, (tx) =>
      tx.notification.updateMany({
        where: { recipientUserId: userId, readAt: null },
        data: { readAt: new Date() },
      }),
    );
    return { count: res.count };
  }
}
