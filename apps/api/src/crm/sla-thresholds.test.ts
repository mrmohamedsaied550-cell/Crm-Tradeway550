/**
 * Phase D3 — D3.2: pure-unit tests for the SLA threshold ladder.
 *
 * No DB. No clock. The service is a pure function — every test feeds
 * a fixed `now` and `slaDueAt` and asserts the bucket is exactly what
 * the spec promises:
 *
 *     ratio < 0.75              → 'ok'
 *     0.75 ≤ ratio < 1.00       → 't75'
 *     1.00 ≤ ratio < 1.50       → 't100'
 *     1.50 ≤ ratio < 2.00       → 't150'
 *     ratio ≥ 2.00              → 't200'
 *
 * Edge cases covered:
 *   - exact boundaries (0.75, 1.00, 1.50, 2.00) round INTO the higher
 *     bucket — the comparison is `≥` on the lower bound.
 *   - just-below-100% stays in 't75' (0.999 ratio).
 *   - far-future slaDueAt = 'ok' (ratio clamped at 0).
 *   - paused / closed semantics: missing slaDueAt or non-positive
 *     budget returns `noOp = true` so the caller leaves the row
 *     untouched.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { SlaThresholdsService, bucketFromRatio } from './sla-thresholds.service';

let svc: SlaThresholdsService;
const NOW = new Date('2026-05-05T12:00:00.000Z');

/** Build an `slaDueAt` such that elapsed/budget = `ratio`. */
function dueAtForRatio(ratio: number, budgetMinutes: number, now: Date = NOW): Date {
  const budgetMs = budgetMinutes * 60_000;
  const elapsedMs = ratio * budgetMs;
  // slaDueAt = now + (budget - elapsed)
  return new Date(now.getTime() + (budgetMs - elapsedMs));
}

describe('D3.2 — bucketFromRatio (pure)', () => {
  it('ratio just below 0.75 is ok', () => {
    assert.equal(bucketFromRatio(0.7499), 'ok');
  });
  it('ratio exactly 0.75 is t75 (inclusive lower bound)', () => {
    assert.equal(bucketFromRatio(0.75), 't75');
  });
  it('ratio just below 1.0 is t75', () => {
    assert.equal(bucketFromRatio(0.999), 't75');
  });
  it('ratio exactly 1.0 is t100', () => {
    assert.equal(bucketFromRatio(1.0), 't100');
  });
  it('ratio exactly 1.49999 stays in t100', () => {
    assert.equal(bucketFromRatio(1.49999), 't100');
  });
  it('ratio exactly 1.5 is t150', () => {
    assert.equal(bucketFromRatio(1.5), 't150');
  });
  it('ratio exactly 2.0 is t200', () => {
    assert.equal(bucketFromRatio(2.0), 't200');
  });
  it('large ratio is still t200', () => {
    assert.equal(bucketFromRatio(99), 't200');
  });
  it('ratio = 0 is ok', () => {
    assert.equal(bucketFromRatio(0), 'ok');
  });
});

describe('D3.2 — SlaThresholdsService.computeBucket', () => {
  before(() => {
    svc = new SlaThresholdsService();
  });
  after(() => {
    /* nothing */
  });

  it('ratio < 0.75 → ok', () => {
    const result = svc.computeBucket({
      slaDueAt: dueAtForRatio(0.5, 60),
      budgetMinutes: 60,
      now: NOW,
    });
    assert.equal(result.threshold, 'ok');
    assert.equal(result.noOp, false);
    assert.ok(Math.abs(result.ratio - 0.5) < 1e-6);
    assert.equal(result.budgetMinutes, 60);
  });

  it('ratio = 0.75 → t75', () => {
    const result = svc.computeBucket({
      slaDueAt: dueAtForRatio(0.75, 60),
      budgetMinutes: 60,
      now: NOW,
    });
    assert.equal(result.threshold, 't75');
    assert.equal(result.noOp, false);
  });

  it('ratio = 0.99 → t75', () => {
    const result = svc.computeBucket({
      slaDueAt: dueAtForRatio(0.99, 60),
      budgetMinutes: 60,
      now: NOW,
    });
    assert.equal(result.threshold, 't75');
  });

  it('ratio = 1.0 → t100', () => {
    const result = svc.computeBucket({
      slaDueAt: dueAtForRatio(1.0, 60),
      budgetMinutes: 60,
      now: NOW,
    });
    assert.equal(result.threshold, 't100');
  });

  it('ratio = 1.5 → t150', () => {
    const result = svc.computeBucket({
      slaDueAt: dueAtForRatio(1.5, 60),
      budgetMinutes: 60,
      now: NOW,
    });
    assert.equal(result.threshold, 't150');
  });

  it('ratio = 2.0 → t200', () => {
    const result = svc.computeBucket({
      slaDueAt: dueAtForRatio(2.0, 60),
      budgetMinutes: 60,
      now: NOW,
    });
    assert.equal(result.threshold, 't200');
  });

  it('huge overdue → t200', () => {
    const result = svc.computeBucket({
      slaDueAt: new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000),
      budgetMinutes: 60,
      now: NOW,
    });
    assert.equal(result.threshold, 't200');
    assert.ok(result.ratio > 100);
  });

  it('null slaDueAt → noOp', () => {
    const result = svc.computeBucket({ slaDueAt: null, budgetMinutes: 60, now: NOW });
    assert.equal(result.noOp, true);
    assert.equal(result.threshold, 'ok');
  });

  it('null budget → noOp', () => {
    const result = svc.computeBucket({
      slaDueAt: dueAtForRatio(1.5, 60),
      budgetMinutes: null,
      now: NOW,
    });
    assert.equal(result.noOp, true);
  });

  it('zero budget → noOp', () => {
    const result = svc.computeBucket({
      slaDueAt: dueAtForRatio(1.5, 60),
      budgetMinutes: 0,
      now: NOW,
    });
    assert.equal(result.noOp, true);
  });

  it('negative budget → noOp', () => {
    const result = svc.computeBucket({
      slaDueAt: dueAtForRatio(1.5, 60),
      budgetMinutes: -10,
      now: NOW,
    });
    assert.equal(result.noOp, true);
  });

  it('slaDueAt far in the future (negative elapsed) clamps to ratio=0', () => {
    const result = svc.computeBucket({
      slaDueAt: new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000),
      budgetMinutes: 60,
      now: NOW,
    });
    assert.equal(result.threshold, 'ok');
    assert.equal(result.ratio, 0);
    assert.equal(result.elapsedMinutes, 0);
    assert.equal(result.noOp, false);
  });

  it('elapsedMinutes is rounded for reporting', () => {
    const result = svc.computeBucket({
      slaDueAt: dueAtForRatio(1.5, 60),
      budgetMinutes: 60,
      now: NOW,
    });
    // 1.5 * 60 = 90 minutes elapsed.
    assert.equal(result.elapsedMinutes, 90);
  });
});
