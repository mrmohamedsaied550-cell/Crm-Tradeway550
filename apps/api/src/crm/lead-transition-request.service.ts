import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { requireTenantId } from '../tenants/tenant-context';

import {
  parseAllowedStatusesJson,
  type AllowedStatusEntry,
  type SmartStatusRule,
} from './lead-stage-status.dto';
import { LeadsService } from './leads.service';
import { LeadStageStatusService } from './lead-stage-status.service';
import type { ScopeUserClaims } from '../rbac/scope-context.service';

/**
 * Sprint 3 (D7.1) — Stage-transition approval engine.
 *
 *   1. `request(...)` — agent submits a request from the Add
 *      Action → Lifecycle drawer.
 *   2. `listForLead(...)` — scope-filtered history of requests
 *      for a single lead.
 *   3. `approve(...)` — approver applies the requested move +
 *      status + handoff in sequence, then flips the row to
 *      `approved`.
 *   4. `reject(...)` — approver rejects with a required reason,
 *      creates a corrective follow-up so the original owner
 *      sees a concrete next action.
 *   5. `cancel(...)` — requester withdraws before a decision.
 *
 * Capability gates live at the controller (@RequireCapability).
 * The service trusts the controller for capability presence and
 * additionally enforces scope-correctness when a request's
 * `approverKind` names a role-coded approver.
 *
 * Atomicity note: each side-effect (moveStage, setStageStatus,
 * handoff, row update) uses its own tx. The approve flow is
 * sequential and best-effort — same pattern as the existing
 * Move Stage → Lost flow (LostReasonModal calls moveStage,
 * then the reason capture). If a later step fails after an
 * earlier one succeeded, the operator can re-decide / cancel
 * the (now still-pending) request. A future sprint can wrap
 * everything in one tx if needed.
 */
