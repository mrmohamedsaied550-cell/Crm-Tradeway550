import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';

/**
 * P2-03 — Bonus Engine.
 *
 * Fires when a captain is activated (lead converted) and writes one
 * `BonusAccrual` row per matching active `BonusRule`. Idempotency is
 * enforced by the unique on (bonusRuleId, captainId, triggerKind), so
 * re-running `onActivationInTx` for the same captain is a no-op.
 *
 * Matching policy (MVP):
 *   - bonusType = 'activation'
 *   - bonus_rule.is_active = true
 *   - rule.teamId is null OR rule.teamId = captain.teamId
 *   - rule.roleId is null OR rule.roleId = recipient.roleId
 *
 * Out of scope for the MVP:
 *   - Company / country narrowing on rules. Captain has a teamId
 *     but no direct companyId / countryId, and walking
 *     team → country → companyId would couple the engine to the
 *     org tree. For now company / country live as documentation
 *     fields on the rule; the team filter is the operative scope.
 *     P2-13 (payout pipeline) is the right home for richer scope.
 *   - first_trip / trip_milestone — no trip data model yet.
 *
 * Notifications: each accrual fires a `bonus.accrued` notification
 * to the recipient. Idempotency means a second invocation does not
 * re-bell.
 */
@Injectable()
export class BonusEngine {
  private readonly logger = new Logger(BonusEngine.name);

  constructor(
    private readonly audit: AuditService,
    private readonly notifications?: NotificationsService,
  ) {}

  async onActivationInTx(
    tx: Prisma.TransactionClient,
    tenantId: string,
    input: {
      captainId: string;
      captainTeamId: string | null;
      recipientUserId: string;
      actorUserId: string | null;
    },
  ): Promise<{ created: number; skipped: number }> {
    const recipient = await tx.user.findUnique({
      where: { id: input.recipientUserId },
      select: { id: true, roleId: true },
    });
    if (!recipient) {
      this.logger.warn(
        `bonus.engine: skipping; recipient ${input.recipientUserId} not found in tenant ${tenantId}`,
      );
      return { created: 0, skipped: 0 };
    }

    const candidates = await tx.bonusRule.findMany({
      where: {
        isActive: true,
        bonusType: 'activation',
        AND: [
          { OR: [{ teamId: null }, { teamId: input.captainTeamId ?? undefined }] },
          { OR: [{ roleId: null }, { roleId: recipient.roleId }] },
        ],
      },
      select: { id: true, amount: true, bonusType: true },
    });

    let created = 0;
    let skipped = 0;
    for (const rule of candidates) {
      // Pre-check rather than catching P2002 inside the tx: a unique
      // violation aborts the Postgres transaction (state 25P02), so
      // we can't catch + continue across the same withTenant block.
      const existing = await tx.bonusAccrual.findUnique({
        where: {
          bonusRuleId_captainId_triggerKind: {
            bonusRuleId: rule.id,
            captainId: input.captainId,
            triggerKind: 'activation',
          },
        },
        select: { id: true },
      });
      if (existing) {
        skipped += 1;
        continue;
      }
      const accrual = await tx.bonusAccrual.create({
        data: {
          tenantId,
          bonusRuleId: rule.id,
          recipientUserId: input.recipientUserId,
          captainId: input.captainId,
          triggerKind: 'activation',
          amount: rule.amount,
          status: 'pending',
          payload: {
            event: 'activation',
            captainTeamId: input.captainTeamId,
          } as Prisma.InputJsonValue,
        },
      });
      created += 1;

      await this.audit.writeInTx(tx, tenantId, {
        action: 'bonus.accrued',
        entityType: 'bonus_accrual',
        entityId: accrual.id,
        actorUserId: input.actorUserId,
        payload: {
          bonusRuleId: rule.id,
          captainId: input.captainId,
          recipientUserId: input.recipientUserId,
          amount: accrual.amount.toString(),
          triggerKind: 'activation',
        },
      });

      if (this.notifications) {
        await this.notifications.createInTx(tx, tenantId, {
          recipientUserId: input.recipientUserId,
          kind: 'bonus.accrued',
          title: `Bonus earned: ${accrual.amount.toString()}`,
          body: `Activation bonus pending payout.`,
          payload: {
            accrualId: accrual.id,
            bonusRuleId: rule.id,
            captainId: input.captainId,
            triggerKind: 'activation',
          },
        });
      }
    }

    if (created > 0 || skipped > 0) {
      this.logger.log(
        `bonus.engine: captain=${input.captainId} created=${created} skipped=${skipped}`,
      );
    }
    return { created, skipped };
  }
}
