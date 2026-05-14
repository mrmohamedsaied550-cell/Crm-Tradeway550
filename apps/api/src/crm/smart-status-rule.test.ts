/**
 * Sprint 1 (D6.1) — Smart Status Rule schema unit tests.
 *
 * Pure schema-shape tests; no DB / Nest container. Verifies:
 *
 *   1. The pre-Sprint-1 minimum shape (`{ code, label, labelAr }`)
 *      still parses unchanged. This is the **backward-compat**
 *      contract every existing tenant's `allowed_statuses` JSONB
 *      depends on — any regression here breaks D3.3's picker for
 *      every tenant on main.
 *
 *   2. Every new Smart Status Rule field is OPTIONAL — an entry
 *      that omits all of them is valid.
 *
 *   3. Every Smart Status Rule field round-trips when set.
 *
 *   4. The strict-keys policy still holds — an unknown key on the
 *      entry is rejected. (Protects against typos like
 *      `requiresFollowup` vs `requiresFollowUp` silently flipping
 *      to default behaviour at runtime.)
 *
 *   5. `defaultDueTime` rejects non-`HH:MM` strings.
 *
 *   6. `defaultDueOffsetMinutes` rejects 0 / negative values.
 *
 *   7. `LIFECYCLE_CATEGORIES` is the exact 4-value journey set.
 *
 *   8. `parseAllowedStatusesJson` accepts arrays mixing old and
 *      new entry shapes (this is the realistic on-disk state
 *      during the rollout window before admins fill smart-rule
 *      fields in).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  AllowedStatusEntrySchema,
  CLOSE_JOURNEY_TYPES,
  LIFECYCLE_CATEGORIES,
  SmartStatusRuleSchema,
  parseAllowedStatusesJson,
} from './lead-stage-status.dto';

describe('smart-status-rule schema — backward compatibility', () => {
  it('accepts a pre-Sprint-1 minimum entry (code + label + labelAr)', () => {
    const result = AllowedStatusEntrySchema.safeParse({
      code: 'interested',
      label: 'Interested',
      labelAr: 'مهتم',
    });
    assert.equal(result.success, true);
  });

  it('accepts an array of pre-Sprint-1 minimum entries via parseAllowedStatusesJson', () => {
    const parsed = parseAllowedStatusesJson([
      { code: 'interested', label: 'Interested', labelAr: 'مهتم' },
      { code: 'not_interested', label: 'Not interested', labelAr: 'غير مهتم' },
    ]);
    assert.equal(parsed.ok, true);
    if (parsed.ok) assert.equal(parsed.statuses.length, 2);
  });

  it('accepts a mixed array (some entries with rule metadata, some without)', () => {
    const parsed = parseAllowedStatusesJson([
      { code: 'interested', label: 'Interested', labelAr: 'مهتم' },
      {
        code: 'no_answer_1',
        label: 'No answer (1st)',
        labelAr: 'لم يرد (المحاولة الأولى)',
        requiresFollowUp: true,
        defaultNextActionTitle: 'Call again',
        defaultDueOffsetMinutes: 60,
        nextStatusCode: 'no_answer_2',
      },
    ]);
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal(parsed.statuses[0]?.requiresFollowUp, undefined);
      assert.equal(parsed.statuses[1]?.requiresFollowUp, true);
      assert.equal(parsed.statuses[1]?.nextStatusCode, 'no_answer_2');
    }
  });
});

describe('smart-status-rule schema — additive fields', () => {
  it('every Smart Status Rule field is OPTIONAL (empty rule parses)', () => {
    assert.equal(SmartStatusRuleSchema.safeParse({}).success, true);
  });

  it('round-trips every Smart Status Rule field when set', () => {
    const rule = {
      requiresFollowUp: true,
      defaultNextActionTitle: 'Call back tomorrow',
      defaultDueOffsetMinutes: 1440,
      defaultDueTime: '10:00',
      requiresReason: true,
      reasonGroup: 'lost_reasons',
      closeJourney: true,
      closeType: 'lost' as const,
      autoMoveStage: true,
      nextStageCode: 'lost',
      nextStatusCode: 'rejected_by_agent',
      convertToCaptain: false,
      requiresApproval: true,
      requiredChecks: ['documents_accepted', 'partner_verified'],
    };
    const result = SmartStatusRuleSchema.safeParse(rule);
    assert.equal(result.success, true);
    if (result.success) {
      assert.deepEqual(result.data, rule);
    }
  });

  it('accepts a full entry with all rule fields on AllowedStatusEntrySchema', () => {
    const result = AllowedStatusEntrySchema.safeParse({
      code: 'signup_link_sent',
      label: 'Signup link sent',
      labelAr: 'تم إرسال رابط التسجيل',
      requiresFollowUp: true,
      defaultNextActionTitle: 'Confirm signup started',
      defaultDueOffsetMinutes: 1440,
      autoMoveStage: true,
      nextStageCode: 'signup',
      nextStatusCode: 'signup_link_sent',
    });
    assert.equal(result.success, true);
  });
});

describe('smart-status-rule schema — invariants', () => {
  it('rejects an unknown key on the entry (strict-keys)', () => {
    const result = AllowedStatusEntrySchema.safeParse({
      code: 'interested',
      label: 'Interested',
      labelAr: 'مهتم',
      // typo — must NOT silently default to off
      requiresFollowup: true,
    });
    assert.equal(result.success, false);
  });

  it('rejects defaultDueTime that is not HH:MM (24h)', () => {
    for (const bad of ['25:00', '10:60', '9:00', '10', 'abc', '10:5']) {
      const result = SmartStatusRuleSchema.safeParse({ defaultDueTime: bad });
      assert.equal(
        result.success,
        false,
        `expected defaultDueTime=${JSON.stringify(bad)} to be rejected`,
      );
    }
    for (const good of ['00:00', '09:00', '10:30', '23:59']) {
      const result = SmartStatusRuleSchema.safeParse({ defaultDueTime: good });
      assert.equal(
        result.success,
        true,
        `expected defaultDueTime=${JSON.stringify(good)} to be accepted`,
      );
    }
  });

  it('rejects defaultDueOffsetMinutes ≤ 0', () => {
    for (const bad of [0, -1, -60]) {
      assert.equal(
        SmartStatusRuleSchema.safeParse({ defaultDueOffsetMinutes: bad }).success,
        false,
      );
    }
  });

  it('rejects closeType outside the lost / rejected / not_qualified set', () => {
    assert.equal(SmartStatusRuleSchema.safeParse({ closeType: 'won' }).success, false);
    assert.equal(SmartStatusRuleSchema.safeParse({ closeType: 'wrong_number' }).success, false);
  });

  it('caps requiredChecks at 16 entries', () => {
    const ok = Array.from({ length: 16 }, (_, i) => `check_${i}`);
    const tooMany = [...ok, 'overflow'];
    assert.equal(SmartStatusRuleSchema.safeParse({ requiredChecks: ok }).success, true);
    assert.equal(SmartStatusRuleSchema.safeParse({ requiredChecks: tooMany }).success, false);
  });
});

describe('smart-status-rule schema — lifecycle categories', () => {
  it('LIFECYCLE_CATEGORIES is exactly the agreed 4-step journey', () => {
    assert.deepEqual([...LIFECYCLE_CATEGORIES], ['fresh_lead', 'signup', 'active', 'dft']);
  });

  it('CLOSE_JOURNEY_TYPES is exactly lost / rejected / not_qualified', () => {
    assert.deepEqual([...CLOSE_JOURNEY_TYPES], ['lost', 'rejected', 'not_qualified']);
  });
});
