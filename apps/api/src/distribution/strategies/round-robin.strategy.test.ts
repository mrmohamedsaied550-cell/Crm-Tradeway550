/**
 * Phase 1A — A3: RoundRobinStrategy unit tests.
 * Pure: no DB, no Nest, no Prisma.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { RoutingCandidate, ResolvedRule } from '../distribution.types';
import { RoundRobinStrategy } from './round-robin.strategy';

const strategy = new RoundRobinStrategy();
const rule: ResolvedRule = { id: 'rule-rr', strategy: 'round_robin', targetUserId: null };

function candidate(id: string, lastAssignedAt: Date | null, activeLeadCount = 0): RoutingCandidate {
  return { id, weight: 1, lastAssignedAt, activeLeadCount };
}

describe('RoundRobinStrategy (A3)', () => {
  it('picks the candidate with the OLDEST lastAssignedAt', () => {
    const result = strategy.pick({
      rule,
      candidates: [
        candidate('alice', new Date('2026-05-01T10:00:00Z')),
        candidate('bob', new Date('2026-05-01T08:00:00Z')), // oldest
        candidate('carol', new Date('2026-05-01T12:00:00Z')),
      ],
    });
    assert.equal(result.chosenUserId, 'bob');
  });

  it('treats NULL lastAssignedAt as oldest (new agents enter rotation first)', () => {
    const result = strategy.pick({
      rule,
      candidates: [
        candidate('alice', new Date('2026-05-01T08:00:00Z')),
        candidate('bob', null), // NULL beats any real date
        candidate('carol', new Date('2026-05-01T07:00:00Z')),
      ],
    });
    assert.equal(result.chosenUserId, 'bob');
  });

  it('tiebreaks by ascending user id when timestamps are equal', () => {
    const t = new Date('2026-05-01T10:00:00Z');
    const result = strategy.pick({
      rule,
      candidates: [candidate('charlie', t), candidate('alice', t), candidate('bob', t)],
    });
    assert.equal(result.chosenUserId, 'alice');
  });

  it('tiebreaks by ascending user id when ALL lastAssignedAt are NULL', () => {
    const result = strategy.pick({
      rule,
      candidates: [candidate('zeta', null), candidate('alpha', null), candidate('mu', null)],
    });
    assert.equal(result.chosenUserId, 'alpha');
  });

  it('rotates correctly across three sequential picks (manual simulation)', () => {
    // Simulate 3 sequential autoAssigns where each pick updates
    // the chosen user's lastAssignedAt to "now" before the next call.
    let now = new Date('2026-05-01T10:00:00Z');
    const pool = [candidate('alice', null), candidate('bob', null), candidate('carol', null)];

    const order: string[] = [];
    for (let i = 0; i < 3; i++) {
      const result = strategy.pick({ rule, candidates: pool });
      const winner = pool.find((c) => c.id === result.chosenUserId)!;
      order.push(winner.id);
      // Advance the winner's clock; the orchestrator does this in the
      // tx that persists the assignment.
      winner.lastAssignedAt = new Date(now.getTime());
      now = new Date(now.getTime() + 1000);
    }
    // Tiebreak picks alpha first, then bob, then carol.
    assert.deepEqual(order, ['alice', 'bob', 'carol']);
  });

  it('returns null on empty candidate list', () => {
    const result = strategy.pick({ rule, candidates: [] });
    assert.equal(result.chosenUserId, null);
  });

  it('does not mutate the input candidates array', () => {
    const candidates: RoutingCandidate[] = [
      candidate('zeta', new Date('2026-05-01T10:00:00Z')),
      candidate('alpha', new Date('2026-05-01T08:00:00Z')),
    ];
    const before = candidates.map((c) => c.id);
    strategy.pick({ rule, candidates });
    const after = candidates.map((c) => c.id);
    assert.deepEqual(after, before, 'input order must be preserved');
  });
});
