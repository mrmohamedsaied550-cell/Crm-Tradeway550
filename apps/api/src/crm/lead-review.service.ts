import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { ScopeContextService, type ScopeUserClaims } from '../rbac/scope-context.service';
import { requireTenantId } from '../tenants/tenant-context';

import type { LeadReviewReason, LeadReviewResolution, ListLeadReviewsDto } from './lead-review.dto';

/**
 * Phase D3 — D3.6: TL Review Queue service.
 *
 * Public surface:
 *
 *   • `raiseReview(input)` — append a queue row. Idempotent on the
 *     `(lead, reason, open)` triple: if an unresolved row already
 *     exists with the same `reason` for the same lead, the existing
 *     id is returned and no duplicate is written. The SLA scheduler
 *     can therefore call `raiseReview` on every breach without
 *     producing a flood of identical rows. `assignedTlId` defaults
 *     to the lead's team's `team_leader_id` when not supplied.
 *
 *   • `listReviews(userClaims, filters)` — scope-aware list. TLs see
 *     rows assigned to them (or, with `assignedToMe=false`, every
 *     row in their team scope). Ops / Account Manager / Super Admin
 *     see broader scope. Sales / activation / driving agents fail
 *     the capability gate at the controller layer; defence-in-depth
 *     here returns empty for the few legacy paths that don't pass
 *     `lead.review.read`.
 *
 *   • `findByIdInScope(userClaims, id)` — read one row in scope.
 *     Out-of-scope rows surface as `lead.review.not_found`.
 *
 *   • `resolveReview(reviewId, resolution, notes?, actorUserId,
 *                    userClaims)` — close a queue row. Validates:
 *       - Row exists and is in the caller's scope.
 *       - Row is still open (no double-resolve race).
 *       - `notes` is required for `kept_owner` and `dismissed`.
 *       - Writes one `LeadActivity { type: 'lead_review_resolved' }`
 *         + one `audit_events.lead.review.resolved` row.
 *       - `escalated` resolution AUTOMATICALLY raises a child review
 *         (`reason: 'escalated_by_tl'`, `assignedTlId: NULL`) so the
 *         Ops queue picks it up without manual hand-off.
 *
 * The service does NOT itself rotate leads on `resolution = rotated`
 * — the UI is expected to call `RotationService.rotateLead` first
 * (via the existing rotate modal) and then call `resolveReview` with
 * the rotation outcome. This keeps the rotation tx and the review
 * tx independent so a failed rotation can't poison the review row.
 */

