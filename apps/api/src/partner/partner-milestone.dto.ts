import { z } from 'zod';

/**
 * Phase D4 — D4.7: PartnerMilestoneConfig DTOs.
 *
 * Closed enums at the validation layer; the DB columns stay TEXT
 * for forward compatibility. Service layer enforces invariants
 * Zod can't see (e.g. one active config per partner source — left
 * as a soft preference; multiple configs are allowed but the UI
 * defaults to active ones).
 */

export const MILESTONE_ANCHORS = [
  'partner_active_date',
  'partner_dft_date',
  'first_seen_in_partner',
] as const;
export const MilestoneAnchorSchema = z.enum(MILESTONE_ANCHORS);
export type MilestoneAnchor = z.infer<typeof MilestoneAnchorSchema>;

const MilestoneStepsSchema = z
  .array(z.number().int().positive().max(1_000_000))
  .min(1)
  .max(20)
  .superRefine((v, ctx) => {
    // Strictly ascending + deduped.
    for (let i = 1; i < v.length; i += 1) {
      const prev = v[i - 1] ?? 0;
      const cur = v[i] ?? 0;
      if (cur <= prev) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i],
          message: 'milestoneSteps must be strictly ascending integers.',
        });
        return;
      }
    }
  });

const RiskThresholdsSchema = z
  .object({
    high: z.number().min(0).max(1),
    medium: z.number().min(0).max(1),
  })
  .strict()
  .refine((v) => v.high < v.medium, {
    message: 'riskThresholds.high must be less than riskThresholds.medium.',
    path: ['high'],
  });
export type MilestoneRiskThresholds = z.infer<typeof RiskThresholdsSchema>;

export const CreateMilestoneConfigSchema = z
  .object({
    partnerSourceId: z.string().uuid(),
    code: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9_]+$/, 'code must be lowercase snake_case'),
    displayName: z.string().trim().min(1).max(200),
    windowDays: z.number().int().min(1).max(3650),
    milestoneSteps: MilestoneStepsSchema,
    anchor: MilestoneAnchorSchema,
    riskThresholds: RiskThresholdsSchema.optional(),
    isActive: z.boolean().default(true),
  })
  .strict();
export type CreateMilestoneConfigDto = z.infer<typeof CreateMilestoneConfigSchema>;

export const UpdateMilestoneConfigSchema = z
  .object({
    code: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9_]+$/, 'code must be lowercase snake_case')
      .optional(),
    displayName: z.string().trim().min(1).max(200).optional(),
    windowDays: z.number().int().min(1).max(3650).optional(),
    milestoneSteps: MilestoneStepsSchema.optional(),
    anchor: MilestoneAnchorSchema.optional(),
    riskThresholds: RiskThresholdsSchema.nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .strict();
export type UpdateMilestoneConfigDto = z.infer<typeof UpdateMilestoneConfigSchema>;

export const ListMilestoneConfigsSchema = z
  .object({
    partnerSourceId: z.string().uuid().optional(),
    isActive: z.coerce.boolean().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();
export type ListMilestoneConfigsDto = z.infer<typeof ListMilestoneConfigsSchema>;

/** Locked product defaults — used when `riskThresholds` is NULL. */
export const DEFAULT_RISK_THRESHOLDS: MilestoneRiskThresholds = {
  high: 0.3,
  medium: 0.6,
};
