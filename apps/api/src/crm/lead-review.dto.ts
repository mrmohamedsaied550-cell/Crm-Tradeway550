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