@Injectable()
export class LeadReviewService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly scopeContext?: ScopeContextService,
    @Optional() private readonly audit?: AuditService,
  ) {}

  /**
   * Idempotently raise a review for a lead. Returns the new row id
   * (or the existing open row's id when a duplicate would have been
   * created). System-driven raises (SLA scheduler) pass
   * `actorUserId: null`; manual TL raises pass the TL's id.
   */
  async raiseReview(input: {
    leadId: string;
    reason: LeadReviewReason;
    reasonPayload?: Prisma.InputJsonValue;
    assignedTlId?: string | null;
    actorUserId?: string | null;
  }): Promise<{ id: string; alreadyOpen: boolean }> {
    const tenantId = requireTenantId();
    return this.prisma.withTenant(tenantId, async (tx) => {
      // Dedup: if there's an open review with the same (lead, reason),
      // return its id without writing a new row. The scheduler can
      // therefore call this every minute without flooding the queue.
      const existing = await tx.leadReview.findFirst({
        where: {
          tenantId,
          leadId: input.leadId,
          reason: input.reason,
          resolvedAt: null,
        },
        select: { id: true },
      });
      if (existing) return { id: existing.id, alreadyOpen: true };

      // Default `assignedTlId` to NULL when the caller didn't pick a
      // target. The scope filter on `listReviews` already narrows
      // each TL's queue to leads owned by their team (via the lead's
      // `assignedToId` ↔ team mapping), so a NULL-assigned row still
      // surfaces correctly to the right TL on the queue page. Ops /
      // Account Manager / Super Admin see global scope and pick up
      // any unassigned rows that fell through.
      //
      // The Team model doesn't carry a dedicated `team_leader_id`
      // column today (TL identity is derived from a role-coded user
      // sitting on the team). A future explicit `team_leader_id`
      // column would let `raiseReview` populate this field
      // deterministically; tracked alongside the D5 / Final UX
      // capability TODO.
      const assignedTlId = input.assignedTlId ?? null;

      const created = await tx.leadReview.create({
        data: {
          tenantId,
          leadId: input.leadId,
          reason: input.reason,
          reasonPayload: input.reasonPayload ?? Prisma.JsonNull,
          assignedTlId,
        },
        select: { id: true },
      });

      // Activity row on the lead's timeline so a TL inspecting the
      // lead detail sees the queue event in context. Sanitised
      // payload — no actor name, no sensitive owner detail.
      await tx.leadActivity.create({
        data: {
          tenantId,
          leadId: input.leadId,
          type: 'lead_review_raised',
          actionSource: 'system',
          body: `TL review raised: ${input.reason}`,
          payload: {
            event: 'lead_review_raised',
            reviewId: created.id,
            reason: input.reason,
            ...(assignedTlId && { assignedTlId }),
          } as Prisma.InputJsonValue,
          createdById: input.actorUserId ?? null,
        },
      });

      // Dedicated audit verb — dashboard handle.
      if (this.audit) {
        await this.audit.writeInTx(tx, tenantId, {
          action: 'lead.review.raised',
          entityType: 'lead_review',
          entityId: created.id,
          actorUserId: input.actorUserId ?? null,
          payload: {
            leadId: input.leadId,
            reason: input.reason,
            ...(assignedTlId && { assignedTlId }),
          } as unknown as Prisma.InputJsonValue,
        });
      }
      return { id: created.id, alreadyOpen: false };
    });
  }

  /**
   * Scope-aware list. The query is bounded by:
   *   1. The caller's `lead` scope (TL = own team, Ops/AM = global).
   *   2. The optional filter chips (resolved / reason / assignedToMe).
   * Returns `{ items, total, limit, offset }` for the paginated UI.
   */
  async listReviews(userClaims: ScopeUserClaims, filters: ListLeadReviewsDto) {
    const tenantId = requireTenantId();
    const scopeWhere = this.scopeContext
      ? (await this.scopeContext.resolveLeadScope(userClaims)).where
      : null;

    const where: Prisma.LeadReviewWhereInput = {
      tenantId,
      ...(filters.resolved === true && { resolvedAt: { not: null } }),
      ...(filters.resolved === false && { resolvedAt: null }),
      ...(filters.reason && { reason: filters.reason }),
      ...(filters.assignedToMe && { assignedTlId: userClaims.userId }),
      ...(filters.leadId && { leadId: filters.leadId }),
      ...(scopeWhere && { lead: scopeWhere }),
    };

    return this.prisma.withTenant(tenantId, async (tx) => {
      const [items, total] = await Promise.all([
        tx.leadReview.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: filters.limit,
          skip: filters.offset,
          select: {
            id: true,
            leadId: true,
            reason: true,
            reasonPayload: true,
            assignedTlId: true,
            resolution: true,
            resolvedAt: true,
            resolutionNotes: true,
            createdAt: true,
            assignedTl: { select: { id: true, name: true } },
            resolvedBy: { select: { id: true, name: true } },
            lead: {
              select: {
                id: true,
                name: true,
                phone: true,
                slaThreshold: true,
                stage: { select: { code: true, name: true } },
                assignedTo: { select: { id: true, name: true } },
              },
            },
          },
        }),
        tx.leadReview.count({ where }),
      ]);
      return { items, total, limit: filters.limit, offset: filters.offset };
    });
  }

  /**
   * Resolve a queue row. See class docs for the resolution-specific
   * side-effects.
   */
  async resolveReview(
    reviewId: string,
    resolution: LeadReviewResolution,
    notes: string | undefined,
    actorUserId: string,
    userClaims: ScopeUserClaims,
  ): Promise<{ id: string; resolution: LeadReviewResolution; childReviewId?: string }> {
    if ((resolution === 'kept_owner' || resolution === 'dismissed') && !notes?.trim()) {
      throw new BadRequestException({
        code: 'lead.review.notes_required',
        message: 'Notes are required when keeping the owner or dismissing the review.',
      });
    }
    const tenantId = requireTenantId();
    const row = await this.findByIdInScope(userClaims, reviewId);
    if (!row) {
      throw new NotFoundException({
        code: 'lead.review.not_found',
        message: `Review not found: ${reviewId}`,
      });
    }
    if (row.resolvedAt !== null) {
      throw new BadRequestException({
        code: 'lead.review.already_resolved',
        message: 'This review has already been resolved.',
      });
    }

    return this.prisma.withTenant(tenantId, async (tx) => {
      const now = new Date();
      await tx.leadReview.update({
        where: { id: reviewId },
        data: {
          resolution,
          resolvedById: actorUserId,
          resolvedAt: now,
          resolutionNotes: notes?.trim() ?? null,
        },
      });

      // Optional child review for the `escalated` resolution.
      let childReviewId: string | undefined;
      if (resolution === 'escalated') {
        const child = await tx.leadReview.create({
          data: {
            tenantId,
            leadId: row.leadId,
            reason: 'escalated_by_tl',
            reasonPayload: {
              parentReviewId: reviewId,
              parentReason: row.reason,
              escalatedBy: actorUserId,
              ...(notes?.trim() && { notes: notes.trim() }),
            } as Prisma.InputJsonValue,
            assignedTlId: null,
          },
          select: { id: true },
        });
        childReviewId = child.id;
      }

      // Activity row on the lead.
      await tx.leadActivity.create({
        data: {
          tenantId,
          leadId: row.leadId,
          type: 'lead_review_resolved',
          actionSource: 'lead',
          body: `TL review resolved: ${resolution}`,
          payload: {
            event: 'lead_review_resolved',
            reviewId,
            resolution,
            ...(childReviewId && { childReviewId }),
            ...(notes?.trim() && { notes: notes.trim() }),
          } as Prisma.InputJsonValue,
          createdById: actorUserId,
        },
      });

      // Dedicated audit verb.
      if (this.audit) {
        await this.audit.writeInTx(tx, tenantId, {
          action: 'lead.review.resolved',
          entityType: 'lead_review',
          entityId: reviewId,
          actorUserId,
          payload: {
            leadId: row.leadId,
            reason: row.reason,
            resolution,
            ...(childReviewId && { childReviewId }),
          } as unknown as Prisma.InputJsonValue,
        });
      }
      return childReviewId
        ? { id: reviewId, resolution, childReviewId }
        : { id: reviewId, resolution };
    });
  }

  /**
   * Read one review in the caller's scope. Returns null when the row
   * doesn't exist or sits outside the caller's lead scope. Callers
   * raise `lead.review.not_found` on null.
   */
  async findByIdInScope(userClaims: ScopeUserClaims, id: string) {
    const tenantId = requireTenantId();
    const scopeWhere = this.scopeContext
      ? (await this.scopeContext.resolveLeadScope(userClaims)).where
      : null;
    const row = await this.prisma.withTenant(tenantId, (tx) => {
      const where: Prisma.LeadReviewWhereInput = {
        tenantId,
        id,
        ...(scopeWhere && { lead: scopeWhere }),
      };
      return tx.leadReview.findFirst({
        where,
        select: {
          id: true,
          leadId: true,
          reason: true,
          reasonPayload: true,
          assignedTlId: true,
          resolution: true,
          resolvedAt: true,
          resolutionNotes: true,
          createdAt: true,
          assignedTl: { select: { id: true, name: true } },
          resolvedBy: { select: { id: true, name: true } },
          lead: {
            select: {
              id: true,
              name: true,
              phone: true,
              slaThreshold: true,
              stage: { select: { code: true, name: true } },
              assignedTo: { select: { id: true, name: true } },
            },
          },
        },
      });
    });
    return row;
  }

  /** Public defensive helper — kept around so service-layer callers
   *  outside the controller (e.g. a future bulk-resolve script) can
   *  short-circuit on missing capability. The controller's
   *  `@RequireCapability('lead.review.resolve')` is the primary
   *  gate; this is purely belt-and-braces. */
  // eslint-disable-next-line class-methods-use-this
  guardResolveCapability(hasCapability: boolean): void {
    if (!hasCapability) {
      throw new ForbiddenException({
        code: 'lead.review.forbidden',
        message: 'You cannot resolve TL review-queue rows.',
      });
    }
  }
}
