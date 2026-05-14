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
