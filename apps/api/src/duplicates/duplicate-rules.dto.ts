import { z } from 'zod';

/**
 * Phase D2 — D2.2: Tenant-configurable duplicate / reactivation rules.
 *
 * Stored as a JSONB column on `tenant_settings.duplicate_rules`
 * (added in D2.1). NULL on an existing tenant means "use the locked
 * product defaults below." Tenants can override any subset of the
 * keys; missing keys fall back to the defaults.
 *
 * Product defaults (locked from the D2 plan, signed off by product):
 *   - reactivateLostAfterDays:           30
 *   - reactivateNoAnswerAfterDays:       7
 *   - reactivateNoAnswerLostReasonCodes: ['no_answer', 'no_response']
 *   - captainBehavior:                   'always_review'
 *   - wonBehavior:                       'always_review'
 *   - ownershipOnReactivation:           'route_engine'
 *   - crossPipelineMatch:                false
 */

const ownershipOnReactivation = z.enum(['route_engine', 'previous_owner', 'unassigned']);
export type OwnershipOnReactivation = z.infer<typeof ownershipOnReactivation>;

const captainBehavior = z.enum(['always_review']);
export type CaptainBehavior = z.infer<typeof captainBehavior>;

const wonBehavior = z.enum(['always_review']);
export type WonBehavior = z.infer<typeof wonBehavior>;

/**
 * The full typed shape after defaults are applied. Service code reads
 * this everywhere; the underlying JSON column is parsed defensively.
 */
export interface DuplicateRulesConfig {
  reactivateLostAfterDays: number;
  reactivateNoAnswerAfterDays: number;
  reactivateNoAnswerLostReasonCodes: readonly string[];
  captainBehavior: CaptainBehavior;
  wonBehavior: WonBehavior;
  ownershipOnReactivation: OwnershipOnReactivation;
  crossPipelineMatch: boolean;
}

/**
 * Locked product defaults. Used when:
 *   - tenant_settings.duplicate_rules is NULL (every existing tenant
 *     today),
 *   - the column holds a partial object (only some keys overridden).
 *
 * Marked `as const` so consumers receive the precise literal types.
 */
export const DEFAULT_DUPLICATE_RULES: DuplicateRulesConfig = {
  reactivateLostAfterDays: 30,
  reactivateNoAnswerAfterDays: 7,
  reactivateNoAnswerLostReasonCodes: ['no_answer', 'no_response'],
  captainBehavior: 'always_review',
  wonBehavior: 'always_review',
  ownershipOnReactivation: 'route_engine',
  crossPipelineMatch: false,
} as const;

/**
 * Zod schema used by tenant-settings PATCH validation (D2.2 exposes
 * the schema; the actual route wiring lands in D2.4 alongside the
 * admin UI). Every field is optional so partial PATCHes work; the
 * service layer merges with `DEFAULT_DUPLICATE_RULES`.
 *
 * Bounds:
 *   - day-counts clamp to [0, 3650] (10-year ceiling — anything
 *     longer is almost certainly a data-entry mistake).
 *   - lost-reason codes clamp to 1..32 chars and dedupe on parse.
 */
export const DuplicateRulesSchema = z
  .object({
    reactivateLostAfterDays: z.coerce.number().int().min(0).max(3650).optional(),
    reactivateNoAnswerAfterDays: z.coerce.number().int().min(0).max(3650).optional(),
    reactivateNoAnswerLostReasonCodes: z
      .array(z.string().trim().min(1).max(32))
      .max(32)
      .transform((arr) => Array.from(new Set(arr)))
      .optional(),
    captainBehavior: captainBehavior.optional(),
    wonBehavior: wonBehavior.optional(),
    ownershipOnReactivation: ownershipOnReactivation.optional(),
    crossPipelineMatch: z.boolean().optional(),
  })
  .strict();
export type DuplicateRulesPatch = z.infer<typeof DuplicateRulesSchema>;

/**
 * Defensive parse of a raw JSON column value into the typed config.
 * Unknown keys are dropped; malformed values fall back to the
 * defaults. Never throws — a hand-edited DB row can't crash a
 * request.
 */
export function parseDuplicateRulesJson(raw: unknown): DuplicateRulesConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULT_DUPLICATE_RULES };
  }
  const parsed = DuplicateRulesSchema.safeParse(raw);
  if (!parsed.success) return { ...DEFAULT_DUPLICATE_RULES };
  return mergeWithDefaults(parsed.data);
}

/** Merge a partial PATCH onto the locked defaults. Pure helper. */
export function mergeWithDefaults(patch: DuplicateRulesPatch): DuplicateRulesConfig {
  return {
    reactivateLostAfterDays:
      patch.reactivateLostAfterDays ?? DEFAULT_DUPLICATE_RULES.reactivateLostAfterDays,
    reactivateNoAnswerAfterDays:
      patch.reactivateNoAnswerAfterDays ?? DEFAULT_DUPLICATE_RULES.reactivateNoAnswerAfterDays,
    reactivateNoAnswerLostReasonCodes:
      patch.reactivateNoAnswerLostReasonCodes ??
      DEFAULT_DUPLICATE_RULES.reactivateNoAnswerLostReasonCodes,
    captainBehavior: patch.captainBehavior ?? DEFAULT_DUPLICATE_RULES.captainBehavior,
    wonBehavior: patch.wonBehavior ?? DEFAULT_DUPLICATE_RULES.wonBehavior,
    ownershipOnReactivation:
      patch.ownershipOnReactivation ?? DEFAULT_DUPLICATE_RULES.ownershipOnReactivation,
    crossPipelineMatch: patch.crossPipelineMatch ?? DEFAULT_DUPLICATE_RULES.crossPipelineMatch,
  };
}
