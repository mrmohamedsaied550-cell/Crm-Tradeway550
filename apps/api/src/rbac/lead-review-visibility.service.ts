import { Injectable } from '@nestjs/common';

import { FieldFilterService } from './field-filter.service';
import type { ScopeUserClaims } from './scope-context.service';

/**
 * Phase D5 — D5.8: TL Review Queue field-level visibility resolver.
 *
 * Three response surfaces consume this service:
 *
 *   • `LeadReviewService.listReviews` — list with chips.
 *   • `LeadReviewService.findByIdInScope` — single-row read.
 *   • Future TL queue endpoints (e.g. count-by-reason aggregations).
 *
 * The `FieldRedactionInterceptor` (D5.3) already strips top-level
 * keys from `lead.review` responses based on flat catalogue paths
 * (`assignedTl`, `resolutionNotes`, `reasonPayload`). D5.8 extends
 * this with NESTED redaction inside the `reasonPayload` JSON blob:
 *
 *   • `lead.review.ownerContext` deny → strip `priorAssigneeId` /
 *     `escalatedBy` keys from `reasonPayload`. These keys leak the
 *     identity of agents involved in the lead's history (the
 *     escalation actor + the prior assignee at SLA breach time).
 *
 *   • `lead.review.partnerContext` deny → strip `partnerSourceId`
 *     / `partnerRecordId` keys from `reasonPayload`. These keys
 *     point at the specific partner ledger row that triggered the
 *     reconciliation review and should be hidden from agents who
 *     don't own the partner-data surface.
 *
 * The interceptor cannot do this because its dot-path matcher
 * only walks declared object keys; the `reasonPayload` blob is a
 * Json column whose shape varies by raise-source and is opaque to
 * the catalogue at the role-builder layer. `LeadReviewVisibilityService`
 * is the dedicated chokepoint that knows the blob's well-known
 * keys + the gating field-permission resource (`lead.review`).
 *
 * Bypass:
 *   - Super-admin always sees everything (mirrors
 *     FieldFilterService.listDeniedReadFields).
 *
 * Defaults — preserved by D5.8's migration 0041 + seed which
 * install idempotent deny rows for `sales_agent` /
 * `activation_agent` / `driving_agent` on
 * `lead.review.ownerContext` + `lead.review.partnerContext`. The
 * agent cohort doesn't hold `lead.review.read` today (controller-
 * level guard rejects them at the route boundary), so these deny
 * rows are dormant defence-in-depth — they activate the moment
 * an admin grants the cohort review-queue access.
 */

export interface LeadReviewVisibility {
  readonly canReadAssignedTl: boolean;
  readonly canReadOwnerContext: boolean;
  readonly canReadPartnerContext: boolean;
  readonly canReadReasonPayload: boolean;
  readonly canReadResolutionNotes: boolean;
}

const ALL_LEAD_REVIEW_FIELDS_VISIBLE: LeadReviewVisibility = {
  canReadAssignedTl: true,
  canReadOwnerContext: true,
  canReadPartnerContext: true,
  canReadReasonPayload: true,
  canReadResolutionNotes: true,
};

/**
 * Well-known nested keys inside `LeadReview.reasonPayload`. The
 * lists are EXHAUSTIVE for the keys today's writers emit (see
 * `partner-reconciliation.service.ts` raiseReviewIfNeeded /
 * `sla.service.ts` raiseReview / `lead-review.service.ts`
 * resolveReview's child-row writer). Any future writer adding a
 * new owner-or-partner-identifying key MUST be added here AND
 * tested in `d5-8-visibility-tighten.test.ts`.
 */
const OWNER_CONTEXT_KEYS = ['priorAssigneeId', 'escalatedBy'] as const;
const PARTNER_CONTEXT_KEYS = ['partnerSourceId', 'partnerRecordId'] as const;

@Injectable()
export class LeadReviewVisibilityService {
  constructor(private readonly fieldFilter: FieldFilterService) {}

