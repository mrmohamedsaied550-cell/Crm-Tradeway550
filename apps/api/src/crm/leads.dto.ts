import { z } from 'zod';
import { LEAD_SOURCES, ALL_STAGE_CODES, ACTIVITY_TYPES } from './pipeline.registry';

/**
 * CRM DTOs.
 *
 * Note on validation: the C10 spec called for class-validator, but the
 * existing convention from C6–C9 is zod via `nestjs-zod`. To keep the
 * codebase consistent we stay on zod here. Phone normalisation runs as a
 * `transform` so the controller receives an already-clean E.164 string;
 * the downstream service does not have to re-validate.
 */

import { normalizeE164 } from './phone.util';

const phoneE164 = z
  .string()
  .min(6)
  .max(32)
  .transform((v, ctx) => {
    try {
      return normalizeE164(v);
    } catch (err) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: (err as Error).message });
      return z.NEVER;
    }
  });

export const CreateLeadSchema = z.object({
  name: z.string().trim().min(1).max(120),
  phone: phoneE164,
  email: z.string().trim().email().max(254).optional(),
  source: z.enum(LEAD_SOURCES).default('manual'),
  /** Optional override; defaults to the `new` stage if omitted. */
  stageCode: z.enum(ALL_STAGE_CODES as [string, ...string[]]).optional(),
  /** Optional initial assignment (must be a user id in the same tenant). */
  assignedToId: z.string().uuid().optional(),
});
export type CreateLeadDto = z.infer<typeof CreateLeadSchema>;

export const UpdateLeadSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    phone: phoneE164.optional(),
    email: z.string().trim().email().max(254).nullable().optional(),
    source: z.enum(LEAD_SOURCES).optional(),
  })
  .strict();
export type UpdateLeadDto = z.infer<typeof UpdateLeadSchema>;

export const AssignLeadSchema = z.object({
  /** Pass `null` to unassign. */
  assignedToId: z.string().uuid().nullable(),
});
export type AssignLeadDto = z.infer<typeof AssignLeadSchema>;

export const MoveStageSchema = z.object({
  stageCode: z.enum(ALL_STAGE_CODES as [string, ...string[]]),
});
export type MoveStageDto = z.infer<typeof MoveStageSchema>;

export const AddActivitySchema = z
  .object({
    /** Only agent-authored types are accepted from the controller. */
    type: z.enum(['note', 'call'] as const satisfies readonly (typeof ACTIVITY_TYPES)[number][]),
    body: z.string().trim().min(1).max(4000),
  })
  .strict();
export type AddActivityDto = z.infer<typeof AddActivitySchema>;

export const ConvertLeadSchema = z
  .object({
    /** Optional document flags at conversion time. */
    hasIdCard: z.boolean().optional(),
    hasLicense: z.boolean().optional(),
    hasVehicleRegistration: z.boolean().optional(),
    /** Optional team to own the captain post-handover. Validated cross-tenant. */
    teamId: z.string().uuid().nullable().optional(),
  })
  .strict();
export type ConvertLeadDto = z.infer<typeof ConvertLeadSchema>;

// ───── Captains (C18) ─────

const captainStatus = z.enum(['active', 'inactive', 'archived']);
export type CaptainStatus = z.infer<typeof captainStatus>;

export const ListCaptainsQuerySchema = z
  .object({
    teamId: z.string().uuid().optional(),
    status: captainStatus.optional(),
    /** Free-text match across name + phone. */
    q: z.string().trim().min(1).max(120).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();
export type ListCaptainsQueryDto = z.infer<typeof ListCaptainsQuerySchema>;

export const ListLeadsQuerySchema = z
  .object({
    stageCode: z.enum(ALL_STAGE_CODES as [string, ...string[]]).optional(),
    assignedToId: z.string().uuid().optional(),
    /** Free-text match across name + phone + email. */
    q: z.string().trim().min(1).max(120).optional(),
    /** Pagination — basic offset/limit; cursor pagination arrives later. */
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();
export type ListLeadsQueryDto = z.infer<typeof ListLeadsQuerySchema>;
