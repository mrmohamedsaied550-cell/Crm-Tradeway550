'use client';

/**
 * Phase B — B5: structural placeholder for stage-specific statuses
 * (e.g. Contacted → Awaiting reply / Replied / No answer).
 *
 * Renders nothing today. Accepts an optional `status` string the
 * page can already pass through for forward-compatibility — when
 * the backend later starts populating stage statuses, swap the
 * `null` return for the actual badge render and every existing
 * caller will light up automatically.
 *
 * Zero-cost in the DOM until the feature ships: returning `null`
 * means React doesn't emit a node at all.
 *
 * Why a component instead of a comment: callers can pass props
 * (status, tone, label) without changing the call site once we
 * implement, so the diff at activation time is one component file
 * not a sweep across the page.
 */
interface StageStatusSlotProps {
  /** Future: stage-specific status code. Today: ignored. */
  status?: string | null;
}

export function StageStatusSlot(_props: StageStatusSlotProps): JSX.Element | null {
  // Intentionally renders nothing. See the file-level comment.
  return null;
}
