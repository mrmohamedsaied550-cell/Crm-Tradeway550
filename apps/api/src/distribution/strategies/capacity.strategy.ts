import type { PickInput, PickOutput, RoutingStrategy } from '../distribution.types';

/**
 * Phase 1A — `capacity` strategy.
 *
 * Picks the candidate with the LOWEST current `activeLeadCount`.
 * This is the load-balancing strategy that matches today's
 * pre-Phase-1 behaviour (which was mislabelled as "round_robin"
 * in the legacy code — actual turn-based RR now lives in
 * round-robin.strategy.ts).
 *
 * Tiebreak: lexicographically smallest user id wins. Fully
 * deterministic given the candidate inputs, so route decisions are
 * reproducible in audit + test.
 *
 * Edge cases:
 *   - Empty candidates → null.
 *   - All candidates have the same activeLeadCount → picks the
 *     smallest id, which gives a stable but slightly biased
 *     rotation. For a fairness improvement on equal load, the
 *     operator should pick `round_robin` strategy explicitly.
 */
export class CapacityStrategy implements RoutingStrategy {
  readonly name = 'capacity' as const;

  pick(input: PickInput): PickOutput {
    const { candidates } = input;
    if (candidates.length === 0) return { chosenUserId: null };

    // Sort ascending by (activeLeadCount, id). Don't mutate input.
    const sorted = [...candidates].sort((a, b) => {
      const diff = a.activeLeadCount - b.activeLeadCount;
      if (diff !== 0) return diff;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    return { chosenUserId: sorted[0]!.id };
  }
}
