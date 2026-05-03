/**
 * Phase 1A — A3: SpecificUserStrategy unit tests.
 * Pure: no DB, no Nest, no Prisma.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { RoutingCandidate, ResolvedRule } from '../distribution.types';
import { SpecificUserStrategy } from './specific-user.strategy';

const strategy = new SpecificUserStrategy();

function rule(targetUserId: string | null): ResolvedRule {
  return { id: 'rule-1', strategy: 'specific_user', targetUserId };
}

function candidate(id: string): RoutingCandidate {
  return { id, weight: 1, lastAssignedAt: null, activeLeadCount: 0 };
}

describe('SpecificUserStrategy (A3)', () => {
  it('returns the target when present in the candidate pool', () => {
    const result = strategy.pick({
      rule: rule('alice'),
      candidates: [candidate('alice'), candidate('bob')],
    });
    assert.equal(result.chosenUserId, 'alice');
  });

  it('returns null when the target was filtered out by the orchestrator', () => {
    // The target has been removed from the pool (e.g. on holiday).
    const result = strategy.pick({
      rule: rule('alice'),
      candidates: [candidate('bob'), candidate('carol')],
    });
    assert.equal(result.chosenUserId, null);
  });

  it('returns null when the rule has no target', () => {
    const result = strategy.pick({
      rule: rule(null),
      candidates: [candidate('alice'), candidate('bob')],
    });
    assert.equal(result.chosenUserId, null);
  });

  it('returns null on empty candidate list', () => {
    const result = strategy.pick({
      rule: rule('alice'),
      candidates: [],
    });
    assert.equal(result.chosenUserId, null);
  });

  it('exposes the correct strategy name', () => {
    assert.equal(strategy.name, 'specific_user');
  });
});
