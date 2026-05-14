import { z } from 'zod';

/**
 * Sprint 13 (D13) — Lead Partner Target DTOs.
 *
 * Status allow-list mirrors the DB CHECK in
 * `0050_d13_lead_partner_targets`. The service treats
 * `target` and `not_started` as the same operational state but
 * persists whatever the caller passed — easier audit replay.
 */

export const LEAD_PARTNER_TARGET_STATUSES = [
  'target',
  'not_started',
  'contacted',
  'signup_started',
  'matched',
  'rejected',
  'inactive',
] as const;
export type LeadPartnerTargetStatus = (typeof LEAD_PARTNER_TARGET_STATUSES)[number];

const statusSchema = z.enum(LEAD_PARTNER_TARGET_STATUSES);

/**
 * Create a partner target. `partnerSourceId` is the only required
 * field — the rest defaults from the lead's assignee / configured
 * partner source.
 */
export const CreateLeadPartnerTargetSchema = z
  .object({
    partnerSourceId: z.string().uuid(),
    status: statusSchema.optional(),
    countryId: z.string().uuid().optional(),
    teamId: z.string().uuid().optional(),
    ownerUserId: z.string().uuid().optional(),
    note: z.string().trim().max(2000).optional(),
  })
  .strict();
export type CreateLeadPartnerTargetDto = z.infer<typeof CreateLeadPartnerTargetSchema>;

/**
 * Optional list filter — Sprint 13 ships the default "all targets
 * for this lead" path; the filter parameters are inert until a
 * future surface needs them.
 */
export const ListLeadPartnerTargetsQuerySchema = z
  .object({
    status: statusSchema.optional(),
    partnerSourceId: z.string().uuid().optional(),
  })
  .strict();
export type ListLeadPartnerTargetsQueryDto = z.infer<typeof ListLeadPartnerTargetsQuerySchema>;

/**
 * Sprint 17 (D17) — partial update for an existing partner target.
 *
 * Closes the explicit Sprint 13 PATCH deferral so a target can move
 * from `target` → `contacted` → `signup_started` → `matched` (or
 * `rejected` / `inactive`). The caller can also reassign the owner
 * / team / country and edit the note without re-creating the row.
 *
 * Three-way null semantics:
 *   - undefined → field unchanged.
 *   - null      → field cleared (owner / team / country / note only).
 *   - value     → field set.
 *
 * `partnerSourceId` is intentionally NOT settable — the unique-index
 * dedupe key would have to be revalidated and the row would no longer
 * match the audit history. Operators who want a different partner
 * journey create a new target instead.
 *
 * Strict so any unknown field is rejected at the controller
 * boundary — auditable surface area.
 */
export const UpdateLeadPartnerTargetSchema = z
  .object({
    status: statusSchema.optional(),
    countryId: z.string().uuid().nullable().optional(),
    teamId: z.string().uuid().nullable().optional(),
    ownerUserId: z.string().uuid().nullable().optional(),
    note: z.string().trim().max(2000).nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, {
    message: 'Pass at least one field to update',
  });
export type UpdateLeadPartnerTargetDto = z.infer<typeof UpdateLeadPartnerTargetSchema>;
