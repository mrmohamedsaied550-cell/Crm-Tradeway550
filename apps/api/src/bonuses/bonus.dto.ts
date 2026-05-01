import { z } from 'zod';

/**
 * C32 — Bonus rule DTOs.
 *
 * MVP fields: company × country scope, optional team / role narrowing,
 * a typed `bonusType`, free-text `trigger`, decimal `amount`, and an
 * `isActive` toggle. Payout engine ships later.
 */

export const BONUS_TYPES = [
  'first_trip',
  'activation',
  'trip_milestone',
  'conversion_rate',
  'manual',
] as const;
export type BonusType = (typeof BONUS_TYPES)[number];

const amount = z
  .union([z.number(), z.string()])
  .transform((v) => (typeof v === 'number' ? v.toFixed(2) : v.trim()))
  .refine(
    (v) => /^\d+(\.\d{1,2})?$/.test(v),
    'amount must be a positive decimal (e.g. 100 or 100.50)',
  );

export const CreateBonusRuleSchema = z
  .object({
    companyId: z.string().uuid(),
    countryId: z.string().uuid(),
    teamId: z.string().uuid().nullable().optional(),
    roleId: z.string().uuid().nullable().optional(),
    bonusType: z.enum(BONUS_TYPES),
    trigger: z.string().trim().min(1).max(280),
    amount,
    isActive: z.boolean().optional(),
  })
  .strict();
export type CreateBonusRuleDto = z.infer<typeof CreateBonusRuleSchema>;

export const UpdateBonusRuleSchema = z
  .object({
    companyId: z.string().uuid().optional(),
    countryId: z.string().uuid().optional(),
    teamId: z.string().uuid().nullable().optional(),
    roleId: z.string().uuid().nullable().optional(),
    bonusType: z.enum(BONUS_TYPES).optional(),
    trigger: z.string().trim().min(1).max(280).optional(),
    amount: amount.optional(),
    isActive: z.boolean().optional(),
  })
  .strict();
export type UpdateBonusRuleDto = z.infer<typeof UpdateBonusRuleSchema>;
