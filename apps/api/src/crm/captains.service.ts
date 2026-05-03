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
          await tx.lead.update({
            where: { id: leadId },
            data: { stageId: convertedStage.id, slaDueAt: null, slaStatus: 'paused' },
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
