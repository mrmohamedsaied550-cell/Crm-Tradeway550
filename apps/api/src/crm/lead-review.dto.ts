import { z } from 'zod';

/**
 * Phase D3 — D3.6: TL Review Queue DTOs.
 *
 * Reasons + resolutions live as TEXT columns at the DB level for
 * forward compatibility (new reasons / resolutions don't need a
 * migration). The Zod schemas below validate at the service /
 * controller boundary so a malformed payload never reaches the
 * persistence layer.
 */

export const LEAD_REVIEW_REASONS = [
  'sla_breach_repeat',
  'rotation_failed',
  'manual_tl_review',
  'bottleneck_flagged',
  'escalated_by_tl',
  // Phase D4 — D4.6: partner-reconciliation discrepancies promoted
  // into the TL Review Queue. The reasonPayload carries
  // `{ partnerSourceId, partnerRecordId?, category, partnerValues,
  //   crmValues }` so the resolver can see what differs without
  // chasing back to the snapshot table. Reasons here mirror the
  // five reconciliation categories computed on-read by
  // PartnerReconciliationService — categories that have no
  // matching CRM data (e.g. `partner_active_not_in_crm` when the
  // contact has no lead) cannot be promoted; the controller
  // rejects those with `partner.reconciliation.no_lead`.
  'partner_missing',
  'partner_active_not_in_crm',
  'partner_date_mismatch',
  'partner_dft_mismatch',
  'partner_trips_mismatch',
] as const;
export const LeadReviewReasonSchema = z.enum(LEAD_REVIEW_REASONS);
export type LeadReviewReason = z.infer<typeof LeadReviewReasonSchema>;

export const LEAD_REVIEW_RESOLUTIONS = ['rotated', 'kept_owner', 'escalated', 'dismissed'] as const;
export const LeadReviewResolutionSchema = z.enum(LEAD_REVIEW_RESOLUTIONS);
export type LeadReviewResolution = z.infer<typeof LeadReviewResolutionSchema>;

/** Body for `POST /lead-reviews/:id/resolve`. */
export const ResolveLeadReviewSchema = z
  .object({
    resolution: LeadReviewResolutionSchema,
    /** Required for `kept_owner` and `dismissed` (TL accountability).
     *  Optional for `rotated` (the rotation log carries the
     *  rationale) and `escalated` (the escalated-by-tl child review
     *  carries the chain). Service enforces. */
    notes: z.string().trim().max(1000).optional(),
  })
  .strict()
  .refine(
    (v) => {
      if (v.resolution === 'kept_owner' || v.resolution === 'dismissed') {
        return v.notes !== undefined && v.notes.trim().length > 0;
      }
      return true;
    },
    {
      message: 'notes are required when resolution is kept_owner or dismissed',
      path: ['notes'],
    },
  );
export type ResolveLeadReviewDto = z.infer<typeof ResolveLeadReviewSchema>;

/** Query schema for `GET /lead-reviews`. */
export const ListLeadReviewsSchema = z
  .object({
    /** `false` = unresolved (default for the queue). `true` = resolved
     *  archive. Omit to fetch both (rare; the UI tabs always pin one). */
    resolved: z.coerce.boolean().optional(),
    /** Optional reason chip filter. */
    reason: LeadReviewReasonSchema.optional(),
    /** Optional "assigned to me" filter for the TL's own queue tab. */
    assignedToMe: z.coerce.boolean().optional(),
    /** Optional lead filter for the lead-detail history surface. */
    leadId: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();
export type ListLeadReviewsDto = z.infer<typeof ListLeadReviewsSchema>;
