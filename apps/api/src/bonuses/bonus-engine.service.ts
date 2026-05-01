import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';

/**
 * P2-03 — Bonus Engine.
 *
 * Fires when a captain is activated (lead converted) or completes
 * their first trip (P2-09). One `BonusAccrual` row per matching
 * active `BonusRule`. Idempotency is enforced by the unique on
 * (bonusRuleId, captainId, triggerKind), so re-running for the
 * same (captain, triggerKind) is a no-op.
 *
 * Matching policy (MVP):
 *   - bonusType = the requested trigger kind (e.g. 'activation' or
 *     'first_trip')
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
 *   - trip_milestone — needs a richer rule schema (threshold count
 *     column or a JSON DSL). The current free-text `trigger` field
 *     can't drive deterministic firing.
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
    return this.fireForTrigger(tx, tenantId, {
      ...input,
      triggerKind: 'activation',
      eventPayload: { event: 'activation', captainTeamId: input.captainTeamId },
    });
  }

  /**
   * P2-09 — fires bonus rules of bonusType `first_trip`. Called by
   * `CaptainTripsService.recordTrip` exactly once per captain (the
   * idempotency guard is the (rule, captain, triggerKind) UNIQUE).
   */
  async onFirstTripInTx(
    tx: Prisma.TransactionClient,
    tenantId: string,
    input: {
      captainId: string;
      captainTeamId: string | null;
      recipientUserId: string;
      actorUserId: string | null;
      tripId: string;
      occurredAt: Date;
    },
  ): Promise<{ created: number; skipped: number }> {
    return this.fireForTrigger(tx, tenantId, {
      captainId: input.captainId,
      captainTeamId: input.captainTeamId,
      recipientUserId: input.recipientUserId,
      actorUserId: input.actorUserId,
      triggerKind: 'first_trip',
      bonusType: 'first_trip',
      eventPayload: {
        event: 'first_trip',
        captainTeamId: input.captainTeamId,
        tripId: input.tripId,
        occurredAt: input.occurredAt.toISOString(),
      },
    });
  }

  /** Shared fire-engine, parameterised by trigger kind. */
  private async fireForTrigger(
    tx: Prisma.TransactionClient,
    tenantId: string,
    input: {
      captainId: string;
      captainTeamId: string | null;
      recipientUserId: string;
      actorUserId: string | null;
      triggerKind: string;
      /** Defaults to triggerKind for activation/first_trip parity. */
      bonusType?: string;
      eventPayload: Record<string, unknown>;
    },
  ): Promise<{ created: number; skipped: number }> {
    const bonusType = input.bonusType ?? input.triggerKind;
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
        bonusType,
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
            triggerKind: input.triggerKind,
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
          triggerKind: input.triggerKind,
          amount: rule.amount,
          status: 'pending',
          payload: input.eventPayload as Prisma.InputJsonValue,
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
          triggerKind: input.triggerKind,
        },
      });

      if (this.notifications) {
        await this.notifications.createInTx(tx, tenantId, {
          recipientUserId: input.recipientUserId,
          kind: 'bonus.accrued',
          title: `Bonus earned: ${accrual.amount.toString()}`,
          body: `${input.triggerKind} bonus pending payout.`,
          payload: {
            accrualId: accrual.id,
            bonusRuleId: rule.id,
            captainId: input.captainId,
            triggerKind: input.triggerKind,
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
