/**
 * Phase 1A — A4: candidate filter pipeline.
 *
 * Pure function — takes a raw candidate pool + the rule's
 * constraints + the per-user capacity rows, returns the surviving
 * RoutingCandidate list and the per-user exclusion reasons.
 *
 * Filter order (short-circuit on first failure):
 *   1. inactive_user           — status !== 'active'
 *   2. not_eligible_role       — role.code not in ELIGIBLE_ROLE_CODES
 *   3. excluded_by_caller      — id in excludeUserIds (e.g. current assignee)
 *   4. wrong_team              — rule.targetTeamId set AND user.teamId !== it
 *   5. unavailable             — capacity.isAvailable === false
 *   6. out_of_office           — capacity.outOfOfficeUntil > now
 *   7. at_capacity             — capacity.maxActiveLeads != null AND
 *                                activeLeadCount >= max
 *
 * Working-hours filter is intentionally NOT in A4 — it requires
 * tz-aware time-of-day arithmetic. The schema column is in place
 * (agent_capacities.working_hours JSONB); the filter implementation
 * is deferred to a follow-up commit. Until then, working_hours is
 * simply ignored.
 */

import type { ExclusionReason, RoutingCandidate } from './distribution.types';

import type { EffectiveCapacity } from './capacities.service';

const ELIGIBLE_ROLE_CODES = new Set(['sales_agent', 'tl_sales']);

export interface RawCandidate {
  id: string;
  status: string;
  roleCode: string;
  teamId: string | null;
  lastAssignedAt: Date | null;
  capacity: EffectiveCapacity;
  activeLeadCount: number;
}

export interface FilterOptions {
  /** Rule-driven team restriction; null = no team constraint. */
  ruleTargetTeamId: string | null;
  /** Caller-driven exclusions (e.g. current assignee on rotation). */
  excludeUserIds: readonly string[];
  /** Reference time for OOF / working-hours checks. */
  now: Date;
}

export interface FilterResult {
  surviving: RoutingCandidate[];
  excluded: Record<string, ExclusionReason>;
}

export function filterCandidates(
  candidates: readonly RawCandidate[],
  opts: FilterOptions,
): FilterResult {
  const exclude = new Set(opts.excludeUserIds);
  const surviving: RoutingCandidate[] = [];
  const excluded: Record<string, ExclusionReason> = {};

  for (const c of candidates) {
    const reason = classify(c, opts, exclude);
    if (reason) {
      excluded[c.id] = reason;
      continue;
    }
    surviving.push({
      id: c.id,
      weight: c.capacity.weight,
      lastAssignedAt: c.lastAssignedAt,
      activeLeadCount: c.activeLeadCount,
    });
  }
  return { surviving, excluded };
}

/**
 * Returns the FIRST exclusion reason that matches, or null when the
 * candidate survives the pipeline. Order matches the docstring.
 */
function classify(
  c: RawCandidate,
  opts: FilterOptions,
  excludeSet: Set<string>,
): ExclusionReason | null {
  if (c.status !== 'active') return 'inactive_user';
  if (!ELIGIBLE_ROLE_CODES.has(c.roleCode)) return 'not_eligible_role';
  if (excludeSet.has(c.id)) return 'excluded_by_caller';
  if (opts.ruleTargetTeamId !== null && c.teamId !== opts.ruleTargetTeamId) {
    return 'wrong_team';
  }
  if (!c.capacity.isAvailable) return 'unavailable';
  if (c.capacity.outOfOfficeUntil && c.capacity.outOfOfficeUntil > opts.now) {
    return 'out_of_office';
  }
  if (c.capacity.maxActiveLeads !== null && c.activeLeadCount >= c.capacity.maxActiveLeads) {
    return 'at_capacity';
  }
  // working_hours filter intentionally deferred.
  return null;
}
