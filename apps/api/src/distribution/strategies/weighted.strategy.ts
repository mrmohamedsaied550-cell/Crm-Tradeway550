import type { PickInput, PickOutput, RoutingStrategy } from '../distribution.types';

/**
 * Phase 1A — `weighted` strategy.
 *
 * Probabilistic: each candidate's chance of being picked is
 * proportional to its `weight` value (from `agent_capacities.weight`,
 * default 1). Useful for "senior reps get more leads" or "the new
 * starter gets fewer until they ramp up" scenarios.
 *
 * Algorithm — classic weighted-roulette:
 *   1. Sum all weights.
 *   2. Draw a random number in [0, total).
 *   3. Walk the candidates accumulating weight; the first whose
 *      running total exceeds the draw is the winner.
 *
 * Determinism for tests: the orchestrator can inject a seedable
 * RNG via `input.rng`; in production we default to `Math.random`.
 * (For low-stakes routing decisions Math.random's quality is
 * fine; cryptographic randomness would be overkill.)
 *
 * Edge cases:
 *   - Empty candidates → null.
 *   - All candidates have weight 0 → falls back to picking the
 *     first candidate (sorted by id) so we never return null
 *     when SOMEONE could take the lead. Logged warning would be
 *     overkill — operators see weight=0 in the capacities UI.
 *   - Negative weights → clamped to 0 by the orchestrator before
 *     this strategy ever sees them.
 */
export class WeightedStrategy implements RoutingStrategy {
  readonly name = 'weighted' as const;

  pick(input: PickInput): PickOutput {
    const { candidates } = input;
    if (candidates.length === 0) return { chosenUserId: null };

    // Sort by id once so the weight=0 fallback is deterministic.
    // The weighted draw doesn't care about order — `walk` accumulates
    // monotonically — so sorting up-front is free.
    const sorted = [...candidates].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    const total = sorted.reduce((sum, c) => sum + c.weight, 0);
    if (total <= 0) {
      // Degenerate: every candidate has weight 0. Fall back to the
      // first by id so the strategy still produces an answer.
      return { chosenUserId: sorted[0]!.id };
    }

    const rng = input.rng ?? Math.random;
    const draw = rng() * total;

    let acc = 0;
    for (const c of sorted) {
      acc += c.weight;
      if (draw < acc) return { chosenUserId: c.id };
    }
    // Numerical edge case: rng() returned exactly 1 - epsilon and
    // accumulated rounding pushed `acc` just under `draw`. The last
    // candidate wins by construction.
    return { chosenUserId: sorted[sorted.length - 1]!.id };
  }
}
