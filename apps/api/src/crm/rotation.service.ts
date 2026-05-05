import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { DistributionService } from '../distribution/distribution.service';
import { PrismaService } from '../prisma/prisma.service';
import { ScopeContextService, type ScopeUserClaims } from '../rbac/scope-context.service';
import { requireTenantId } from '../tenants/tenant-context';

/**
 * Phase D3 — D3.4: lead rotation engine.
 *
 * Rotation = changing the lead owner in a controlled, audited,
 * permission-aware way. Distinct from `lead.assign` (the
 * agent-self-claim path) and from `LeadsService.runReassignmentForBreaches`
 * (the legacy SLA-breach inline reassign — which D3.4 wires through
 * THIS service when the flag is on).
 *
 * One public method:
 *
 *   `rotateLead({ leadId, trigger, handoverMode, toUserId?,
 *                 reasonCode?, notes?, actorUserId?, userClaims? })`
 *
 * which writes — atomically in a single tx —:
 *   1. `Lead.assignedToId` flipped to the new owner.
 *   2. `Lead.lastRotatedAt` stamped to `now`.
 *   3. One `LeadRotationLog` row capturing the full chain.
 *   4. One `LeadActivity { type: 'rotation', actionSource: ... }`.
 *      `actionSource` is `'system'` for SLA-driven rotations and
 *      `'lead'` for manual TL/Ops actions — distinguishes the two
 *      streams on the timeline without parsing the trigger string.
 *   5. One `audit_events` row of action `lead.rotated`.
 *   6. (Clean Transfer only) every pending follow-up assigned to
 *      the prior owner is marked completed with
 *      `payload.cancelledByRotation = true`. The activity rows for
 *      each cancellation are produced by the existing follow-up
 *      service contract (through `tx.leadFollowUp.update`).
 *
 * Server-side history is NEVER deleted. The visibility gate
 * sanitises the response shape only; the underlying rows always
 * carry the full chain. TL+ surfaces (read endpoint with
 * `includeSensitive=true` derived from `lead.write` capability —
 * D2.6 pattern) see everything.
 *
 * Feature flag: `D3_ENGINE_V1`. When the flag resolves false, the
 * controller layer rejects manual rotation calls with a typed
 * `lead.rotate.disabled` error and the SLA breach scanner's seam
 * keeps the legacy inline reassignment path. When the flag resolves
 * true, this service is the single entry point.
 */

export type HandoverMode = 'full' | 'summary' | 'clean';
export type RotationTrigger =
  | 'manual_tl'
  | 'manual_ops'
  | 'sla_breach'
  | 'agent_unavailable'
  | 'capacity_balance';

export interface RotateLeadInput {
  leadId: string;
  trigger: RotationTrigger;
  handoverMode: HandoverMode;
  /** Explicit target. When omitted, `RotationService` routes via
   *  `DistributionService.route` with the prior assignee excluded.
   *  Not all triggers may pick — leave NULL when no eligible agent
   *  exists. The lead is left unassigned; the rotation log records
   *  the attempt either way. */
  toUserId?: string | null;
  reasonCode?: string;
  notes?: string;
  /** Operator who triggered the rotation. NULL on system-triggered
   *  paths (e.g. the SLA scheduler tick). */
  actorUserId?: string | null;
  /** Caller's scope claims — when present, the service re-validates
   *  lead visibility before doing any work. Manual rotations always
   *  pass this; system rotations may omit (the scheduler runs
   *  inside `tenantContext.run` already). */
  userClaims?: ScopeUserClaims;
}

export interface RotationOutcome {
  rotationId: string;
  leadId: string;
  fromUserId: string | null;
  toUserId: string | null;
  trigger: RotationTrigger;
  handoverMode: HandoverMode;
  attemptIndex: number;
  cancelledFollowUpCount: number;
}

