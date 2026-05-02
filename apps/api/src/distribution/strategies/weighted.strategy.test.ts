/**
 * Phase 1A — A3: WeightedStrategy unit tests.
 * Pure: no DB. Uses a seedable RNG (mulberry32) so the
 * probabilistic tests are reproducible.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { RoutingCandidate, ResolvedRule } from '../distribution.types';
import { WeightedStrategy } from './weighted.strategy';

const strategy = new WeightedStrategy();
const rule: ResolvedRule = { id: 'rule-w', strategy: 'weighted', targetUserId: null };

function candidate(id: string, weight: number): RoutingCandidate {
  return { id, weight, lastAssignedAt: null, activeLeadCount: 0 };
}

/**
 * Mulberry32 — small, fast, seedable PRNG. Plenty of quality for a
 * test-only weighted-distribution check; not for production.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function (): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Constant RNG for the deterministic single-draw cases. */
function fixedRng(value: number): () => number {
  return () => value;
}

describe('WeightedStrategy (A3)', () => {
  it('with weights [1, 1] and rng=0.0 picks the first (id-sorted)', () => {
    const result = strategy.pick({
      rule,
      candidates: [candidate('alice', 1), candidate('bob', 1)],
      rng: fixedRng(0.0),
    });
    assert.equal(result.chosenUserId, 'alice');
  });

  it('with weights [1, 1] and rng=0.499 picks the first (under cumulative 0.5)', () => {
    const result = strategy.pick({
      rule,
      candidates: [candidate('alice', 1), candidate('bob', 1)],
      rng: fixedRng(0.499),
    });
    assert.equal(result.chosenUserId, 'alice');
  });

  it('with weights [1, 1] and rng=0.5 picks the second (cumulative boundary)', () => {
    const result = strategy.pick({
      rule,
      candidates: [candidate('alice', 1), candidate('bob', 1)],
      rng: fixedRng(0.5),
    });
    assert.equal(result.chosenUserId, 'bob');
  });

  it('honours weights heavily skewed: [1, 9] sends 90% to second over 1000 draws', () => {
    const rng = mulberry32(42);
    const counts: Record<string, number> = { alice: 0, bob: 0 };
    for (let i = 0; i < 1000; i++) {
      const result = strategy.pick({
        rule,
        candidates: [candidate('alice', 1), candidate('bob', 9)],
        rng,
      });
      counts[result.chosenUserId!]! += 1;
    }
    // Expected ~10% / ~90%. Allow ±5 percentage-point tolerance.
    const aliceShare = counts['alice']! / 1000;
    const bobShare = counts['bob']! / 1000;
    assert.ok(aliceShare > 0.05 && aliceShare < 0.15, `alice share out of band: ${aliceShare}`);
    assert.ok(bobShare > 0.85 && bobShare < 0.95, `bob share out of band: ${bobShare}`);
  });

  it('honours equal weights: [1, 1, 1] gives ~33% each over 1500 draws', () => {
    const rng = mulberry32(7);
    const counts: Record<string, number> = { alice: 0, bob: 0, carol: 0 };
    for (let i = 0; i < 1500; i++) {
      const result = strategy.pick({
        rule,
        candidates: [candidate('alice', 1), candidate('bob', 1), candidate('carol', 1)],
        rng,
      });
      counts[result.chosenUserId!]! += 1;
    }
    for (const [id, count] of Object.entries(counts)) {
      const share = count / 1500;
      assert.ok(share > 0.28 && share < 0.39, `${id} share out of band: ${share}`);
    }
  });

  it('all-zero weights: falls back to first candidate (id-sorted) deterministically', () => {
    const result = strategy.pick({
      rule,
      candidates: [candidate('zeta', 0), candidate('alpha', 0), candidate('mu', 0)],
      rng: fixedRng(0.5),
    });
    assert.equal(result.chosenUserId, 'alpha');
  });

  it('returns null on empty candidate list', () => {
    const result = strategy.pick({ rule, candidates: [] });
    assert.equal(result.chosenUserId, null);
  });

  it('handles a single candidate (returns it regardless of weight)', () => {
    const result = strategy.pick({
      rule,
      candidates: [candidate('alice', 5)],
      rng: fixedRng(0.999),
    });
    assert.equal(result.chosenUserId, 'alice');
  });

  it('does not mutate the input candidates array', () => {
    const candidates: RoutingCandidate[] = [candidate('zeta', 5), candidate('alpha', 1)];
    const before = candidates.map((c) => c.id);
    strategy.pick({ rule, candidates, rng: fixedRng(0.5) });
    assert.deepEqual(
      candidates.map((c) => c.id),
      before,
      'input order must be preserved',
    );
  });
});
