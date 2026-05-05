import { z } from 'zod';

/**
 * Phase D3 — D3.3: stage-specific status DTOs.
 *
 * `PipelineStage.allowedStatuses` is a JSONB column shaped as an
 * array of `{ code, label, labelAr }`. The label objects are the
 * source of truth for both the agent picker UI and the activity-
 * timeline summary — so labels never have to be retranslated by
 * the frontend, and a tenant can ship locale-specific copy without
 * shipping a code change.
 *
 * The shape is validated at the service layer (`getAllowedStatusesForStage`)
 * — invalid stored JSON is treated as "no statuses configured" so a
 * misconfigured tenant doesn't crash the picker; the status-write
 * path rejects with `lead.stage.status.invalid`.
 *
 * `code` is intentionally a free string at the column level (one per
 * tenant per stage); the service enforces uniqueness within a stage's
 * allowedStatuses array. We avoid a Postgres ENUM so each tenant can
 * configure its own catalogue per stage without schema migrations.
 */

export const AllowedStatusEntrySchema = z
  .object({
    /** Stable code; lower-snake-case is conventional. */
    code: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9_]*$/, {
        message: 'code must be lowercase ASCII (a-z, 0-9, _) starting with a letter',
      }),
    /** Display label, English. */
    label: z.string().trim().min(1).max(120),
    /** Display label, Arabic. Required so RTL UI never renders the raw code. */
    labelAr: z.string().trim().min(1).max(120),
  })
  .strict();
export type AllowedStatusEntry = z.infer<typeof AllowedStatusEntrySchema>;

export const AllowedStatusesSchema = z.array(AllowedStatusEntrySchema).max(64);
export type AllowedStatuses = z.infer<typeof AllowedStatusesSchema>;

/**
 * Parse + validate an `allowedStatuses` JSON value off a PipelineStage
 * row. Returns:
 *   - `{ ok: true, statuses }` for valid configurations (including the
 *     empty array — the picker shows the "no statuses configured" hint).
 *   - `{ ok: true, statuses: [] }` for NULL / undefined (treated as empty).
 *   - `{ ok: false, error }` for malformed / partially-typed input —
 *     callers surface this so an admin can fix the catalogue without
 *     the picker crashing for agents in the meantime.
 *
 * Tolerant of unknown keys at the entry level — they're stripped via
 * `.strict()`. Code dedupes are also enforced (duplicate codes are
 * rejected) so a tenant can't accidentally configure two "interested"
 * entries with different labels.
 */
export function parseAllowedStatusesJson(
  raw: unknown,
): { ok: true; statuses: AllowedStatuses } | { ok: false; error: string } {
  if (raw === null || raw === undefined) return { ok: true, statuses: [] };
  const parsed = AllowedStatusesSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors.map((e) => e.message).join('; ') };
  }
  const seen = new Set<string>();
  for (const entry of parsed.data) {
    if (seen.has(entry.code)) {
      return { ok: false, error: `duplicate status code: ${entry.code}` };
    }
    seen.add(entry.code);
  }
  return { ok: true, statuses: parsed.data };
}

/** Body schema for `POST /leads/:id/stage-status`. */
export const SetStageStatusSchema = z
  .object({
    /** Must equal one of the stage's allowedStatuses[].code values. */
    status: z.string().trim().min(1).max(64),
    /** Optional free-text note. Capped to keep the timeline scannable. */
    notes: z.string().trim().max(1000).optional(),
  })
  .strict();
export type SetStageStatusDto = z.infer<typeof SetStageStatusSchema>;
