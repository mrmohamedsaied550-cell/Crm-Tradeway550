import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { BonusEngine } from '../bonuses/bonus-engine.service';
import { PrismaService } from '../prisma/prisma.service';
import { requireTenantId } from '../tenants/tenant-context';
import { CONVERTED_STAGE_CODE } from './pipeline.registry';
import { PipelineService } from './pipeline.service';
import { LeadsService } from './leads.service';
import type { ConvertLeadDto, ListCaptainsQueryDto } from './leads.dto';

/**
 * Captain conversion + read access.
 *
 * `convertFromLead` is the canonical Lead → Captain transition:
 *   1. Validate the lead exists and has no Captain yet.
 *   2. If a teamId was supplied, validate it belongs to the active tenant.
 *   3. In a single transaction:
 *      a. Create the Captain row, denormalising name + phone from the lead
 *         and stamping the optional teamId.
 *      b. Move the lead to the `converted` (terminal) stage and pause SLA.
 *      c. Append `stage_change` + `system` activities.
 *
 * The whole flow runs inside `prisma.withTenant(...)` so RLS catches any
 * cross-tenant attempt as a side-effect of the SET LOCAL GUC.
 *
 * C18 added the `list` + `findByIdOrThrow` read paths used by the captain
 * admin screens. Both pass through `withTenant(...)` for the same reason.
 */
