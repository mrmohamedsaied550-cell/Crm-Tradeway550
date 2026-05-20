import { z } from 'zod';

/**
 * DTOs for Lead Status, Documents, Follow-ups, and Advanced Filters.
 * Part of the C30 lead-detail enhancement.
 */

// ───── Lead Statuses ─────

export const CreateLeadStatusSchema = z.object({
  stageCode: z.string().min(1).max(60),
  code: z.string().min(1).max(60),
  name: z.string().trim().min(1).max(120),
  color: z.string().max(30).optional().default('gray'),
  order: z.number().int().min(0).optional().default(0),
  isDefault: z.boolean().optional().default(false),
});
export type CreateLeadStatusDto = z.infer<typeof CreateLeadStatusSchema>;

export const UpdateLeadStatusSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    color: z.string().max(30).optional(),
    order: z.number().int().min(0).optional(),
    isDefault: z.boolean().optional(),
  })
  .strict();
export type UpdateLeadStatusDto = z.infer<typeof UpdateLeadStatusSchema>;

export const ChangeLeadStatusSchema = z.object({
  statusId: z.string().uuid().nullable(),
});
export type ChangeLeadStatusDto = z.infer<typeof ChangeLeadStatusSchema>;

export const ListLeadStatusesQuerySchema = z
  .object({
    stageCode: z.string().min(1).max(60).optional(),
  })
  .strict();
export type ListLeadStatusesQueryDto = z.infer<typeof ListLeadStatusesQuerySchema>;

// ───── Lead Documents ─────

export const CreateLeadDocumentSchema = z.object({
  type: z.string().min(1).max(60),
  label: z.string().trim().min(1).max(120),
  fileUrl: z.string().url().optional(),
  notes: z.string().max(2000).optional(),
});
export type CreateLeadDocumentDto = z.infer<typeof CreateLeadDocumentSchema>;

export const UpdateLeadDocumentSchema = z
  .object({
    status: z.enum(['pending', 'uploaded', 'approved', 'rejected']).optional(),
    fileUrl: z.string().url().nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
  })
  .strict();
export type UpdateLeadDocumentDto = z.infer<typeof UpdateLeadDocumentSchema>;

// ───── Lead Follow-ups ─────

export const CreateLeadFollowUpSchema = z.object({
  scheduledAt: z.string().datetime(),
  method: z.enum(['call', 'whatsapp', 'email', 'visit', 'other']).default('call'),
  note: z.string().max(2000).optional(),
});
export type CreateLeadFollowUpDto = z.infer<typeof CreateLeadFollowUpSchema>;

export const CompleteLeadFollowUpSchema = z
  .object({
    note: z.string().max(2000).optional(),
  })
  .strict();
export type CompleteLeadFollowUpDto = z.infer<typeof CompleteLeadFollowUpSchema>;

// ───── Advanced Filter / Query Builder ─────

const filterOperator = z.enum([
  'eq',
  'neq',
  'contains',
  'not_contains',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'not_in',
  'is_null',
  'is_not_null',
]);

const filterCondition = z.object({
  field: z.enum([
    'stage',
    'status',
    'source',
    'assignedTo',
    'slaStatus',
    'createdAt',
    'updatedAt',
    'lastResponseAt',
    'name',
    'phone',
    'email',
  ]),
  operator: filterOperator,
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]).optional(),
});

export const AdvancedFilterSchema = z.object({
  /** Conditions that ALL must match (AND). */
  allConditions: z.array(filterCondition).optional().default([]),
  /** Conditions where ANY one match is sufficient (OR). */
  anyConditions: z.array(filterCondition).optional().default([]),
  /** Pagination */
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  /** Sort */
  sortBy: z
    .enum(['createdAt', 'updatedAt', 'name', 'slaDueAt', 'lastResponseAt'])
    .optional()
    .default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).optional().default('desc'),
});
export type AdvancedFilterDto = z.infer<typeof AdvancedFilterSchema>;
