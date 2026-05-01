import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { BonusEngine } from '../bonuses/bonus-engine.service';
import { PrismaService } from '../prisma/prisma.service';
import { requireTenantId } from '../tenants/tenant-context';
import type { RecordTripDto } from './captain-trips.dto';

/**
 * P2-09 — captain trip ingest.
 *
 * Per-tenant POST `/captains/:id/trips` records one delivered trip
 * for a captain and updates the aggregates on the `captains` row:
 *   - first invocation sets `firstTripAt = occurredAt` and bumps
 *     `tripCount = 1`, then fires `BonusEngine.onFirstTripInTx`.
 *   - subsequent invocations bump `tripCount` only.
 *   - the (captain_id, trip_id) UNIQUE makes ingest idempotent: a
 *     replay of the same trip is a no-op (the create returns the
 *     existing row and we short-circuit).
 *
 * The `firstTripAt` set goes through a `WHERE first_trip_at IS NULL`
 * conditional update so a concurrent second-trip ingest can never
 * overwrite the canonical first trip with a later timestamp.
 *
 * Bonus engine wiring is OPTIONAL via the same DI pattern as
 * NotificationsService — the trip service stays usable in tests
 * that don't wire the BonusModule.
 */
@Injectable()
export class CaptainTripsService {
  private readonly logger = new Logger(CaptainTripsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Optional() private readonly bonusEngine?: BonusEngine,
  ) {}

  async listForCaptain(captainId: string) {
    const tenantId = requireTenantId();
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.captainTrip.findMany({
        where: { captainId },
        orderBy: { occurredAt: 'desc' },
        take: 100,
      }),
    );
  }

  async recordTrip(captainId: string, dto: RecordTripDto, actorUserId: string | null) {
    const tenantId = requireTenantId();
    const occurredAt = new Date(dto.occurredAt);
    if (Number.isNaN(occurredAt.getTime())) {
      throw new BadRequestException({
        code: 'captain.trip.invalid_occurred_at',
        message: `Invalid occurredAt: ${dto.occurredAt}`,
      });
    }

    return this.prisma.withTenant(tenantId, async (tx) => {
      const captain = await tx.captain.findUnique({
        where: { id: captainId },
        select: { id: true, teamId: true, leadId: true, firstTripAt: true, tripCount: true },
      });
      if (!captain) {
        throw new NotFoundException({
          code: 'captain.not_found',
          message: `Captain ${captainId} not found in active tenant`,
        });
      }

      // Idempotent insert: pre-check (captainId, tripId).
      const existing = await tx.captainTrip.findUnique({
        where: {
          captainId_tripId: { captainId, tripId: dto.tripId },
        },
        select: { id: true, occurredAt: true },
      });
      if (existing) {
        return {
          tripId: dto.tripId,
          duplicate: true as const,
          captainId,
          firstTripAt: captain.firstTripAt,
          tripCount: captain.tripCount,
        };
      }

      const tripRow = await tx.captainTrip.create({
        data: {
          tenantId,
          captainId,
          tripId: dto.tripId,
          occurredAt,
          ...(dto.payload && { payload: dto.payload as Prisma.InputJsonValue }),
        },
        select: { id: true },
      });

      // Bump tripCount; conditionally set firstTripAt only if not yet
      // set. The `updateMany` with the conditional WHERE clause is
      // the canonical "set if null" pattern in Prisma.
      const isFirst = captain.firstTripAt === null;
      if (isFirst) {
        await tx.captain.updateMany({
          where: { id: captainId, firstTripAt: null },
          data: { firstTripAt: occurredAt, tripCount: { increment: 1 } },
        });
      } else {
        await tx.captain.update({
          where: { id: captainId },
          data: { tripCount: { increment: 1 } },
        });
      }

      const updated = await tx.captain.findUniqueOrThrow({
        where: { id: captainId },
        select: { firstTripAt: true, tripCount: true, teamId: true, leadId: true },
      });

      await this.audit.writeInTx(tx, tenantId, {
        action: 'captain.trip.recorded',
        entityType: 'captain',
        entityId: captainId,
        actorUserId,
        payload: {
          tripId: dto.tripId,
          occurredAt: occurredAt.toISOString(),
          tripCount: updated.tripCount,
          isFirst,
        } as Prisma.InputJsonValue,
      });

      // Fire the first_trip bonus rules — exactly once. Idempotent
      // by the (rule, captain, triggerKind) UNIQUE in BonusAccrual,
      // so even if the WHERE-conditional updateMany above lost a
      // race we never produce a duplicate accrual.
      if (isFirst && this.bonusEngine) {
        const lead = await tx.lead.findUnique({
          where: { id: updated.leadId },
          select: { assignedToId: true },
        });
        const recipient = lead?.assignedToId;
        if (recipient) {
          await this.bonusEngine.onFirstTripInTx(tx, tenantId, {
            captainId,
            captainTeamId: updated.teamId,
            recipientUserId: recipient,
            actorUserId,
            tripId: dto.tripId,
            occurredAt,
          });
        } else {
          this.logger.warn(
            `captain.trip: first trip for captain ${captainId} but no lead.assignedToId; skipping bonus`,
          );
        }
      }

      return {
        tripId: dto.tripId,
        duplicate: false as const,
        captainId,
        firstTripAt: updated.firstTripAt,
        tripCount: updated.tripCount,
        recordId: tripRow.id,
      };
    });
  }
}