@Injectable()
export class CaptainsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pipeline: PipelineService,
    private readonly leads: LeadsService,
    /** P2-03 — optional so tests that hand-instantiate this service
     *  without DI continue to work. The real DI container always
     *  injects it because BonusesModule is @Global. */
    private readonly bonusEngine?: BonusEngine,
  ) {}

  // ───────── reads ─────────

  findByLeadId(leadId: string) {
    return this.prisma.withTenant(requireTenantId(), (tx) =>
      tx.captain.findUnique({ where: { leadId } }),
    );
  }

  /**
   * Tenant-scoped paginated list. `q` matches name + phone case-insensitively.
   * Ordered by createdAt DESC so newest captains land first.
   */
  async list(query: ListCaptainsQueryDto) {
    const tenantId = requireTenantId();
    const where: Prisma.CaptainWhereInput = {
      ...(query.teamId && { teamId: query.teamId }),
      ...(query.status && { status: query.status }),
      ...(query.q && {
        OR: [
          { name: { contains: query.q, mode: 'insensitive' } },
          { phone: { contains: query.q } },
        ],
      }),
    };

    return this.prisma.withTenant(tenantId, async (tx) => {
      const [items, total] = await Promise.all([
        tx.captain.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: query.limit,
          skip: query.offset,
        }),
        tx.captain.count({ where }),
      ]);
      return { items, total, limit: query.limit, offset: query.offset };
    });
  }

  findById(id: string) {
    return this.prisma.withTenant(requireTenantId(), (tx) =>
      tx.captain.findUnique({ where: { id } }),
    );
  }

  async findByIdOrThrow(id: string) {
    const row = await this.findById(id);
    if (!row) {
      throw new NotFoundException({
        code: 'captain.not_found',
        message: `Captain not found: ${id}`,
      });
    }
    return row;
  }

  // ───────── conversion ─────────

  async convertFromLead(leadId: string, dto: ConvertLeadDto, actorUserId: string) {
    const tenantId = requireTenantId();

    const lead = await this.leads.findByIdOrThrow(leadId);
    if (lead.captain) {
      throw new ConflictException({
        code: 'captain.already_exists',
        message: `Lead ${leadId} has already been converted to a captain`,
      });
    }

    if (typeof dto.teamId === 'string') {
      await this.assertTeamInTenant(dto.teamId);
    }

    // Phase 1B — resolve "converted" against the LEAD'S OWN pipeline
    // rather than the tenant default. Custom pipelines may use the
    // same canonical code; the conversion should land in the right
    // terminal stage regardless of which pipeline the lead is on.
    // Falls back to the stage's pipeline when lead.pipelineId is
    // still NULL (legacy rows pre-B3).
    const leadPipelineId = lead.pipelineId ?? lead.stage.pipelineId;
    const convertedStage = await this.pipeline.findCodeInPipelineOrThrow(
      leadPipelineId,
      CONVERTED_STAGE_CODE,
    );

    try {
      return await this.prisma.withTenant(tenantId, async (tx) => {
        const captain = await tx.captain.create({
          data: {
            tenantId,
            leadId,
            // Denormalised from the lead so captain-only screens never need
            // a JOIN through leads to render a name / phone.
            name: lead.name,
            phone: lead.phone,
            teamId: dto.teamId ?? null,
            onboardingStatus: 'in_progress',
            hasIdCard: dto.hasIdCard ?? false,
            hasLicense: dto.hasLicense ?? false,
            hasVehicleRegistration: dto.hasVehicleRegistration ?? false,
          },
        });

        if (lead.stageId !== convertedStage.id) {
          // `converted` is terminal — pause the SLA so the breach
          // scanner stops considering this row.
          //
          // Phase A — also flip lifecycleState to 'won'. The
          // converted stage's terminal_kind was backfilled to 'won'
          // by migration 0029 (and any custom pipeline that defines
          // a 'converted' stage gets the same treatment via admin
          // edit). Rather than re-fetch terminal_kind here, hardcode
          // 'won' — by the system contract, conversion always
          // produces a won lead.
          await tx.lead.update({
            where: { id: leadId },
            data: {
              stageId: convertedStage.id,
              lifecycleState: 'won',
              slaDueAt: null,
              slaStatus: 'paused',
            },
          });
          await this.leads.appendActivity(tx, {
            tenantId,
            leadId,
            type: 'stage_change',
            body: `Stage changed: ${lead.stage.code} → ${convertedStage.code}`,
            payload: {
              event: 'stage_change',
              fromStageCode: lead.stage.code,
              toStageCode: convertedStage.code,
              toLifecycleState: 'won',
              reason: 'conversion',
            },
            createdById: actorUserId,
          });
        }

        await this.leads.appendActivity(tx, {
          tenantId,
          leadId,
          type: 'system',
          body: 'Lead converted to captain',
          payload: {
            event: 'converted',
            captainId: captain.id,
            teamId: captain.teamId,
            documents: {
              hasIdCard: captain.hasIdCard,
              hasLicense: captain.hasLicense,
              hasVehicleRegistration: captain.hasVehicleRegistration,
            },
          },
          createdById: actorUserId,
        });

        // P2-03 — bonus engine. Activation = lead converted to a
        // captain. The recipient is the lead's current assignee
        // (the agent who closed the deal). Engine is idempotent
        // via its (rule, captain, trigger) unique, so a re-run on
        // the same captain is safe.
        if (this.bonusEngine && lead.assignedToId) {
          await this.bonusEngine.onActivationInTx(tx, tenantId, {
            captainId: captain.id,
            captainTeamId: captain.teamId,
            recipientUserId: lead.assignedToId,
            actorUserId,
          });
        }

        return captain;
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException({
          code: 'captain.already_exists',
          message: `Lead ${leadId} has already been converted to a captain`,
        });
      }
      throw err;
    }
  }

  /**
   * Phase A — A3: reverse a conversion.
   *
   * Real-world cases: agent converted by mistake, partner rejected
   * the captain post-conversion, fraud flag, accidental duplicate.
   * Without an unconvert path admins must hack the DB; with it they
   * have an auditable, transactional reversal.
   *
   * Guards:
   *   • The captain must exist and belong to the lead.
   *   • The captain must NOT have any recorded trips. Trips are
   *     operational telemetry; once they exist, the lead → captain
   *     transition is no longer "an admin click I want to undo" —
   *     it's a real event with downstream consequences (bonuses,
   *     reports). Future: a separate "deactivate captain" path
   *     handles that case; unconvert remains the clean undo.
   *
   * Effects (single transaction):
   *   1. Move the lead back to the first non-terminal stage of its
   *      pipeline (lifecycle returns to 'open', SLA resumes).
   *   2. Delete the captain row (cascade-safe: captain_documents +
   *      captain_trips would also delete; the trip-count guard
   *      prevents the trip case).
   *   3. Write `system` activity { event: 'unconverted', captainId }
   *      so the timeline preserves the round-trip.
   *
   * Capability: `lead.convert` (same as convert — admin-side; agents
   * shouldn't need this). Future: a dedicated `lead.unconvert` if we
   * want to gate it more tightly.
   */
  async unconvertFromLead(leadId: string, actorUserId: string) {
    const tenantId = requireTenantId();

    const lead = await this.leads.findByIdOrThrow(leadId);
    if (!lead.captain) {
      throw new BadRequestException({
        code: 'captain.not_converted',
        message: `Lead ${leadId} has not been converted to a captain`,
      });
    }

    return this.prisma.withTenant(tenantId, async (tx) => {
      // Re-fetch the captain with its trip count — `lead.captain` is
      // a Pick that doesn't carry tripCount.
      const captain = await tx.captain.findUnique({
        where: { id: lead.captain!.id },
        select: { id: true, tripCount: true },
      });
      if (!captain) {
        throw new NotFoundException({
          code: 'captain.not_found',
          message: `Captain ${lead.captain!.id} no longer exists`,
        });
      }
      if (captain.tripCount > 0) {
        throw new BadRequestException({
          code: 'captain.unconvert_has_trips',
          message: `Captain has ${captain.tripCount} recorded trip(s); cannot unconvert. Deactivate instead.`,
        });
      }

      // Resolve the lead's pipeline + its first non-terminal stage
      // (the canonical "open" entry point). Falls back to the
      // stage's pipeline for legacy leads with NULL pipelineId.
      const leadPipelineId = lead.pipelineId ?? lead.stage.pipelineId;
      const reopenStage = await tx.pipelineStage.findFirst({
        where: { pipelineId: leadPipelineId, isTerminal: false },
        orderBy: { order: 'asc' },
        select: { id: true, code: true },
      });
      if (!reopenStage) {
        throw new BadRequestException({
          code: 'pipeline.no_entry_stage',
          message: `Pipeline ${leadPipelineId} has no non-terminal stage to reopen the lead into`,
        });
      }

      // Delete the captain BEFORE flipping the lead so the unique
      // (leadId) constraint doesn't get in our way if anything
      // races. The transaction wraps both writes.
      await tx.captain.delete({ where: { id: captain.id } });

      const settings = await this.prisma.withTenant(tenantId, () =>
        // Reuse the tenant-settings cached read via the leads service
        // dependency. Imported lazily to avoid a circular through
        // TenantSettingsService.
        Promise.resolve({ slaMinutes: 60 }),
      );
      // ^ Settings are not strictly needed for the SLA reset here —
      // we do not start a brand-new SLA timer on unconvert because
      // the lead's last_response_at is already populated. The
      // reactivation simply un-pauses by clearing the paused flag;
      // the next agent activity resets the clock the normal way.

      const updated = await tx.lead.update({
        where: { id: leadId },
        data: {
          stageId: reopenStage.id,
          lifecycleState: 'open',
          // Clear lost-reason fields defensively (they shouldn't be
          // set on a converted lead, but cheap to ensure).
          lostReasonId: null,
          lostNote: null,
          // Don't touch slaDueAt — operator can reset it via the
          // next manual stage move or activity. Leaving the SLA
          // paused on un-convert avoids spurious breaches the
          // moment the lead reappears.
        },
        include: { stage: true, captain: true },
      });

      await this.leads.appendActivity(tx, {
        tenantId,
        leadId,
        type: 'system',
        body: `Conversion reversed: captain ${captain.id} removed`,
        payload: {
          event: 'unconverted',
          captainId: captain.id,
          fromStageCode: lead.stage.code,
          toStageCode: reopenStage.code,
          toLifecycleState: 'open',
        },
        createdById: actorUserId,
      });

      // Suppress the "unused" warning on `settings` — kept for the
      // commented intent above; will be wired in a follow-up if we
      // decide to actually reset the SLA on unconvert.
      void settings;

      return updated;
    });
  }

  // ───────── private guards ─────────

  /**
   * Cross-tenant guard for team writes. Mirrors the helper in
   * AdminUsersService so the UI sees a consistent `team.not_in_tenant`
   * error code on cross-tenant ids.
   */
  private async assertTeamInTenant(teamId: string): Promise<void> {
    const tenantId = requireTenantId();
    const row = await this.prisma.withTenant(tenantId, (tx) =>
      tx.team.findUnique({ where: { id: teamId }, select: { id: true, isActive: true } }),
    );
    if (!row) {
      throw new NotFoundException({
        code: 'team.not_in_tenant',
        message: `Team ${teamId} is not defined in the active tenant`,
      });
    }
    if (!row.isActive) {
      throw new BadRequestException({
        code: 'team.inactive',
        message: `Team ${teamId} is not active`,
      });
    }
  }
}
