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

/**
 * Phase A — A5: PATCH /follow-ups/:id surface. Today the only
 * patchable field is `snoozedUntil` (other field edits don't have a
 * UI consumer yet); kept in a focused schema so adding more later
 * is just an additional field. `null` clears the snooze.
 */
export const UpdateFollowUpSchema = z
  .object({
    /**
     * Push the row out of the active / overdue / due-today windows
     * until this time. Pass `null` to clear an existing snooze. Must
     * be a future timestamp; the service rejects past values with
     * `follow_up.snoozed_in_past`.
     */
    snoozedUntil: isoDateTime.nullable().optional(),
  })
  .strict();
export type UpdateFollowUpDto = z.infer<typeof UpdateFollowUpSchema>;

export const ListMyFollowUpsQuerySchema = z
  .object({
    /** `pending` = not completed; `overdue` = pending && dueAt < now;
     *  `done` = completed; default = all-not-completed. */
    status: z.enum(['pending', 'overdue', 'done', 'all']).default('pending'),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
export type ListMyFollowUpsQueryDto = z.infer<typeof ListMyFollowUpsQuerySchema>;

/**
 * P3-04 — calendar query. The `from` / `to` window is half-open at
 * the upper bound (matches `< to`) so the caller can pass the next
 * month's first instant without double-counting. Capped at a
 * generous 200 rows; calendar surfaces typically render at most a
 * full month of follow-ups.
 *
 * `mine: '0'` opts a TL/admin into seeing every assignee in the
 * tenant; the default keeps the result scoped to the calling user.
 */
export const CalendarFollowUpsQuerySchema = z
  .object({
    from: z.string().datetime(),
    to: z.string().datetime(),
    mine: z.enum(['0', '1']).default('1'),
    limit: z.coerce.number().int().min(1).max(500).default(500),
  })
  .strict()
  .refine((v) => v.from <= v.to, {
    message: 'from must be earlier than or equal to to',
    path: ['from'],
  });
export type CalendarFollowUpsQueryDto = z.infer<typeof CalendarFollowUpsQuerySchema>;
