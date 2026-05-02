import type { PickInput, PickOutput, RoutingStrategy } from '../distribution.types';

/**
 * Phase 1A — `specific_user` strategy.
 *
 * Returns the rule's `targetUserId` if (and only if) that user
 * survived the orchestrator's filter pipeline (i.e. appears in the
 * candidates list). The intentional consequence: an admin's
 * "always route Meta-EG to Alice" rule silently degrades to
 * round-robin (via the no-rule fallback) if Alice is on holiday.
 *
 * Returns null when:
 *   - the rule is misconfigured (targetUserId is null), or
 *   - the named user isn't eligible right now.
 *
 * The orchestrator interprets a null return as "this strategy
 * didn't pick" and may apply the tenant-default fallback strategy
 * (capacity / round_robin / weighted) — see DistributionService.
 */
export class SpecificUserStrategy implements RoutingStrategy {
  readonly name = 'specific_user' as const;

  pick(input: PickInput): PickOutput {
    const { rule, candidates } = input;
    if (!rule.targetUserId) return { chosenUserId: null };
    const found = candidates.find((c) => c.id === rule.targetUserId);
    return { chosenUserId: found ? found.id : null };
  }
}
