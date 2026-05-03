import { z } from 'zod';

/**
 * Phase A — A2: DTOs for the per-tenant lost-reason catalogue.
 *
 * The `code` field is the stable machine identifier (e.g.
 * 'no_vehicle'). Once written, it should not change — distribution
 * rules, reports, and audit logs may reference codes long after a
 * label is renamed. Service-layer validation enforces this on update.
 */

const codeShape = z
  .string()
  .trim()
  .min(2)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/u, 'code must be snake_case ASCII (a-z, 0-9, _)');

const labelShape = z.string().trim().min(1).max(120);

export const CreateLostReasonSchema = z
  .object({
    code: codeShape,
    labelEn: labelShape,
    labelAr: labelShape,
    isActive: z.boolean().default(true),
    /** 10..1000 in practice; default 100 for new entries (sorted last). */
    displayOrder: z.coerce.number().int().min(0).max(10_000).default(100),
  })
  .strict();
export type CreateLostReasonDto = z.infer<typeof CreateLostReasonSchema>;

/**
 * `code` is intentionally NOT updatable — see header comment.
 * Admins who need to rename a code must create a new row, migrate
 * leads off the old one (a future tool), then deactivate the old.
 */
export const UpdateLostReasonSchema = z
  .object({
    labelEn: labelShape.optional(),
    labelAr: labelShape.optional(),
    isActive: z.boolean().optional(),
    displayOrder: z.coerce.number().int().min(0).max(10_000).optional(),
  })
  .strict();
export type UpdateLostReasonDto = z.infer<typeof UpdateLostReasonSchema>;
