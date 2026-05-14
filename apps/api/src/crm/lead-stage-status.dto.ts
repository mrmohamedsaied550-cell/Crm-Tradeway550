import { z } from 'zod';

/**
 * Phase D3 — D3.3 + Sprint 1 (D6.1): stage-specific status DTOs.
 *
 * `PipelineStage.allowedStatuses` is a JSONB column shaped as an
 * array of entries. The minimum shape is `{ code, label, labelAr }`
 * — the label objects are the source of truth for both the agent
 * picker UI and the activity-timeline summary, so labels never have
 * to be retranslated by the frontend, and a tenant can ship
 * locale-specific copy without shipping a code change.
 *
 * Sprint 1 extends each entry with **optional** Smart Status Rule
 * metadata. Every new field is nullable / optional so existing
 * tenant data (which only has `{code, label, labelAr}`) keeps
 * parsing unchanged — additive, backward-compatible.
 *
 * Smart Status Rule fields drive the "Add Action → Lifecycle"
 * Sprint 2 UX (follow-up auto-creation, reason prompts, conversion
 * preview, close-journey marker, approval gating). The rule is
 * inert at the engine level until the matching Sprint 2/3 engines
 * wire the consumers — Sprint 1 ships ONLY the schema + Lead
 * Detail visibility surface.
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

/**
 * Sprint 1 (D6.1) — lifecycle classifier for a pipeline stage.
 * The four canonical journey steps of captain acquisition. NULL
 * lifecycleCategory on a stage means it doesn't participate in
 * the Journey Bar (e.g. a pipeline reused for a non-acquisition
 * workflow). Mirrors the CHECK constraint added in migration
 * `0044_d6_lifecycle_category`.
 */
export const LIFECYCLE_CATEGORIES = ['fresh_lead', 'signup', 'active', 'dft'] as const;
export type LifecycleCategory = (typeof LIFECYCLE_CATEGORIES)[number];
export const LifecycleCategorySchema = z.enum(LIFECYCLE_CATEGORIES);

/**
 * Sprint 1 (D6.1) — "close journey" type tag.
 * When `closeJourney: true`, this field disambiguates how the
 * lead's `lifecycleState` should be re-classified by the Sprint 3
 * engine (lost vs rejected vs not-qualified — all of which map to
 * `lifecycleState='lost'` today but carry distinct reason groups
 * + reporting buckets).
 */
export const CLOSE_JOURNEY_TYPES = ['lost', 'rejected', 'not_qualified'] as const;
export type CloseJourneyType = (typeof CLOSE_JOURNEY_TYPES)[number];

/**
 * Sprint 1 (D6.1) — default-due-time helpers for follow-up auto-
 * creation. The Sprint 2 engine will read these to seed the new
 * Primary Next Action when the picked status has
 * `requiresFollowUp: true`.
 *
 * `defaultDueOffsetMinutes` is "minutes from now" (e.g. 60 = next
 * hour, 1440 = tomorrow same time). `defaultDueTime` is an
 * optional fixed clock time "HH:MM" applied AFTER the offset
 * (e.g. offset 1440 + time "10:00" = tomorrow 10:00). Either,
 * both, or neither may be set. Validation enforces minutes ≥ 1
 * to prevent a zero / negative offset from creating a follow-up
 * that's already overdue.
 */
const DefaultDueTimeRegex = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Sprint 1 (D6.1) — Smart Status Rule metadata block.
 * Every field is optional; missing == "engine default behaviour".
 * Fields are declared at the entry level rather than a sibling
 * column so the rule travels with its status code (clean ownership,
 * single JSON edit point in Pipeline Builder).
 *
 * Field map ↔ user-spec checklist:
 *   - requiresFollowUp          → drives Sprint 2 auto-follow-up
 *   - defaultNextActionTitle    → seeds the Primary Next Action title
 *   - defaultDueOffsetMinutes   → relative offset for the follow-up
 *   - defaultDueTime            → HH:MM clock pin for the follow-up
 *   - requiresReason            → forces reason capture in the modal
 *   - reasonGroup               → picks WHICH reason catalogue to show
 *   - closeJourney              → marks status as journey-terminating
 *   - closeType                 → lost / rejected / not_qualified
 *   - autoMoveStage             → on pick, auto-move to nextStageCode
 *   - nextStageCode             → target stage when autoMoveStage or
 *                                  surfaced as Next Stage suggestion
 *   - nextStatusCode            → target status (may be same stage,
 *                                  e.g. "No answer 1st" → "No answer 2nd")
 *   - convertToCaptain          → triggers Lead → Captain conversion
 *   - requiresApproval          → Sprint 3 stage-transition approval
 *   - requiredChecks            → admin-defined preconditions (e.g.
 *                                  ["documents_accepted",
 *                                   "partner_verified"]) the Sprint 2/3
 *                                  engines validate before applying.
 */
