/**
 * Phase 1A — distribution engine types.
 *
 * Pure interfaces shared by the strategy implementations + the
 * orchestrator (DistributionService — lands in A4) + the
 * REST controllers (A7). No runtime code, no DB imports, so this
 * file safely compiles in any environment (tests included).
 *
 * Design split:
 *
 *   1. The orchestrator is responsible for (a) finding the matched
 *      rule, (b) building the candidate pool, (c) running the
 *      filter pipeline, and (d) recording the routing-log row.
 *
 *   2. The strategy is responsible ONLY for "given these surviving
 *      candidates, who wins?". Stateless, pure function.
 *
 * Because of that split, exclusion reasons live OUTSIDE the strategy
 * interface — the orchestrator records them when it filters. The
 * strategy never needs to explain rejections.
 */

/** The four strategies the engine ships with. */
export type StrategyName = 'specific_user' | 'round_robin' | 'weighted' | 'capacity';

export const ALL_STRATEGY_NAMES: readonly StrategyName[] = [
  'specific_user',
  'round_robin',
  'weighted',
  'capacity',
] as const;

/**
 * Input context for a routing decision. The orchestrator builds this
 * from the lead being routed + the active tenant context.
 */
export interface RoutingContext {
  /** Always set; comes from AsyncLocalStorage tenant context. */
  tenantId: string;
  /** The lead being routed. */
  leadId: string;
  /** From `lead.source`. NULL leads can still be routed via wildcard rules. */
  source: string | null;
  /**
   * From the lead's pipeline → company. Optional because not every
   * lead is associated with a company yet (manual-create path).
   */
  companyId: string | null;
  /** Same caveat as companyId. */
  countryId: string | null;
  /**
   * Excluded from the candidate pool so a re-rotation never picks
   * the same agent. Null on a brand-new lead.
   */
  currentAssigneeId: string | null;
  /**
   * Optional correlation id propagated from the originating HTTP
   * request — written into the routing log so a future support
   * request can trace a decision back to its triggering call.
   */
  requestId?: string;
  /**
   * A5.5 — bypass the rule lookup entirely and route via the
   * tenant default strategy. Used by SLA breach reassignment:
   * when a lead breaches SLA, we don't want to send it back to
   * the same agent the rule originally targeted (the rule
   * already chose them and they failed). Setting this skips
   * step 1 of the orchestrator pipeline; everything else
   * (candidate filter, strategy pick, log write) is identical.
   */
  bypassRules?: boolean;
}

/**
 * One candidate that survived the filter pipeline. Strategies pick
 * at most one of these.
 *
 * Every numeric field is REQUIRED — the orchestrator synthesises
 * defaults (weight=1, activeLeadCount=0, lastAssignedAt=null) when
 * an `agent_capacities` row is missing, so strategies never need
 * to handle undefined.
 */
export interface RoutingCandidate {
  id: string;
  /** From agent_capacities.weight; clamped to >=1 by the orchestrator. */
  weight: number;
  /** From users.last_assigned_at. Null = never assigned via the engine. */
  lastAssignedAt: Date | null;
  /** Count of currently-assigned non-terminal leads. */
  activeLeadCount: number;
}

/**
 * Resolved rule = just the fields strategies actually consume from
 * the matched `distribution_rules` row. The orchestrator passes a
 * narrower object so strategies stay decoupled from the Prisma
 * model shape.
 */
export interface ResolvedRule {
  id: string;
  strategy: StrategyName;
  /** Required when strategy === 'specific_user', null otherwise. */
  targetUserId: string | null;
}

/** Strategy input. */
export interface PickInput {
  /** Survived the filter pipeline; orchestrator-curated. */
  candidates: readonly RoutingCandidate[];
  rule: ResolvedRule;
  /**
   * Optional injected RNG. Defaults to Math.random in production.
   * Tests pass a seedable generator so weighted-strategy results
   * are reproducible. The function must return a value in [0, 1).
   */
  rng?: () => number;
}

/** Strategy output. */
export interface PickOutput {
  /** The picked user, or null when the strategy declines (no eligible). */
  chosenUserId: string | null;
}

/** The strategy contract. Stateless, pure. */
export interface RoutingStrategy {
  readonly name: StrategyName;
  pick(input: PickInput): PickOutput;
}

/**
 * Standard reasons a candidate is excluded by the filter pipeline.
 * Recorded in `lead_routing_logs.excluded_reasons` keyed by user id
 * (e.g. `{"<uuid>": "out_of_office"}`). Defining the union here
 * keeps the UI + the writer in lock-step.
 */
export type ExclusionReason =
  | 'not_eligible_role'
  | 'inactive_user'
  | 'excluded_by_caller'
  | 'wrong_team'
  | 'unavailable'
  | 'out_of_office'
  | 'outside_working_hours'
  | 'at_capacity';

export const ALL_EXCLUSION_REASONS: readonly ExclusionReason[] = [
  'not_eligible_role',
  'inactive_user',
  'excluded_by_caller',
  'wrong_team',
  'unavailable',
  'out_of_office',
  'outside_working_hours',
  'at_capacity',
] as const;

/** Routing log row — what the orchestrator returns + persists. */
export interface RoutingDecision {
  ruleId: string | null;
  strategy: StrategyName;
  chosenUserId: string | null;
  candidateCount: number;
  excludedCount: number;
  excludedReasons: Record<string, ExclusionReason>;
}
