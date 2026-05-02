import type {
  PickInput,
  PickOutput,
  RoutingCandidate,
  RoutingStrategy,
} from '../distribution.types';

/**
 * Phase 1A — `round_robin` strategy.
 *
 * TRUE turn-based round-robin. Picks the candidate with the OLDEST
 * `lastAssignedAt` timestamp. NULL is treated as "older than any
 * date" so brand-new agents enter the rotation first — they get
 * leads until their `lastAssignedAt` catches up to the rest.
 *
 * Tiebreak: when two candidates share the same `lastAssignedAt`
 * (or both are NULL), the lexicographically smallest user id wins.
 * This makes the strategy fully deterministic given DB state, which
 * is critical for both auditability and test reproducibility.
 *
 * The orchestrator updates `users.last_assigned_at` after a
 * successful assignment so the next route call sees the rotation
 * advance.
 */
export class RoundRobinStrategy implements RoutingStrategy {
  readonly name = 'round_robin' as const;

  pick(input: PickInput): PickOutput {
    const { candidates } = input;
    if (candidates.length === 0) return { chosenUserId: null };

    // Sort ascending by (lastAssignedAt NULL-first, then id). The
    // first element after sort is the oldest, breaking ties by id.
    // NB: not mutating the input; we operate on a copy.
    const sorted = [...candidates].sort(compareByOldestThenId);
    return { chosenUserId: sorted[0]!.id };
  }
}

/**
 * NULL `lastAssignedAt` sorts before any real date (treated as
 * "older than the universe"). Equal timestamps fall through to a
 * lexicographic id compare for determinism.
 */
function compareByOldestThenId(a: RoutingCandidate, b: RoutingCandidate): number {
  // NULL beats non-NULL.
  if (a.lastAssignedAt === null && b.lastAssignedAt !== null) return -1;
  if (a.lastAssignedAt !== null && b.lastAssignedAt === null) return 1;
  // Both null OR both non-null.
  if (a.lastAssignedAt !== null && b.lastAssignedAt !== null) {
    const diff = a.lastAssignedAt.getTime() - b.lastAssignedAt.getTime();
    if (diff !== 0) return diff;
  }
  // Tiebreak by user id ascending.
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
