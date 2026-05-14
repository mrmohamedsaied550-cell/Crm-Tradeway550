import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { requireTenantId } from '../tenants/tenant-context';

import { CaptainsService } from './captains.service';
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
  private readonly logger = new Logger(LeadTransitionRequestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly leads: LeadsService,
    private readonly stageStatus: LeadStageStatusService,
    /** Sprint 3.1 — reused by the approval engine when the picked
     *  status' rule sets `convertToCaptain: true`. The existing
     *  convert-from-lead path is the canonical Lead → Captain
     *  transition: it creates the Captain row, moves the lead to
     *  the converted stage, pauses SLA, flips lifecycleState to
     *  'won', and writes the activity rows in one tx. */
    private readonly captains: CaptainsService,
    private readonly audit: AuditService,
    /** Sprint 9 (D9) — best-effort notification emission. @Optional
     *  so existing test fixtures that hand-build this service stay
     *  green; production wiring (CrmModule) supplies it. Failures
     *  are logged + swallowed — a notification outage MUST NOT
     *  break the approval flow. */
    @Optional() private readonly notifications?: NotificationsService,
  ) {}

  /**
   * Sprint 9 (D9) — wrap a notification emission so it can never
   * abort the calling write. The notification service already
   * swallows internal failures in its `create()` wrapper; this
   * extra guard catches any synchronous error in the input shape
   * itself.
   */
  private async safeNotify(args: {
    recipientUserId?: string | null;
    recipientTeamId?: string | null;
    kind: string;
    title: string;
    body?: string | null;
    severity?: 'info' | 'success' | 'warning' | 'danger' | null;
    actionUrl?: string | null;
    payload?: Prisma.InputJsonValue;
  }): Promise<void> {
    if (!this.notifications) return;
    if (!args.recipientUserId && !args.recipientTeamId) return;
    try {
      await this.notifications.create(args);
    } catch (err) {
      this.logger.warn(`transition-request notification skipped: ${(err as Error).message}`);
    }
  }

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

      // Sprint 9 (D9) — notify the approver audience.
      //
      // Resolution strategy (intentionally conservative):
      //   1. If the request carries a `handoffTargetUserId` (specific
      //      owner handoff), notify that user directly.
      //   2. Otherwise look up the lead's assignee's team and notify
      //      the team — every TL on that team sees it in their inbox.
      //   3. role:* approverKinds (e.g. role:ops_manager) currently
      //      have no targeted notification — they fall through to
      //      audit-only. A future sprint can add a "by-role" recipient.
      const assigneeTeamId = lead.assignedToId
        ? await tx.user
            .findUnique({
              where: { id: lead.assignedToId },
              select: { teamId: true },
            })
            .then((u) => u?.teamId ?? null)
        : null;
      const recipientUserId =
        handoffRule === 'specific_owner' && handoffOwnerUserId ? handoffOwnerUserId : null;
      const recipientTeamId = recipientUserId ? null : assigneeTeamId;
      // Body copy is intentionally generic — the linked Lead Detail
      // page is the permission gate for details (D5 redaction
      // already keeps sensitive fields out of the response).
      await this.safeNotify({
        recipientUserId,
        recipientTeamId,
        kind: 'transition_approval_requested',
        title: 'Transition approval requested',
        body: 'A stage transition is waiting for your decision. Open the lead for details.',
        severity: 'info',
        actionUrl: `/admin/leads/${input.leadId}`,
        payload: {
          leadId: input.leadId,
          requestId: created.id,
          approverKind,
        } as Prisma.InputJsonValue,
      });

      return created;
    });
  }

  // ─────────────────────────────────────────────────────────────
  //  List for a lead
  // ─────────────────────────────────────────────────────────────

  /**
   * Sprint 5 — list the calling user's transition requests across
   * all leads in the tenant. Powers the Sales Dashboard "Returned
   * to Me" + "Waiting Approval" queues.
   *
   *   role='requester' → rows this user submitted
   *   role='approver'  → pending rows the user is in-scope to
   *                       decide on (today: anyone with
   *                       `lead.transition.approve`; tightened in
   *                       a later sprint when team-leader signals
   *                       are formalised)
   *
   * Tenant-isolation comes for free via `withTenant`. Visibility
   * additionally enforces the lead's own scope so a sales agent
   * doesn't see transition requests on a lead they wouldn't
   * otherwise see in `/leads`.
   */
  async listForUser(
    userClaims: ScopeUserClaims,
    opts: {
      role: 'requester' | 'approver';
      state?: 'pending' | 'rejected' | 'approved' | 'cancelled';
    },
  ) {
    const tenantId = requireTenantId();
    return this.prisma.withTenant(tenantId, async (tx) => {
      const where: Prisma.LeadTransitionRequestWhereInput = {
        ...(opts.state ? { state: opts.state } : {}),
      };
      if (opts.role === 'requester') {
        where.requestedById = userClaims.userId;
      }
      // For role='approver' today we don't narrow further than the
      // capability gate at the controller — the response still
      // respects tenant isolation via RLS. A future sprint tightens
      // this to "rows whose approverKind / approverRoleCode / team
      // signal matches the caller".
      return tx.leadTransitionRequest.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: 50,
        include: {
          lead: {
            select: {
              id: true,
              name: true,
              phone: true,
              stageId: true,
              assignedToId: true,
            },
          },
          fromStage: { select: { id: true, code: true, name: true } },
          toStage: { select: { id: true, code: true, name: true } },
          requestedBy: { select: { id: true, name: true, email: true } },
          decidedBy: { select: { id: true, name: true, email: true } },
        },
      });
    });
  }

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

    // 5. Sprint 3.1 — convert to captain when the rule asked for it.
    //    Reuses the canonical CaptainsService.convertFromLead path
    //    (creates Captain row + moves lead to converted + pauses
    //    SLA + flips lifecycleState='won' + activity rows, all in
    //    one tx). Profile / timeline / audit are preserved by
    //    design — the convert path doesn't touch lead identity.
    //
    //    If the lead has already been converted (race with another
    //    approver, or the snapshot is stale), the canonical path
    //    throws ConflictException with `captain.already_exists`
    //    which surfaces to the UI as a clean 409.
    let convertedToCaptain = false;
    const snapshot = (reqRow.ruleSnapshot ?? null) as SmartStatusRule | null;
    if (snapshot?.convertToCaptain) {
      // Let the convert path's exceptions propagate as-is —
      // ConflictException with `captain.already_exists` etc.
      // surface to the UI as clean 4xx responses. The request
      // stays pending if convert throws, so the approver can
      // re-decide once the underlying issue is resolved.
      await this.captains.convertFromLead(reqRow.leadId, {}, userClaims.userId);
      convertedToCaptain = true;
    }

    // 6. Flip the row + audit.
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
          convertedToCaptain,
        } as Prisma.InputJsonValue,
      });
    });

    // Sprint 9 (D9) — notify the original requester so the dashboard
    // queue ("Waiting Approval") clears for them in real time. The
    // notification flows whether or not the captain conversion ran;
    // when it did, a second notification announces the captain.
    await this.safeNotify({
      recipientUserId: reqRow.requestedById,
      kind: 'transition_approved',
      title: 'Transition approved',
      body: 'Your stage transition was approved.',
      severity: 'success',
      actionUrl: `/admin/leads/${reqRow.leadId}`,
      payload: {
        leadId: reqRow.leadId,
        requestId,
      } as Prisma.InputJsonValue,
    });
    if (convertedToCaptain) {
      await this.safeNotify({
        recipientUserId: reqRow.requestedById,
        kind: 'lead_converted_to_captain',
        title: 'Lead converted to Captain',
        body: 'Approval triggered captain conversion. Open the lead for the final timeline.',
        severity: 'success',
        actionUrl: `/admin/leads/${reqRow.leadId}`,
        payload: {
          leadId: reqRow.leadId,
          requestId,
        } as Prisma.InputJsonValue,
      });
    }
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

    // Sprint 9 (D9) — twin notifications for the rejection path:
    //   (a) The "you got rejected" alert lands the requester back
    //       into the Returned-to-Me queue.
    //   (b) The "corrective action" alert lands on the corrective
    //       follow-up's assignee (which today is the requester) so
    //       they know what to do next.
    // We intentionally send both — they target the same user today
    // but the corrective-action one carries a different severity
    // and could target a different user once handoff-on-reject
    // ships in a later sprint.
    await this.safeNotify({
      recipientUserId: reqRow.requestedById,
      kind: 'transition_rejected',
      title: 'Transition rejected',
      body: 'Your stage transition was rejected. Open the lead for details.',
      severity: 'warning',
      actionUrl: `/admin/leads?queue=returnedToMe`,
      payload: {
        leadId: reqRow.leadId,
        requestId,
      } as Prisma.InputJsonValue,
    });
    await this.safeNotify({
      recipientUserId: reqRow.requestedById,
      kind: 'corrective_next_action_created',
      title: 'Corrective next action assigned',
      body: 'A corrective follow-up was added to this lead. Resolve it before re-requesting.',
      severity: 'warning',
      actionUrl: `/admin/leads/${reqRow.leadId}`,
      payload: {
        leadId: reqRow.leadId,
        requestId,
      } as Prisma.InputJsonValue,
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
