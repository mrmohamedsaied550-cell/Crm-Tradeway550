import { Injectable } from '@nestjs/common';

/**
 * Phase D3 — D3.2: SLA threshold ladder — pure, side-effect-free
 * logic.
 *
 * The ladder maps `elapsed / budget` (where `elapsed` is wall-clock
 * minutes since the SLA window started and `budget` is the
 * stage-or-tenant SLA in minutes) to one of five buckets:
 *
 *     ratio < 0.75              → 'ok'
 *     0.75 ≤ ratio < 1.00       → 't75'    (soft reminder)
 *     1.00 ≤ ratio < 1.50       → 't100'   (warning, tag at-risk)
 *     1.50 ≤ ratio < 2.00       → 't150'   (escalation in D3.5)
 *     ratio ≥ 2.00              → 't200'   (high escalation in D3.5)
 *
 * No DB calls, no clock reads, no side effects. The caller passes
 * `now` and `slaDueAt` so tests are deterministic and the scheduler
 * can batch many leads under a single `now` value.
 *
 * `slaDueAt` is the existing denormalised "this lead's SLA expires
 * at" column on `Lead`. Combined with the `budgetMinutes` (resolved
 * by the caller from `stage.slaMinutes ?? tenantSettings.slaMinutes`),
 * the elapsed time is:
 *
 *     elapsedMs = now - (slaDueAt - budgetMinutes * 60_000)
 *               = now - slaDueAt + budgetMinutes * 60_000
 *
 * No new column is needed on Lead — `slaDueAt` already pins the
 * window end, and with the budget we can compute the start.
 */

export type SlaThreshold = 'ok' | 't75' | 't100' | 't150' | 't200';

/** Result of `computeBucket`. `noOp = true` signals "no SLA timer is
 *  meaningful right now" — paused / closed / missing-due-at — and the
 *  caller should leave the lead's threshold untouched. */
export interface ThresholdResult {
  threshold: SlaThreshold;
  ratio: number;
  elapsedMinutes: number;
  budgetMinutes: number;
  noOp: boolean;
}

/** Input for `computeBucket`. */
export interface ThresholdInput {
  /** The lead's `slaDueAt`. NULL for paused / terminal leads. */
  slaDueAt: Date | null;
  /** The applicable budget — `stage.slaMinutes ?? tenantSettings.slaMinutes`.
   *  NULL or non-positive => no-op (caller should fall back to 'ok'). */
  budgetMinutes: number | null | undefined;
  /** The "now" the caller wants to evaluate against. Injectable so
   *  the scheduler can batch hundreds of leads under a single timestamp. */
  now: Date;
}

const T75 = 0.75;
const T100 = 1.0;
const T150 = 1.5;
const T200 = 2.0;

/** No-op result that callers return when the lead has no meaningful
 *  SLA window (paused / terminal / missing-due-at / invalid budget). */
const NO_OP_RESULT: ThresholdResult = {
  threshold: 'ok',
  ratio: 0,
  elapsedMinutes: 0,
  budgetMinutes: 0,
  noOp: true,
};

@Injectable()
export class SlaThresholdsService {
  /**
   * Compute the threshold bucket for a single lead.
   *
   * Pure: no DB calls, no clock reads, no logging. The caller is
   * responsible for:
   *   - Skipping leads in non-'open' lifecycle (terminal / archived).
   *   - Skipping leads with `slaStatus = 'paused'`.
   *   - Persisting the result + emitting the LeadActivity row when
   *     the bucket changes.
   *
   * Edge cases handled here:
   *   - `slaDueAt = null` → noOp (caller leaves threshold untouched).
   *   - `budgetMinutes ≤ 0` or unset → noOp (defensive — admin
   *     misconfiguration shouldn't crash the scheduler).
   *   - Future-dated `slaDueAt` with a positive budget → ratio < 1
   *     (could still be 't75' if elapsed ≥ 75% of the window).
   *   - `slaDueAt` far in the past → caps at any ratio ≥ 2 → 't200'.
   *
   * Float comparisons are inclusive on the LOWER bound — i.e., a
   * ratio of exactly 0.75 lands in 't75', exactly 1.00 lands in
   * 't100', and so on. Matches the `≥` semantics in the operational
   * spec.
   */
  computeBucket(input: ThresholdInput): ThresholdResult {
    const { slaDueAt, budgetMinutes, now } = input;

    // No-op shortcut for paused / terminal / unconfigured leads.
    if (!slaDueAt) return NO_OP_RESULT;
    if (budgetMinutes === null || budgetMinutes === undefined) return NO_OP_RESULT;
    if (!Number.isFinite(budgetMinutes) || budgetMinutes <= 0) return NO_OP_RESULT;

    const budgetMs = budgetMinutes * 60_000;
    const elapsedMs = now.getTime() - slaDueAt.getTime() + budgetMs;
    // elapsedMs may be negative if `slaDueAt` is more than `budgetMs`
    // in the future — happens when a fresh reset bumps slaDueAt past
    // the original window end. Treat as 'ok' ratio=0; engine recovers
    // on the next tick.
    const elapsedMsClamped = elapsedMs < 0 ? 0 : elapsedMs;
    const ratio = elapsedMsClamped / budgetMs;

    return {
      threshold: bucketFromRatio(ratio),
      ratio,
      elapsedMinutes: Math.round(elapsedMsClamped / 60_000),
      budgetMinutes,
      noOp: false,
    };
  }
}

/** Pure bucket assignment from a non-negative ratio. Exported only
 *  for unit tests; the service method above is the public surface. */
export function bucketFromRatio(ratio: number): SlaThreshold {
  if (ratio >= T200) return 't200';
  if (ratio >= T150) return 't150';
  if (ratio >= T100) return 't100';
  if (ratio >= T75) return 't75';
  return 'ok';
}
