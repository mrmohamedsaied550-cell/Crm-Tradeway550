import { z } from 'zod';

import type { HandoverMode } from './rotation.service';

/**
 * Phase D3 — D3.5: per-tenant SLA escalation policy.
 *
 * The policy maps each ladder threshold (t75 / t100 / t150 / t200)
 * to ONE action. Actions today:
 *
 *   • `notify_only`        — push reminder to the assigned agent.
 *                             No state change, no tag.
 *   • `notify_and_tag`     — notify the agent + the TL, tag the
 *                             lead `sla_at_risk`.
 *   • `rotate`             — auto-rotate via RotationService
 *                             (handover mode = `defaultHandoverMode`).
 *   • `rotate_or_review`   — auto-rotate on the FIRST occurrence in
 *                             the policy window; on a repeat within
 *                             `reviewOnRepeatWithinHours`, raise a
 *                             TL Review Queue item instead. D3.5
 *                             stages the review-pending audit; D3.6
 *                             materialises the actual `LeadReview`
 *                             row.
 *   • `raise_review`       — always raise a review (no rotation).
 *
 * `defaultHandoverMode` is the mode used when an action triggers a
 * rotation (currently only `rotate` and the rotate-side of
 * `rotate_or_review`). Locked product default = `full`.
 *
 * D3.5 ships the storage + the service that reads it. There is NO
 * admin UI — the editor panel lands in D3.7 polish. Tenants with
 * NULL `escalation_rules` get DEFAULT_ESCALATION_RULES; the service
 * always returns a fully-populated config so callers don't have to
 * thread defaults themselves.
 */

export const EscalationActionSchema = z.enum([
  'notify_only',
  'notify_and_tag',
  'rotate',
  'rotate_or_review',
  'raise_review',
] as const);
export type EscalationAction = z.infer<typeof EscalationActionSchema>;

export const HandoverModeSchema = z.enum(['full', 'summary', 'clean'] as const);

export const ThresholdPolicySchema = z
  .object({
    action: EscalationActionSchema,
    /** Only meaningful for `rotate_or_review`. Defaults to true. */
    rotateOnFirst: z.boolean().default(true),
    /** Only meaningful for `rotate_or_review`. Defaults to 24. */
    reviewOnRepeatWithinHours: z.number().int().min(1).max(168).default(24),
  })
  .strict();
export type ThresholdPolicy = z.infer<typeof ThresholdPolicySchema>;

export const EscalationRulesSchema = z
  .object({
    thresholds: z.object({
      t75: ThresholdPolicySchema,
      t100: ThresholdPolicySchema,
      t150: ThresholdPolicySchema,
      t200: ThresholdPolicySchema,
    }),
    defaultHandoverMode: HandoverModeSchema,
  })
  .strict();
export type EscalationRulesConfig = z.infer<typeof EscalationRulesSchema>;

/**
 * Locked product defaults. Matches the policy in the D3 plan §10:
 *   t75   — soft reminder.
 *   t100  — warning + at-risk tag.
 *   t150  — rotate first time, raise review on repeat within 24h.
 *   t200  — always raise review.
 *
 * `defaultHandoverMode = 'full'` is the locked decision from
 * D3-plan §16/2.
 */
export const DEFAULT_ESCALATION_RULES: EscalationRulesConfig = {
  thresholds: {
    t75: { action: 'notify_only', rotateOnFirst: true, reviewOnRepeatWithinHours: 24 },
    t100: { action: 'notify_and_tag', rotateOnFirst: true, reviewOnRepeatWithinHours: 24 },
    t150: { action: 'rotate_or_review', rotateOnFirst: true, reviewOnRepeatWithinHours: 24 },
    t200: { action: 'raise_review', rotateOnFirst: true, reviewOnRepeatWithinHours: 24 },
  },
  defaultHandoverMode: 'full',
};

/**
 * Tolerant parser: malformed / partial JSON falls back to defaults
 * so a misconfigured tenant never crashes the scheduler. Mirrors
 * the D2.2 `parseDuplicateRulesJson` shape.
 *
 * Returns the resolved config (always populated). Callers don't
 * need to handle a "config missing" branch — the policy is always
 * a complete object.
 */
export function parseEscalationRulesJson(raw: unknown): EscalationRulesConfig {
  if (raw === null || raw === undefined) return { ...DEFAULT_ESCALATION_RULES };
  const parsed = EscalationRulesSchema.safeParse(raw);
  if (!parsed.success) return { ...DEFAULT_ESCALATION_RULES };
  return parsed.data;
}

/** Convenience: explicit re-export so other modules don't have to
 *  import from `rotation.service`. */
export type { HandoverMode };
