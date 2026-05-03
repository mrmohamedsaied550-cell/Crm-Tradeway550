/**
 * Phase 1A — A3: CapacityStrategy unit tests.
 * Pure: no DB, no Nest, no Prisma.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { RoutingCandidate, ResolvedRule } from '../distribution.types';
import { CapacityStrategy } from './capacity.strategy';

const strategy = new CapacityStrategy();
const rule: ResolvedRule = { id: 'rule-cap', strategy: 'capacity', targetUserId: null };

function candidate(id: string, activeLeadCount: number): RoutingCandidate {
  return { id, weight: 1, lastAssignedAt: null, activeLeadCount };
}

describe('CapacityStrategy (A3)', () => {
  it('picks the candidate with the LOWEST activeLeadCount', () => {
    const result = strategy.pick({
      rule,
      candidates: [candidate('alice', 5), candidate('bob', 2), candidate('carol', 7)],
    });
    assert.equal(result.chosenUserId, 'bob');
  });

  it('tiebreaks by ascending user id when counts are equal', () => {
    const result = strategy.pick({
      rule,
      candidates: [candidate('zeta', 3), candidate('alpha', 3), candidate('mu', 3)],
    });
    assert.equal(result.chosenUserId, 'alpha');
  });

  it('prefers a fresh agent (count=0) over a busy one (count=10)', () => {
    const result = strategy.pick({
      rule,
      candidates: [candidate('alice', 10), candidate('bob', 0)],
    });
    assert.equal(result.chosenUserId, 'bob');
  });

  it('returns null on empty candidate list', () => {
    const result = strategy.pick({ rule, candidates: [] });
    assert.equal(result.chosenUserId, null);
  });

  it('handles a single candidate', () => {
    const result = strategy.pick({ rule, candidates: [candidate('alice', 99)] });
    assert.equal(result.chosenUserId, 'alice');
  });

  it('does not mutate the input candidates array', () => {
    const candidates: RoutingCandidate[] = [candidate('zeta', 1), candidate('alpha', 5)];
    const before = candidates.map((c) => c.id);
    strategy.pick({ rule, candidates });
    assert.deepEqual(
      candidates.map((c) => c.id),
      before,
      'input order must be preserved',
    );
  });

  it('exposes the correct strategy name', () => {
    assert.equal(strategy.name, 'capacity');
  });
});
