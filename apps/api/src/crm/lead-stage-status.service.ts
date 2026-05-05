import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { ScopeContextService, type ScopeUserClaims } from '../rbac/scope-context.service';
import { requireTenantId } from '../tenants/tenant-context';

import {
  AllowedStatusesSchema,
  parseAllowedStatusesJson,
  type AllowedStatusEntry,
} from './lead-stage-status.dto';

/**
 * Phase D3 — D3.3: per-(lead × stage) status service.
 *
 * Three responsibilities, each one a tight method:
 *
 *   • `getAllowedStatusesForStage` — read the stage's `allowedStatuses`
 *     JSON, validate, return the typed list (or [] when the stage has
 *     no catalogue). Used by the picker on the lead detail.
 *
 *   • `listForLead` — return `{ currentStatus, allowedStatuses, history }`
 *     for the lead's CURRENT stage. Hits two queries (lead + stage)
 *     plus the history fetch; cheap.
 *
 *   • `setStatus` — write a new `LeadStageStatus` row, denormalise it
 *     onto `Lead.currentStageStatusId`, append a `LeadActivity` of
 *     type `stage_status_changed`. All in one tx.
 *
 * Capability + scope:
 *   The controller layer checks `lead.stage.status.write` via
 *   `@RequireCapability` + `CapabilityGuard`. THIS service additionally
 *   re-validates lead visibility through `ScopeContextService` — same
 *   pattern as `LeadsService.findByIdInScopeOrThrow` — so an agent
 *   who can't see the lead can't write a status to it either.
 *
 * Visibility on history rows:
 *   The history list returns every status row for the lead, including
 *   author. Sales agents holding only `lead.stage.status.write` (no
 *   `lead.write`) DO see author names today — stage-status authorship
 *   is operational context, NOT the "previous owner identity" the D2.6
 *   gate protects. The forward TODO (`lead.previous_owner.read` /
 *   `lead.previousAttemptOwner` field permission, see D3 plan §8) will
 *   harmonise both surfaces under one capability.
 */