  /**
   * Resolve which lead-review fields the caller's role may read.
   * One DB read on `field_permissions` for resource `'lead.review'`.
   */
  async resolveLeadReviewVisibility(claims: ScopeUserClaims): Promise<LeadReviewVisibility> {
    const { bypassed, paths } = await this.fieldFilter.listDeniedReadFields(claims, 'lead.review');
    if (bypassed) return ALL_LEAD_REVIEW_FIELDS_VISIBLE;
    const denied = new Set(paths);
    return {
      canReadAssignedTl: !denied.has('assignedTl'),
      canReadOwnerContext: !denied.has('ownerContext'),
      canReadPartnerContext: !denied.has('partnerContext'),
      canReadReasonPayload: !denied.has('reasonPayload'),
      canReadResolutionNotes: !denied.has('resolutionNotes'),
    };
  }

  /**
   * Apply per-field nullification + nested-payload redaction to a
   * list of LeadReview rows. Pure CPU (no I/O). Preserves row
   * count exactly; siblings of the redacted keys remain.
   *
   * Behaviour matrix:
   *
   *   • `canReadAssignedTl=false`     ⇒ `assignedTl` + `assignedTlId`
   *                                     null on every row.
   *   • `canReadResolutionNotes=false`⇒ `resolutionNotes` null.
   *   • `canReadReasonPayload=false`  ⇒ `reasonPayload` null
   *                                     entirely (nested gates
   *                                     become moot — there's
   *                                     nothing left to walk).
   *   • `canReadReasonPayload=true` AND
   *     `canReadOwnerContext=false`   ⇒ delete the well-known
   *                                     owner-identity keys from
   *                                     `reasonPayload`.
   *   • Same for `canReadPartnerContext=false` ⇒ delete the
   *     well-known partner-identity keys.
   *
   * The function never mutates the input rows; it returns a fresh
   * array of cloned objects so callers can reuse the source rows
   * (e.g. for audit logging) without leakage.
   */
  applyVisibility<T extends LeadReviewLikeRow>(
    rows: readonly T[],
    visibility: LeadReviewVisibility,
  ): T[] {
    const fastPath =
      visibility.canReadAssignedTl &&
      visibility.canReadOwnerContext &&
      visibility.canReadPartnerContext &&
      visibility.canReadReasonPayload &&
      visibility.canReadResolutionNotes;
    if (fastPath) return [...rows];
    return rows.map((r) => this.applyVisibilityToRow(r, visibility));
  }

  applyVisibilityToRow<T extends LeadReviewLikeRow>(row: T, v: LeadReviewVisibility): T {
    const out: T = { ...row };
    if (!v.canReadAssignedTl) {
      (out as { assignedTl: unknown }).assignedTl = null;
      (out as { assignedTlId: unknown }).assignedTlId = null;
    }
    if (!v.canReadResolutionNotes) {
      (out as { resolutionNotes: unknown }).resolutionNotes = null;
    }
    if (!v.canReadReasonPayload) {
      (out as { reasonPayload: unknown }).reasonPayload = null;
      return out;
    }
    const payload = out.reasonPayload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return out;
    const newPayload: Record<string, unknown> = { ...(payload as Record<string, unknown>) };
    let changed = false;
    if (!v.canReadOwnerContext) {
      for (const key of OWNER_CONTEXT_KEYS) {
        if (key in newPayload) {
          delete newPayload[key];
          changed = true;
        }
      }
    }
    if (!v.canReadPartnerContext) {
      for (const key of PARTNER_CONTEXT_KEYS) {
        if (key in newPayload) {
          delete newPayload[key];
          changed = true;
        }
      }
    }
    if (changed) {
      (out as { reasonPayload: unknown }).reasonPayload = newPayload;
    }
    return out;
  }
}

/**
 * Structural shape every redactable LeadReview-shaped row carries.
 * The actual Prisma row is wider (lead, resolvedBy, …); the
 * redactor only touches the keys it knows about. Other keys pass
 * through untouched.
 */
export interface LeadReviewLikeRow {
  reasonPayload: unknown;
  resolutionNotes?: string | null;
  assignedTl?: { id: string; name: string } | null;
  assignedTlId?: string | null;
}

/** Re-exported for tests; production callers should use the service. */
export const LEAD_REVIEW_OWNER_CONTEXT_KEYS = OWNER_CONTEXT_KEYS;
export const LEAD_REVIEW_PARTNER_CONTEXT_KEYS = PARTNER_CONTEXT_KEYS;
