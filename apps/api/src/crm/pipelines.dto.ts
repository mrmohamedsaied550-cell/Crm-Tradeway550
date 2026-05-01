import { z } from 'zod';

/**
 * P2-07 — Pipeline Builder DTOs.
 *
 * Pipelines are scoped to (Tenant) optionally narrowed by
 * (companyId, countryId). Stages live inside a pipeline; codes are
 * unique per pipeline and orders are unique per pipeline.
 *
 * Reorder is a single bulk operation: clients submit the full list
 * of stage ids in their target order. The service rewrites every
 * order column atomically so partial reorders are impossible.
 */

const code = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[a-z][a-z0-9_]*$/u, 'code must be snake_case ASCII');
const name = z.string().trim().min(1).max(120);

export const CreatePipelineSchema = z
  .object({
    name,
    companyId: z.string().uuid().nullable().optional(),
    countryId: z.string().uuid().nullable().optional(),
    isActive: z.boolean().default(true),
  })
  .strict();
export type CreatePipelineDto = z.infer<typeof CreatePipelineSchema>;

export const UpdatePipelineSchema = z
  .object({
    name: name.optional(),
    isActive: z.boolean().optional(),
  })
  .strict();
export type UpdatePipelineDto = z.infer<typeof UpdatePipelineSchema>;

export const CreateStageSchema = z
  .object({
    code,
    name,
    /** Optional explicit order; service appends to the end if omitted. */
    order: z.number().int().min(0).max(100_000).optional(),
    isTerminal: z.boolean().default(false),
  })
  .strict();
export type CreateStageDto = z.infer<typeof CreateStageSchema>;

export const UpdateStageSchema = z
  .object({
    name: name.optional(),
    isTerminal: z.boolean().optional(),
  })
  .strict();
export type UpdateStageDto = z.infer<typeof UpdateStageSchema>;

export const ReorderStagesSchema = z
  .object({
    /** Full list of stage ids in their target order. */
    stageIds: z.array(z.string().uuid()).min(1).max(50),
  })
  .strict();
export type ReorderStagesDto = z.infer<typeof ReorderStagesSchema>;