@Injectable()
export class LeadStageStatusService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly scopeContext?: ScopeContextService,
  ) {}

  /**
   * Validate + parse a stage's `allowedStatuses` JSONB. Empty array
   * for unconfigured / NULL / malformed (caller surfaces a hint when
   * the array is empty). Pure read-only DB call.
   */
  async getAllowedStatusesForStage(stageId: string): Promise<AllowedStatusEntry[]> {
    const tenantId = requireTenantId();
    const stage = await this.prisma.withTenant(tenantId, (tx) =>
      tx.pipelineStage.findUnique({
        where: { id: stageId },
        select: { allowedStatuses: true },
      }),
    );
    if (!stage) return [];
    const parsed = parseAllowedStatusesJson(stage.allowedStatuses);
    if (!parsed.ok) return [];
    return parsed.statuses;
  }

  /**
   * Read the lead's current stage status surface for the picker.
   *
   *   {
   *     currentStatus:  the `Lead.currentStageStatusId` row joined to
   *                     its label entry (or null when the agent hasn't
   *                     picked a status yet on the current stage).
   *     allowedStatuses: the stage's catalogue (always an array; empty
   *                     array when nothing is configured — UI shows
   *                     the "no statuses configured" hint).
   *     history:        every status row for THIS lead (across stages
   *                     and attempts), newest first.
   *   }
   *
   * Lead visibility is enforced before any read. Out-of-scope leads
   * surface as `lead.not_found` (same contract as the rest of the
   * lead-detail surface).
   */
  async listForLead(leadId: string, userClaims: ScopeUserClaims) {
    const tenantId = requireTenantId();
    const lead = await this.findVisibleLeadOrThrow(leadId, userClaims);

    return this.prisma.withTenant(tenantId, async (tx) => {
      const stage = await tx.pipelineStage.findUnique({
        where: { id: lead.stageId },
        select: { id: true, code: true, name: true, allowedStatuses: true },
      });
      if (!stage) {
        // Should never happen — `Lead.stageId` is FK-restricted. If it
        // does, fail loud rather than serve stale UI.
        throw new NotFoundException({
          code: 'pipeline.stage.not_found',
          message: `Stage ${lead.stageId} not found for lead ${leadId}`,
        });
      }
      const parsed = parseAllowedStatusesJson(stage.allowedStatuses);
      const allowedStatuses = parsed.ok ? parsed.statuses : [];

      const history = await tx.leadStageStatus.findMany({
        where: { tenantId, leadId },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          stageId: true,
          status: true,
          attemptIndex: true,
          notes: true,
          createdAt: true,
          setBy: { select: { id: true, name: true } },
          stage: { select: { id: true, code: true, name: true } },
        },
      });

      const currentStatus = lead.currentStageStatusId
        ? (history.find((h) => h.id === lead.currentStageStatusId) ?? null)
        : null;

      return {
        leadId,
        stage: { id: stage.id, code: stage.code, name: stage.name },
        currentStatus,
        allowedStatuses,
        history,
      };
    });
  }

  /**
   * Record a stage status against the lead's CURRENT stage.
   *
   * Validates:
   *   - Lead visible to caller (404 otherwise).
   *   - `status` is one of the stage's `allowedStatuses[].code` (rejects
   *     with `lead.stage.status.invalid` otherwise; "no statuses
   *     configured" is rejected with the same code so the UI error
   *     copy stays single-track).
   *
   * Side-effects (one tx):
   *   - Insert `LeadStageStatus` row carrying the lead's current
   *     `attemptIndex`, the stage id, the actor, and optional notes.
   *   - Update `Lead.currentStageStatusId` → new row id.
   *   - Append `LeadActivity { type: 'stage_status_changed' }`.
   *
   * Returns the new row + the lead's previous status (for the activity
   * payload + the response envelope).
   */
  async setStatus(
    leadId: string,
    input: { status: string; notes?: string },
    actorUserId: string,
    userClaims: ScopeUserClaims,
  ) {
    const tenantId = requireTenantId();
    const lead = await this.findVisibleLeadOrThrow(leadId, userClaims);

    return this.prisma.withTenant(tenantId, async (tx) => {
      const stage = await tx.pipelineStage.findUnique({
        where: { id: lead.stageId },
        select: { id: true, code: true, allowedStatuses: true },
      });
      if (!stage) {
        throw new NotFoundException({
          code: 'pipeline.stage.not_found',
          message: `Stage ${lead.stageId} not found for lead ${leadId}`,
        });
      }
      const parsed = parseAllowedStatusesJson(stage.allowedStatuses);
      if (!parsed.ok) {
        throw new BadRequestException({
          code: 'lead.stage.status.invalid',
          message: `Stage "${stage.code}" has a malformed allowedStatuses catalogue: ${parsed.error}`,
        });
      }
      const match = parsed.statuses.find((s) => s.code === input.status);
      if (!match) {
        throw new BadRequestException({
          code: 'lead.stage.status.invalid',
          message: `Status "${input.status}" is not configured on stage "${stage.code}"`,
        });
      }

      // Capture the previous status for the activity payload + the
      // response envelope. NULL when this is the first status set on
      // the lead's current stage.
      const previous = lead.currentStageStatusId
        ? await tx.leadStageStatus.findUnique({
            where: { id: lead.currentStageStatusId },
            select: { id: true, status: true, stageId: true },
          })
        : null;
      const fromStatus = previous && previous.stageId === lead.stageId ? previous.status : null;

      const created = await tx.leadStageStatus.create({
        data: {
          tenantId,
          leadId,
          stageId: lead.stageId,
          status: match.code,
          attemptIndex: lead.attemptIndex,
          setByUserId: actorUserId,
          notes: input.notes ?? null,
        },
        select: {
          id: true,
          stageId: true,
          status: true,
          attemptIndex: true,
          notes: true,
          createdAt: true,
          setBy: { select: { id: true, name: true } },
        },
      });

      await tx.lead.update({
        where: { id: leadId },
        data: { currentStageStatusId: created.id },
      });

      await tx.leadActivity.create({
        data: {
          tenantId,
          leadId,
          type: 'stage_status_changed',
          actionSource: 'lead',
          body: `Stage status: ${match.label}${input.notes ? ` — ${input.notes.slice(0, 80)}` : ''}`,
          payload: {
            event: 'stage_status_changed',
            fromStatus,
            toStatus: match.code,
            stageId: lead.stageId,
            attemptIndex: lead.attemptIndex,
            ...(input.notes && { notes: input.notes }),
          } as Prisma.InputJsonValue,
          createdById: actorUserId,
        },
      });

      return {
        leadId,
        previousStatus: fromStatus,
        currentStatus: created,
      };
    });
  }

  /**
   * Lookup the lead under the caller's scope. Same 404 semantics as
   * `LeadsService.findByIdInScopeOrThrow` — never differentiate
   * "doesn't exist" from "out of your scope" so callers can't probe
   * existence across role boundaries.
   *
   * Returns the minimal subset the service needs: stage id (to drive
   * allowed-status validation) + attemptIndex (snapshotted onto the
   * new row) + currentStageStatusId (for diff payload).
   */
  private async findVisibleLeadOrThrow(leadId: string, userClaims: ScopeUserClaims) {
    const tenantId = requireTenantId();
    const scopeWhere =
      this.scopeContext != null
        ? (await this.scopeContext.resolveLeadScope(userClaims)).where
        : null;
    const lead = await this.prisma.withTenant(tenantId, (tx) => {
      const where: Prisma.LeadWhereInput = scopeWhere
        ? { AND: [{ id: leadId }, scopeWhere] }
        : { id: leadId };
      return tx.lead.findFirst({
        where,
        select: {
          id: true,
          stageId: true,
          attemptIndex: true,
          currentStageStatusId: true,
        },
      });
    });
    if (!lead) {
      throw new NotFoundException({ code: 'lead.not_found', message: `Lead not found: ${leadId}` });
    }
    return lead;
  }
}

/**
 * Strict-mode utility: reuse the Zod schema's `.parse` from the DTO
 * file instead of duplicating it here. Re-exported so other modules
 * (e.g. an admin Pipeline-Builder service later) can validate
 * incoming `allowedStatuses` JSON without depending on the service.
 */
export { AllowedStatusesSchema };
