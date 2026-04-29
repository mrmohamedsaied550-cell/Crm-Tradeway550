/**
 * C27 — `isProduction(env)` helper. Tested by passing an explicit env
 * object so the suite never mutates `process.env`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isProduction } from './env';

describe('common/env — isProduction', () => {
  it('returns true only when NODE_ENV is exactly "production"', () => {
    assert.equal(isProduction({ NODE_ENV: 'production' }), true);
    assert.equal(isProduction({ NODE_ENV: 'Production' }), false);
    assert.equal(isProduction({ NODE_ENV: 'staging' }), false);
    assert.equal(isProduction({ NODE_ENV: 'development' }), false);
    assert.equal(isProduction({ NODE_ENV: 'test' }), false);
    assert.equal(isProduction({}), false);
  });
});
