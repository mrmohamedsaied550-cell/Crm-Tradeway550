import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { requireTenantId } from '../tenants/tenant-context';

export type AccrualStatus = 'pending' | 'paid' | 'void';

/**
 * P2-03 — read + status-transition surface for bonus_accruals.
 *
 * Engine writes go through `BonusEngine.onActivationInTx`; this
 * service is the admin / agent face: list mine, list all (admin),
 * mark paid, void.
 */
@Injectable()
export class BonusAccrualsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications?: NotificationsService,
  ) {}

  /** Tenant-wide accruals list, optionally filtered by status / recipient. */
  list(
    opts: {
      status?: AccrualStatus;
      recipientUserId?: string;
      limit?: number;
    } = {},
  ) {
    const tenantId = requireTenantId();
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.bonusAccrual.findMany({
        where: {
          ...(opts.status && { status: opts.status }),
          ...(opts.recipientUserId && { recipientUserId: opts.recipientUserId }),
        },
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
        take: Math.min(opts.limit ?? 100, 500),
        include: {
          bonusRule: {
            select: { id: true, bonusType: true, trigger: true, amount: true },
          },
          recipient: { select: { id: true, name: true, email: true } },
          captain: { select: { id: true, name: true, phone: true } },
        },
      }),
    );
  }

  /** "My accruals" — for the agent's own view. */
  listMine(userId: string, opts: { status?: AccrualStatus; limit?: number } = {}) {
    return this.list({ ...opts, recipientUserId: userId });
  }

  async setStatus(id: string, status: AccrualStatus, actorUserId: string | null) {
    const tenantId = requireTenantId();
    return this.prisma.withTenant(tenantId, async (tx) => {
      const row = await tx.bonusAccrual.findUnique({
        where: { id },
        select: { id: true, status: true, recipientUserId: true },
      });
      if (!row) {
        throw new NotFoundException({
          code: 'bonus.accrual_not_found',
          message: `Bonus accrual ${id} not found in active tenant`,
        });
      }
      const updated = await tx.bonusAccrual.update({
        where: { id },
        data: { status },
      });
      await this.audit.writeInTx(tx, tenantId, {
        action: status === 'paid' ? 'bonus.paid' : `bonus.${status}`,
        entityType: 'bonus_accrual',
        entityId: id,
        actorUserId,
        payload: {
          fromStatus: row.status,
          toStatus: status,
          recipientUserId: row.recipientUserId,
        } as Prisma.InputJsonValue,
      });
      if (status === 'paid' && this.notifications) {
        await this.notifications.createInTx(tx, tenantId, {
          recipientUserId: row.recipientUserId,
          kind: 'bonus.paid',
          title: 'Bonus paid out',
          body: `An accrual was just marked paid.`,
          payload: { accrualId: id },
        });
      }
      return updated;
    });
  }
}