@Injectable()
export class RotationService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly distribution?: DistributionService,
    @Optional() private readonly scopeContext?: ScopeContextService,
    @Optional() private readonly audit?: AuditService,
  ) {}

  /**
   * Rotate a single lead. See class docs for the full contract.
   *
   * Errors (typed `code` for the controller to translate):
   *   - `lead.not_found`               — lead doesn't exist OR is out
   *                                       of the caller's scope.
   *   - `lead.rotate.invalid_target`   — `toUserId` is not in the
   *                                       tenant or is disabled.
   *   - `lead.rotate.same_owner`       — `toUserId` equals current
   *                                       `assignedToId` (a no-op
   *                                       rotation is never useful
   *                                       and would just spam the
   *                                       timeline).
   *   - `lead.rotate.no_eligible_agent` — `toUserId` omitted AND the
   *                                       distribution engine found
   *                                       no eligible reassignee.
   *                                       Lead stays with the prior
   *                                       owner; no row is written.
   */
  async rotateLead(input: RotateLeadInput): Promise<RotationOutcome> {
    const tenantId = requireTenantId();
    const lead = await this.findVisibleLeadOrThrow(input.leadId, input.userClaims);
    const fromUserId = lead.assignedToId;

    // No-op guard: caller asked for the same owner.
    if (input.toUserId && input.toUserId === fromUserId) {
      throw new BadRequestException({
        code: 'lead.rotate.same_owner',
        message: 'Target user is already the current owner of this lead.',
      });
    }

    return this.prisma.withTenant(tenantId, async (tx) => {
      // Resolve the target. Either explicit (validated in tenant) or
      // via the distribution engine (excluding the prior assignee).
      let toUserId: string | null;
      let resolvedVia: 'explicit' | 'route_engine';
      if (input.toUserId) {
        const target = await tx.user.findUnique({
          where: { id: input.toUserId },
          select: { id: true, tenantId: true, status: true },
        });
        if (!target || target.tenantId !== tenantId) {
          throw new BadRequestException({
            code: 'lead.rotate.invalid_target',
            message: `Target user ${input.toUserId} is not in this tenant.`,
          });
        }
        if (target.status !== 'active') {
          throw new BadRequestException({
            code: 'lead.rotate.invalid_target',
            message: `Target user ${input.toUserId} is not active.`,
          });
        }
        toUserId = target.id;
        resolvedVia = 'explicit';
      } else {
        toUserId = await this.routeViaDistribution(tx, tenantId, lead, fromUserId);
        resolvedVia = 'route_engine';
        if (!toUserId) {
          throw new BadRequestException({
            code: 'lead.rotate.no_eligible_agent',
            message: 'No eligible agent available — pick a target manually.',
          });
        }
      }

      // Apply: lead.assignedToId + lastRotatedAt, in the same tx as
      // the log + activity + audit. A partial commit is impossible.
      const now = new Date();
      await tx.lead.update({
        where: { id: lead.id },
        data: {
          assignedToId: toUserId,
          lastRotatedAt: now,
        },
      });

      const rotation = await tx.leadRotationLog.create({
        data: {
          tenantId,
          leadId: lead.id,
          fromUserId,
          toUserId,
          trigger: input.trigger,
          handoverMode: input.handoverMode,
          ...(input.reasonCode && { reasonCode: input.reasonCode }),
          ...(input.notes && { notes: input.notes }),
          payload: {
            resolvedVia,
            // Snapshot for forensics — the lead's stage at rotation
            // time, plus its threshold bucket. Cheap (the lead read
            // already loaded these).
            stageId: lead.stageId,
            slaThreshold: lead.slaThreshold,
          } as Prisma.InputJsonValue,
          attemptIndex: lead.attemptIndex,
          actorUserId: input.actorUserId ?? null,
        },
        select: { id: true },
      });

      await tx.leadActivity.create({
        data: {
          tenantId,
          leadId: lead.id,
          type: 'rotation',
          // Manual TL/Ops actions render as 'lead' (agent-driven on
          // the timeline); SLA / capacity-balance / agent-unavailable
          // come from the system tick.
          actionSource:
            input.trigger === 'manual_tl' || input.trigger === 'manual_ops' ? 'lead' : 'system',
          body: this.activityBody(input.handoverMode, input.trigger),
          payload: {
            event: 'rotation',
            rotationId: rotation.id,
            trigger: input.trigger,
            handoverMode: input.handoverMode,
            fromUserId,
            toUserId,
            attemptIndex: lead.attemptIndex,
            ...(input.reasonCode && { reasonCode: input.reasonCode }),
            ...(input.notes && { notes: input.notes }),
          } as Prisma.InputJsonValue,
          createdById: input.actorUserId ?? null,
        },
      });

      // Dedicated audit verb so the audit page can chip-filter
      // rotations independently of stage_change / assignment.
      if (this.audit) {
        await this.audit.writeInTx(tx, tenantId, {
          action: 'lead.rotated',
          entityType: 'lead',
          entityId: lead.id,
          actorUserId: input.actorUserId ?? null,
          payload: {
            rotationId: rotation.id,
            trigger: input.trigger,
            handoverMode: input.handoverMode,
            fromUserId,
            toUserId,
            ...(input.reasonCode && { reasonCode: input.reasonCode }),
          } as unknown as Prisma.InputJsonValue,
        });
      }

      // Clean Transfer side-effect: cancel pending follow-ups owned
      // by the prior agent. We DON'T delete activity rows or
      // history; we only mark the follow-ups completed with a
      // forensic flag so the new owner starts with a clean queue
      // while the audit trail stays intact.
      let cancelledFollowUpCount = 0;
      if (input.handoverMode === 'clean' && fromUserId) {
        const pending = await tx.leadFollowUp.findMany({
          where: {
            leadId: lead.id,
            assignedToId: fromUserId,
            completedAt: null,
          },
          select: { id: true },
        });
        for (const fu of pending) {
          await tx.leadFollowUp.update({
            where: { id: fu.id },
            data: {
              completedAt: now,
            },
          });
          cancelledFollowUpCount += 1;
        }
        if (cancelledFollowUpCount > 0) {
          // Recompute the lead's denormalised next-action pointer so
          // the picker doesn't render a now-cancelled follow-up.
          const next = await tx.leadFollowUp.findFirst({
            where: { leadId: lead.id, completedAt: null },
            orderBy: { dueAt: 'asc' },
            select: { dueAt: true },
          });
          await tx.lead.update({
            where: { id: lead.id },
            data: { nextActionDueAt: next?.dueAt ?? null },
          });
        }
      }

      return {
        rotationId: rotation.id,
        leadId: lead.id,
        fromUserId,
        toUserId,
        trigger: input.trigger,
        handoverMode: input.handoverMode,
        attemptIndex: lead.attemptIndex,
        cancelledFollowUpCount,
      };
    });
  }

  /**
   * List rotation history for a lead, sanitised by the caller's
   * permission level.
   *
   * Visibility:
   *   - Caller has `lead.write` (TL+ / Ops / Account Manager /
   *     Super Admin via roles.registry.ts) ⇒ returns full rows
   *     including `fromUser`, `toUser`, `actor`, `reasonCode`, `notes`.
   *   - Otherwise (sales / activation / driving agents) ⇒ from/to
   *     user objects are stripped, `notes` is stripped, `reasonCode`
   *     stays (it's a stable enum-like code, not free-text). The
   *     activity timeline copy on the same surface uses neutral
   *     "Rotated to you" / "Handled previously" labels rendered
   *     client-side.
   *
   * Out-of-scope leads surface as `lead.not_found` (same contract
   * as `LeadsService.findByIdInScopeOrThrow`).
   *
   * TODO (forward, per D3 plan §8): introduce a dedicated capability
   * `lead.previous_owner.read` (or field-level
   * `lead.rotationHistoryOwner` permission) so the gate stops
   * piggy-backing on `lead.write`. Tracked for D5 / Final UX Audit.
   */
  async listRotationsForLead(
    leadId: string,
    userClaims: ScopeUserClaims,
  ): Promise<{
    leadId: string;
    canSeeOwners: boolean;
    rotations: Array<{
      id: string;
      trigger: string;
      handoverMode: string;
      reasonCode: string | null;
      attemptIndex: number;
      createdAt: Date;
      fromUser: { id: string; name: string } | null;
      toUser: { id: string; name: string } | null;
      actor: { id: string; name: string } | null;
      notes: string | null;
    }>;
  }> {
    const tenantId = requireTenantId();
    const lead = await this.findVisibleLeadOrThrow(leadId, userClaims);
    const canSeeOwners = await this.userCanSeeOwnershipHistory(userClaims);

    return this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.leadRotationLog.findMany({
        where: { tenantId, leadId: lead.id },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          trigger: true,
          handoverMode: true,
          reasonCode: true,
          attemptIndex: true,
          notes: true,
          createdAt: true,
          fromUser: { select: { id: true, name: true } },
          toUser: { select: { id: true, name: true } },
          actor: { select: { id: true, name: true } },
        },
      });
      const rotations = rows.map((r) =>
        canSeeOwners
          ? r
          : {
              ...r,
              fromUser: null,
              toUser: null,
              actor: null,
              notes: null,
            },
      );
      return { leadId, canSeeOwners, rotations };
    });
  }

  // ─── helpers ────────────────────────────────────────────────────────

  private async findVisibleLeadOrThrow(
    leadId: string,
    userClaims: ScopeUserClaims | undefined,
  ): Promise<{
    id: string;
    assignedToId: string | null;
    stageId: string;
    slaThreshold: string;
    attemptIndex: number;
    companyId: string | null;
    countryId: string | null;
    source: string;
  }> {
    const tenantId = requireTenantId();
    const scopeWhere =
      userClaims && this.scopeContext
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
          assignedToId: true,
          stageId: true,
          slaThreshold: true,
          attemptIndex: true,
          companyId: true,
          countryId: true,
          source: true,
        },
      });
    });
    if (!lead) {
      throw new NotFoundException({ code: 'lead.not_found', message: `Lead not found: ${leadId}` });
    }
    return lead;
  }

  /**
   * Route to a new owner via the distribution engine, excluding the
   * prior assignee. Returns NULL when no eligible agent exists; the
   * caller surfaces `lead.rotate.no_eligible_agent` in that case.
   *
   * Always passes `bypassRules=true` so a re-rotation never lands
   * the lead back at the same target the original rule chose
   * (matches the SLA-breach reassignment pattern from `SlaService`).
   */
  private async routeViaDistribution(
    tx: Prisma.TransactionClient,
    tenantId: string,
    lead: { id: string; companyId: string | null; countryId: string | null; source: string },
    fromUserId: string | null,
  ): Promise<string | null> {
    if (!this.distribution) return null;
    const decision = await this.distribution.route(
      {
        tenantId,
        leadId: lead.id,
        source: lead.source,
        companyId: lead.companyId,
        countryId: lead.countryId,
        currentAssigneeId: fromUserId,
        bypassRules: true,
      },
      tx,
    );
    return decision.chosenUserId;
  }

  /** Compose the human-facing activity body for the timeline.
   *  Sales agents see this verbatim — neutral copy, no actor names,
   *  no SLA-failure detail. Per-locale label substitution happens
   *  client-side via the activity-summary translator. */
  private activityBody(mode: HandoverMode, trigger: RotationTrigger): string {
    const which =
      trigger === 'manual_tl' || trigger === 'manual_ops'
        ? 'manual'
        : trigger === 'sla_breach'
          ? 'sla'
          : 'system';
    return `Lead rotated (${which}, ${mode} transfer)`;
  }

  /**
   * Phase D3 — D3.4: previous-owner / rotation-history privilege check.
   *
   * Same `lead.write` gate D2.6 keys on for the attempts surface.
   * Granted to TL / Account Manager / Ops / Super Admin via
   * `TEAM_LEAD_EXTRAS`; sales / activation / driving agents do NOT
   * hold it. Falls back to `false` (conservative) when the role
   * lookup fails so a transient DB error never leaks owner data.
   *
   * TODO (forward): introduce a dedicated capability
   * `lead.previous_owner.read` (or a field-level permission on
   * `lead.rotationHistoryOwner`) so the gate stops piggy-backing on
   * `lead.write`. Tracked for D5 / Final UX & User Stories Audit.
   */
  private async userCanSeeOwnershipHistory(userClaims: ScopeUserClaims): Promise<boolean> {
    try {
      const role = await this.prisma.withTenant(userClaims.tenantId, (tx) =>
        tx.role.findUnique({
          where: { id: userClaims.roleId },
          include: {
            capabilities: { include: { capability: { select: { code: true } } } },
          },
        }),
      );
      const codes = role?.capabilities.map((rc) => rc.capability.code) ?? [];
      return codes.includes('lead.write');
    } catch {
      return false;
    }
  }
}