@Injectable()
export class LeadTransitionRequestService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly leads: LeadsService,
    private readonly stageStatus: LeadStageStatusService,
    private readonly audit: AuditService,
  ) {}

  // ─────────────────────────────────────────────────────────────
  //  Create
  // ─────────────────────────────────────────────────────────────

  async request(
    input: {
      leadId: string;
      toStageId: string;
      requestedStatusCode?: string | null;
      communicationMethod?: string | null;
      notes?: string | null;
      reasonCode?: string | null;
      reasonText?: string | null;
    },
    userClaims: ScopeUserClaims,
  ): Promise<{ id: string }> {
    const tenantId = requireTenantId();

    // 1. Visibility gate.
    const lead = await this.leads.findByIdInScopeOrThrow(input.leadId, userClaims);

    return this.prisma.withTenant(tenantId, async (tx) => {
      // 2. Target stage + its allowed statuses.
      const toStage = await tx.pipelineStage.findFirst({
        where: { id: input.toStageId },
        select: {
          id: true,
          code: true,
          name: true,
          pipelineId: true,
          isTerminal: true,
          terminalKind: true,
          allowedStatuses: true,
        },
      });
      if (!toStage) {
        throw new NotFoundException({
          code: 'pipeline.stage.not_found',
          message: 'Target stage not found',
        });
      }
      if (lead.pipelineId && toStage.pipelineId !== lead.pipelineId) {
        throw new BadRequestException({
          code: 'pipeline.stage.cross_pipeline',
          message: 'Target stage belongs to a different pipeline',
        });
      }

      // 3. Resolve the picked status + its smart rule.
      let ruleSnapshot: AllowedStatusEntry | null = null;
      if (input.requestedStatusCode) {
        const parsed = parseAllowedStatusesJson(toStage.allowedStatuses);
        if (!parsed.ok) {
          throw new BadRequestException({
            code: 'lead.stage.status.invalid_catalogue',
            message: parsed.error,
          });
        }
        const match = parsed.statuses.find((s) => s.code === input.requestedStatusCode);
        if (!match) {
          throw new BadRequestException({
            code: 'lead.stage.status.invalid',
            message: `Status "${input.requestedStatusCode}" not in target stage's allowedStatuses`,
          });
        }
        ruleSnapshot = match;
      }

      // 4. Resolve approver + handoff snapshot.
      const rule: SmartStatusRule = ruleSnapshot ?? {};
      const isCrossStage = lead.stageId !== toStage.id;
      const approverKind =
        rule.approver ?? (isCrossStage ? 'target_team_leader' : 'current_team_leader');
      const approverRoleCode = approverKind.startsWith('role:')
        ? approverKind.slice('role:'.length)
        : null;
      const handoffRule = rule.handoffRule ?? null;
      const handoffOwnerUserId = rule.handoffOwnerUserId ?? null;

      // 5. Required-reason enforcement.
      if (rule.requiresReason && !input.reasonCode && !input.reasonText) {
        throw new BadRequestException({
          code: 'lead.transition.reason_required',
          message: `Status "${input.requestedStatusCode}" requires a reason`,
        });
      }

      // 6. One-pending-per-lead pre-check.
      const existingPending = await tx.leadTransitionRequest.findFirst({
        where: { leadId: input.leadId, state: 'pending' },
        select: { id: true },
      });
      if (existingPending) {
        throw new BadRequestException({
          code: 'lead.transition.already_pending',
          message: 'A pending transition request already exists for this lead',
        });
      }

      // 7. Insert + audit.
      const created = await tx.leadTransitionRequest.create({
        data: {
          tenantId,
          leadId: input.leadId,
          fromStageId: lead.stageId,
          toStageId: toStage.id,
          requestedStatusCode: input.requestedStatusCode ?? null,
          ruleSnapshot: ruleSnapshot
            ? (ruleSnapshot as unknown as Prisma.InputJsonValue)
            : Prisma.JsonNull,
          communicationMethod: input.communicationMethod ?? null,
          notes: input.notes ?? null,
          reasonCode: input.reasonCode ?? null,
          reasonText: input.reasonText ?? null,
          requestedById: userClaims.userId,
          approverKind,
          approverRoleCode,
          handoffRule,
          handoffTargetUserId:
            handoffRule === 'specific_owner' && handoffOwnerUserId ? handoffOwnerUserId : null,
          handoffTargetTeamId: null,
          state: 'pending',
        },
        select: { id: true },
      });

      await this.audit.writeInTx(tx, tenantId, {
        action: 'lead.transition.requested',
        entityType: 'lead',
        entityId: input.leadId,
        actorUserId: userClaims.userId,
        payload: {
          requestId: created.id,
          fromStageId: lead.stageId,
          toStageId: toStage.id,
          requestedStatusCode: input.requestedStatusCode ?? null,
          approverKind,
          handoffRule,
        } as Prisma.InputJsonValue,
      });

      return created;
    });
  }

  // ─────────────────────────────────────────────────────────────
  //  List for a lead
  // ─────────────────────────────────────────────────────────────

  async listForLead(leadId: string, userClaims: ScopeUserClaims) {
    await this.leads.findByIdInScopeOrThrow(leadId, userClaims);
    const tenantId = requireTenantId();
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.leadTransitionRequest.findMany({
        where: { leadId },
        orderBy: { createdAt: 'desc' },
        include: {
          fromStage: { select: { id: true, code: true, name: true } },
          toStage: {
            select: { id: true, code: true, name: true, isTerminal: true, terminalKind: true },
          },
          requestedBy: { select: { id: true, name: true, email: true } },
          decidedBy: { select: { id: true, name: true, email: true } },
          handoffTargetUser: { select: { id: true, name: true, email: true } },
          handoffTargetTeam: { select: { id: true, name: true } },
        },
      }),
    );
  }

  // ─────────────────────────────────────────────────────────────
  //  Approve
  // ─────────────────────────────────────────────────────────────

  async approve(
    requestId: string,
    input: { notes?: string | null },
    userClaims: ScopeUserClaims,
  ): Promise<void> {
    const tenantId = requireTenantId();

    // 1. Load + scope-check (in its own tx).
    const reqRow = await this.prisma.withTenant(tenantId, (tx) =>
      this.loadPendingOrThrow(tx, requestId),
    );
    await this.assertRoleApprover(reqRow, userClaims);

    const isCrossStage = reqRow.fromStageId !== reqRow.toStageId;

    // 2. Move stage (cross-stage only). Reuses LeadsService.moveStage.
    if (isCrossStage) {
      if (reqRow.toStage.terminalKind === 'lost' && !reqRow.reasonCode && !reqRow.reasonText) {
        throw new BadRequestException({
          code: 'lead.transition.lost_reason_required',
          message: 'Approving a transition to a lost stage requires a captured reason',
        });
      }
      await this.leads.moveStage(
        reqRow.leadId,
        {
          pipelineStageId: reqRow.toStageId,
          ...(reqRow.toStage.terminalKind === 'lost' &&
          reqRow.reasonCode &&
          /^[0-9a-f-]{36}$/.test(reqRow.reasonCode)
            ? { lostReasonId: reqRow.reasonCode }
            : {}),
        },
        userClaims.userId,
        userClaims,
      );
    }

    // 3. Set stage status (when specified).
    if (reqRow.requestedStatusCode) {
      await this.stageStatus.setStatus(
        reqRow.leadId,
        { status: reqRow.requestedStatusCode, notes: reqRow.notes ?? undefined },
        userClaims.userId,
        userClaims,
      );
    }

    // 4. Handoff (best-effort).
    await this.applyHandoff(reqRow);

    // 5. Flip the row + audit.
    await this.prisma.withTenant(tenantId, async (tx) => {
      await tx.leadTransitionRequest.update({
        where: { id: requestId },
        data: {
          state: 'approved',
          decidedAt: new Date(),
          decidedById: userClaims.userId,
          decisionReason: input.notes ?? null,
        },
      });
      await this.audit.writeInTx(tx, tenantId, {
        action: 'lead.transition.approved',
        entityType: 'lead',
        entityId: reqRow.leadId,
        actorUserId: userClaims.userId,
        payload: {
          requestId,
          fromStageId: reqRow.fromStageId,
          toStageId: reqRow.toStageId,
          requestedStatusCode: reqRow.requestedStatusCode ?? null,
          handoffRule: reqRow.handoffRule ?? null,
        } as Prisma.InputJsonValue,
      });
    });
  }

  // ─────────────────────────────────────────────────────────────
  //  Reject
  // ─────────────────────────────────────────────────────────────

  async reject(
    requestId: string,
    input: {
      reason: string;
      correctiveActionTitle?: string | null;
      correctiveDueAt?: string | null;
    },
    userClaims: ScopeUserClaims,
  ): Promise<void> {
    if (!input.reason || input.reason.trim().length === 0) {
      throw new BadRequestException({
        code: 'lead.transition.rejection_reason_required',
        message: 'Rejection reason is required',
      });
    }
    const tenantId = requireTenantId();

    const reqRow = await this.prisma.withTenant(tenantId, (tx) =>
      this.loadPendingOrThrow(tx, requestId),
    );
    await this.assertRoleApprover(reqRow, userClaims);

    await this.prisma.withTenant(tenantId, async (tx) => {
      const dueAt = input.correctiveDueAt
        ? new Date(input.correctiveDueAt)
        : new Date(Date.now() + 24 * 60 * 60 * 1000);
      const correctiveFollowup = await tx.leadFollowUp.create({
        data: {
          tenantId,
          leadId: reqRow.leadId,
          assignedToId: reqRow.requestedById,
          createdById: userClaims.userId,
          actionType: 'other',
          dueAt,
          note:
            input.correctiveActionTitle ?? `Resolve before re-requesting: ${input.reason.trim()}`,
        },
        select: { id: true },
      });

      // Refresh the lead's soonest-pending denorm.
      const nextDue = await tx.leadFollowUp.findFirst({
        where: { leadId: reqRow.leadId, completedAt: null },
        orderBy: { dueAt: 'asc' },
        select: { dueAt: true },
      });
      await tx.lead.update({
        where: { id: reqRow.leadId },
        data: { nextActionDueAt: nextDue?.dueAt ?? null },
      });

      await tx.leadTransitionRequest.update({
        where: { id: requestId },
        data: {
          state: 'rejected',
          decidedAt: new Date(),
          decidedById: userClaims.userId,
          decisionReason: input.reason.trim(),
          correctiveFollowupId: correctiveFollowup.id,
        },
      });

      await this.audit.writeInTx(tx, tenantId, {
        action: 'lead.transition.rejected',
        entityType: 'lead',
        entityId: reqRow.leadId,
        actorUserId: userClaims.userId,
        payload: {
          requestId,
          fromStageId: reqRow.fromStageId,
          toStageId: reqRow.toStageId,
          rejectionReason: input.reason.trim(),
          correctiveFollowupId: correctiveFollowup.id,
        } as Prisma.InputJsonValue,
      });
    });
  }

  // ─────────────────────────────────────────────────────────────
  //  Cancel
  // ─────────────────────────────────────────────────────────────

  async cancel(requestId: string, userClaims: ScopeUserClaims): Promise<void> {
    const tenantId = requireTenantId();
    await this.prisma.withTenant(tenantId, async (tx) => {
      const reqRow = await this.loadPendingOrThrow(tx, requestId);
      if (reqRow.requestedById !== userClaims.userId) {
        throw new ForbiddenException({
          code: 'lead.transition.cancel_forbidden',
          message: 'Only the requester can cancel their own transition request',
        });
      }
      await tx.leadTransitionRequest.update({
        where: { id: requestId },
        data: {
          state: 'cancelled',
          decidedAt: new Date(),
          decidedById: userClaims.userId,
        },
      });
      await this.audit.writeInTx(tx, tenantId, {
        action: 'lead.transition.cancelled',
        entityType: 'lead',
        entityId: reqRow.leadId,
        actorUserId: userClaims.userId,
        payload: { requestId } as Prisma.InputJsonValue,
      });
    });
  }

  // ─────────────────────────────────────────────────────────────
  //  Internals
  // ─────────────────────────────────────────────────────────────

  private async loadPendingOrThrow(tx: Prisma.TransactionClient, id: string) {
    const row = await tx.leadTransitionRequest.findFirst({
      where: { id },
      include: {
        toStage: { select: { id: true, terminalKind: true } },
      },
    });
    if (!row) {
      throw new NotFoundException({
        code: 'lead.transition.not_found',
        message: 'Transition request not found',
      });
    }
    if (row.state !== 'pending') {
      throw new BadRequestException({
        code: 'lead.transition.not_pending',
        message: `Transition request is ${row.state}, not pending`,
      });
    }
    return row;
  }

  /**
   * Decision-side authorization beyond the capability gate. For
   * role-coded approvers (`approverKind: 'role:<code>'`), require
   * the decider to hold that exact role. Other approverKinds rely
   * solely on the `lead.transition.approve` capability check at
   * the controller — a follow-up sprint can tighten team-leader
   * variants once the org's TL signal is decided.
   */
  private async assertRoleApprover(
    reqRow: { approverKind: string; approverRoleCode: string | null },
    userClaims: ScopeUserClaims,
  ): Promise<void> {
    if (!reqRow.approverKind.startsWith('role:') || !reqRow.approverRoleCode) return;
    const tenantId = requireTenantId();
    const user = await this.prisma.withTenant(tenantId, (tx) =>
      tx.user.findFirst({
        where: { id: userClaims.userId },
        select: { role: { select: { code: true } } },
      }),
    );
    if (user?.role?.code !== reqRow.approverRoleCode) {
      throw new ForbiddenException({
        code: 'lead.transition.decide_role_mismatch',
        message: `This request must be decided by a user with role "${reqRow.approverRoleCode}"`,
      });
    }
  }

  /**
   * Post-approval handoff. Applies `Lead.assignedToId` based on
   * the snapshotted handoff rule. Today's variants:
   *   - specific_owner   → assignedToId := handoffTargetUserId
   *   - target_team_queue→ assignedToId := null (lead unowned;
   *                         falls into scope-based team visibility)
   *   - target_team_leader / auto_rotation → returns BadRequest
   *                         with a clear gap message (an
   *                         org-level resolver lands in a later
   *                         sprint). The move + status changes
   *                         have already landed by this point,
   *                         so the operator sees a partial
   *                         success.
   */
  private async applyHandoff(reqRow: {
    leadId: string;
    handoffRule: string | null;
    handoffTargetUserId: string | null;
  }): Promise<void> {
    if (!reqRow.handoffRule) return;
    const tenantId = requireTenantId();
    if (reqRow.handoffRule === 'specific_owner' && reqRow.handoffTargetUserId) {
      await this.prisma.withTenant(tenantId, (tx) =>
        tx.lead.update({
          where: { id: reqRow.leadId },
          data: { assignedToId: reqRow.handoffTargetUserId },
        }),
      );
      return;
    }
    if (reqRow.handoffRule === 'target_team_queue') {
      await this.prisma.withTenant(tenantId, (tx) =>
        tx.lead.update({
          where: { id: reqRow.leadId },
          data: { assignedToId: null },
        }),
      );
      return;
    }
    throw new BadRequestException({
      code: 'lead.transition.handoff_not_implemented',
      message: `Handoff rule "${reqRow.handoffRule}" not yet wired — a later sprint adds the org-level resolver. Configure handoffRule="specific_owner" or "target_team_queue" today.`,
    });
  }
}