/**
 * Sprint 3 (D7.1) — approver kinds.
 *   - current_team_leader → TL of the requester's team.
 *   - target_team_leader  → TL of the lead's target team.
 *   - admin               → super_admin / ops_manager.
 *   - role:<code>         → specific role code (e.g.
 *                            "role:registration_tl"). Colon prefix
 *                            lets us extend without inflating the
 *                            enum.
 */
const ApproverKindBaseEnum = z.enum(['current_team_leader', 'target_team_leader', 'admin']);
const ApproverKindRolePrefix = /^role:[a-z][a-z0-9_]*$/;
const ApproverKindSchema = z.union([
  ApproverKindBaseEnum,
  z.string().regex(ApproverKindRolePrefix),
]);

/**
 * Sprint 3 (D7.1) — handoff rules applied AFTER approval.
 *   - target_team_queue   → lead lands in target team's queue
 *                            with no specific owner (TL distributes).
 *   - target_team_leader  → lead transferred to target team's TL.
 *   - auto_rotation       → invoke existing distribution rules.
 *   - specific_owner      → lead transferred to explicit user
 *                            named by `handoffOwnerUserId`.
 */
const HandoffRuleSchema = z.enum([
  'target_team_queue',
  'target_team_leader',
  'auto_rotation',
  'specific_owner',
]);

export const SmartStatusRuleSchema = z
  .object({
    requiresFollowUp: z.boolean().optional(),
    defaultNextActionTitle: z.string().trim().min(1).max(160).optional(),
    defaultDueOffsetMinutes: z
      .number()
      .int()
      .min(1)
      .max(60 * 24 * 365)
      .optional(),
    defaultDueTime: z
      .string()
      .regex(DefaultDueTimeRegex, { message: 'defaultDueTime must match HH:MM (24h)' })
      .optional(),
    requiresReason: z.boolean().optional(),
    reasonGroup: z.string().trim().min(1).max(64).optional(),
    closeJourney: z.boolean().optional(),
    closeType: z.enum(CLOSE_JOURNEY_TYPES).optional(),
    autoMoveStage: z.boolean().optional(),
    /** Stable code of the target stage. Validated against the
     *  pipeline at engine time (Sprint 2/3), not at schema parse. */
    nextStageCode: z.string().trim().min(1).max(64).optional(),
    /** Stable code of the target status. May equal the current
     *  status' code when the rule advances within the same stage
     *  (e.g. "no_answer_1" → "no_answer_2"). */
    nextStatusCode: z.string().trim().min(1).max(64).optional(),
    convertToCaptain: z.boolean().optional(),
    requiresApproval: z.boolean().optional(),
    /**
     * Sprint 3 (D7.1) — WHO can approve a request created by this
     * rule. Only consulted when `requiresApproval` is true. The
     * service snapshots the resolved value onto the
     * LeadTransitionRequest row so a later admin edit doesn't
     * shift an in-flight request.
     */
    approver: ApproverKindSchema.optional(),
    /**
     * Sprint 3 (D7.1) — handoff rule applied AFTER approval. NULL
     * = no handoff (lead keeps its current owner).
     */
    handoffRule: HandoffRuleSchema.optional(),
    /**
     * Sprint 3 (D7.1) — concrete user id for the `specific_owner`
     * handoff variant. Ignored for the other variants.
     */
    handoffOwnerUserId: z.string().uuid().optional(),
    /** Free-form check identifiers the Sprint 2/3 engines resolve.
     *  Capped at 16 to prevent accidental admin blow-ups. */
    requiredChecks: z.array(z.string().trim().min(1).max(64)).max(16).optional(),
  })
  .strict();
export type SmartStatusRule = z.infer<typeof SmartStatusRuleSchema>;
export type ApproverKind = z.infer<typeof ApproverKindSchema>;
export type HandoffRule = z.infer<typeof HandoffRuleSchema>;

export const AllowedStatusEntrySchema = SmartStatusRuleSchema.extend({
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
}).strict();
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
