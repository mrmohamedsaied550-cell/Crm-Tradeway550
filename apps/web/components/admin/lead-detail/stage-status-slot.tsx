'use client';

/**
 * Phase B — B5 (placeholder) → Sprint 1.C (visible).
 *
 * Renders the current stage-specific status as a compact badge in
 * the Lead Detail header. Returns `null` when no status is set
 * (the lead's `currentStageStatus` is null) — that's the
 * empty-state contract per Sprint 1: show what's there, render
 * nothing when nothing's there.
 *
 * Sprint 1 keeps this read-only and minimal: just a badge with
 * the status' display label (or the stable code as a fallback).
 * The agent edits the status via the existing `StageStatusPicker`
 * lower in the card stack — this slot is the header-level
 * "what's active right now" surface that pairs with the new
 * Journey Bar.
 *
 * Label resolution:
 *   - If `label` is provided by the caller (resolved against the
 *     stage's `allowedStatuses` catalogue), it's used as-is.
 *   - If `label` is null/undefined but `status` is set, the raw
 *     code is humanised (snake_case → "Snake case") so the chip
 *     never reads as a developer string even when the catalogue
 *     hasn't been wired into the response yet.
 *
 * Permissions: the parent Lead Detail page already gated on
 * `lead.read` via `findByIdInScopeOrThrow`; field-level access
 * applies to `currentStageStatus` through `applyLeadFieldFilter`.
 * This slot does not re-gate — if the page rendered, the user
 * can see the badge.
 */

import { Badge } from '@/components/ui/badge';

interface StageStatusSlotProps {
  /** Stable code from `lead.currentStageStatus.status`. */
  status?: string | null;
  /**
   * Optional human label resolved against
   * `stage.allowedStatuses[].label` (English) /
   * `.labelAr` (Arabic) by the caller. When omitted, the slot
   * falls back to a humanised version of `status`.
   */
  label?: string | null;
}

export function StageStatusSlot({ status, label }: StageStatusSlotProps): JSX.Element | null {
  if (!status) return null;
  const display = label && label.length > 0 ? label : humanise(status);
  return <Badge tone="neutral">{display}</Badge>;
}

/**
 * Cheap fallback: `no_answer_1` → "No answer 1". Keeps the chip
 * readable when the parent hasn't fetched the labels catalogue
 * yet. Real labels arrive once Sprint 2 wires Add Action into
 * `allowedStatuses`.
 */
function humanise(code: string): string {
  const spaced = code.replace(/[_-]+/g, ' ').trim();
  if (spaced.length === 0) return code;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
