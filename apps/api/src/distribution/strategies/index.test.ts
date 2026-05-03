/**
 * Phase 1A — A3: strategy registry tests.
 *
 * Asserts that the registry covers every strategy enum value
 * defined in distribution.types.ts and that getStrategy() throws
 * on an unknown name. Drift between the enum and the registry
 * is the most likely future regression — this test catches it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ALL_STRATEGY_NAMES } from '../distribution.types';
import { STRATEGIES, getStrategy } from './index';

describe('strategy registry (A3)', () => {
  it('registers every name listed in ALL_STRATEGY_NAMES', () => {
    for (const name of ALL_STRATEGY_NAMES) {
      const s = STRATEGIES[name];
      assert.ok(s, `missing strategy implementation for "${name}"`);
      assert.equal(s.name, name, `strategy "${name}" reports wrong name`);
    }
  });

  it('getStrategy returns the singleton for each known name', () => {
    for (const name of ALL_STRATEGY_NAMES) {
      const a = getStrategy(name);
      const b = getStrategy(name);
      assert.equal(a, b, 'getStrategy must return the same singleton');
    }
  });

  it('getStrategy throws on an unknown name (programmer error)', () => {
    assert.throws(
      // Forced cast: the runtime check is the contract under test.
      () => getStrategy('made_up' as unknown as 'specific_user'),
      /Unknown strategy/,
    );
  });
});
