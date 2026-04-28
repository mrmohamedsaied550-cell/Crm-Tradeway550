import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { requireTenantId } from '../tenants/tenant-context';
import { CONVERTED_STAGE_CODE } from './pipeline.registry';
import { PipelineService } from './pipeline.service';
import { LeadsService } from './leads.service';
import type { ConvertLeadDto } from './leads.dto';

/**
 * Captain conversion + read access.
 *
 * `convertFromLead` is the canonical Lead → Captain transition:
 *   1. Validate the lead exists and has no Captain yet.
 *   2. In a single transaction:
 *      a. Create the Captain row.
 *      b. Move the lead to the `converted` (terminal) stage.
 *      c. Append a `system` activity describing the conversion.
 *
 * The whole flow runs inside `prisma.withTenant(...)` so RLS catches any
 * cross-tenant attempt as a side-effect of the SET LOCAL GUC.
 */
@Injectable()
export class CaptainsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pipeline: PipelineService,
    private readonly leads: LeadsService,
  ) {}

  findByLeadId(leadId: string) {
    return this.prisma.withTenant(requireTenantId(), (tx) =>
      tx.captain.findUnique({ where: { leadId } }),
    );
  }

  async convertFromLead(leadId: string, dto: ConvertLeadDto, actorUserId: string) {
    const tenantId = requireTenantId();

    const lead = await this.leads.findByIdOrThrow(leadId);
    if (lead.captain) {
      throw new ConflictException({
        code: 'captain.already_exists',
        message: `Lead ${leadId} has already been converted to a captain`,
      });
    }

    const convertedStage = await this.pipeline.findByCodeOrThrow(CONVERTED_STAGE_CODE);

    try {
      return await this.prisma.withTenant(tenantId, async (tx) => {
        const captain = await tx.captain.create({
          data: {
            tenantId,
            leadId,
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
            documents: {
              hasIdCard: captain.hasIdCard,
              hasLicense: captain.hasLicense,
              hasVehicleRegistration: captain.hasVehicleRegistration,
            },
          },
          createdById: actorUserId,
        });

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
}
