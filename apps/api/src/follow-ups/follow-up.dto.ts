import { z } from 'zod';

/**
 * C36 — Follow-up DTOs.
 *
 * One row per scheduled "next action" on a lead. `actionType` is a
 * narrow enum to keep the agent UI's dropdown stable.
 */

export const FOLLOW_UP_ACTION_TYPES = ['call', 'whatsapp', 'visit', 'other'] as const;
export type FollowUpActionType = (typeof FOLLOW_UP_ACTION_TYPES)[number];

const isoDateTime = z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'invalid date');

export const CreateFollowUpSchema = z
  .object({
    actionType: z.enum(FOLLOW_UP_ACTION_TYPES),
    dueAt: isoDateTime,
    note: z.string().trim().max(2000).optional(),
    /** Optional override; defaults to the lead's current assignee. */
    assignedToId: z.string().uuid().nullable().optional(),
  })
  .strict();
export type CreateFollowUpDto = z.infer<typeof CreateFollowUpSchema>;

export const ListMyFollowUpsQuerySchema = z
  .object({
    /** `pending` = not completed; `overdue` = pending && dueAt < now;
     *  `done` = completed; default = all-not-completed. */
    status: z.enum(['pending', 'overdue', 'done', 'all']).default('pending'),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
export type ListMyFollowUpsQueryDto = z.infer<typeof ListMyFollowUpsQuerySchema>;
