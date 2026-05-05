/**
 * Phase D2 — D2.2: DuplicateRulesService unit tests.
 *
 * Pure: no DB, no Nest, no Prisma. Exhaustive truth-table over the
 * locked product defaults and the configurable knobs.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_DUPLICATE_RULES, type DuplicateRulesConfig } from './duplicate-rules.dto';
import {
  DuplicateRulesService,
  type DuplicateContext,
  type MatchingCaptain,
  type MatchingLead,
} from './duplicate-rules.service';

const NOW = new Date('2026-06-15T12:00:00Z');
const NOW_MINUS_5_DAYS = new Date(NOW.getTime() - 5 * 24 * 60 * 60 * 1000);
const NOW_MINUS_10_DAYS = new Date(NOW.getTime() - 10 * 24 * 60 * 60 * 1000);
const NOW_MINUS_31_DAYS = new Date(NOW.getTime() - 31 * 24 * 60 * 60 * 1000);
const NOW_MINUS_100_DAYS = new Date(NOW.getTime() - 100 * 24 * 60 * 60 * 1000);

const PIPE_A = '11111111-1111-1111-1111-111111111111';
const PIPE_B = '22222222-2222-2222-2222-222222222222';
const COMPANY_A = '33333333-3333-3333-3333-333333333333';
const COMPANY_B = '44444444-4444-4444-4444-444444444444';

function context(overrides: Partial<DuplicateContext> = {}): DuplicateContext {
  return {
    phone: '+201234567890',
    trigger: 'manual',
    companyId: COMPANY_A,
    countryId: null,
    pipelineId: PIPE_A,
    actorUserId: 'user-1',
    ...overrides,
  };
}

function lead(overrides: Partial<MatchingLead> = {}): MatchingLead {
  return {
    id: overrides.id ?? 'lead-1',
    lifecycleState: 'open',
    stageCode: 'contacted',
    lostReasonCode: null,
    closedAt: null,
    pipelineId: PIPE_A,
    companyId: COMPANY_A,
    countryId: null,
    assignedToId: 'agent-1',
    attemptIndex: 1,
    ...overrides,
  };
}

function captain(overrides: Partial<MatchingCaptain> = {}): MatchingCaptain {
  return {
    id: overrides.id ?? 'cap-1',
    status: 'active',
    leadId: 'lead-old',
    ...overrides,
  };
}

function rules(overrides: Partial<DuplicateRulesConfig> = {}): DuplicateRulesConfig {
  return { ...DEFAULT_DUPLICATE_RULES, ...overrides };
}

const svc = new DuplicateRulesService();

describe('DuplicateRulesService.evaluate', () => {
  describe('no match', () => {
    it('returns create_first_attempt with high confidence', () => {
      const d = svc.evaluate({
        context: context(),
        matchingLeads: [],
        matchingCaptain: null,
        rules: rules(),
        now: NOW,
      });
      assert.equal(d.decision, 'create_first_attempt');
      assert.equal(d.ruleApplied, 'create_first_attempt');
      assert.equal(d.confidence, 'high');
      assert.equal(d.previousLeadId, null);
      assert.equal(d.matchedOpenLeadId, null);
      assert.equal(d.matchedCaptainId, null);
      assert.equal(d.recommendedOwnerStrategy, 'route_engine');
    });
  });

  describe('active captain match', () => {
    it('always queues for review (locked: captainBehavior=always_review)', () => {
      const d = svc.evaluate({
        context: context(),
        matchingLeads: [],
        matchingCaptain: captain(),
        rules: rules(),
        now: NOW,
      });
      assert.equal(d.decision, 'queue_review');
      assert.equal(d.ruleApplied, 'route_to_review_active_captain');
      assert.equal(d.matchedCaptainId, 'cap-1');
      assert.equal(d.confidence, 'high');
      assert.equal(d.recommendedOwnerStrategy, 'unassigned');
    });

    it('captain match dominates over an open lead match', () => {
      const d = svc.evaluate({
        context: context(),
        matchingLeads: [lead({ lifecycleState: 'open' })],
        matchingCaptain: captain(),
        rules: rules(),
        now: NOW,
      });
      assert.equal(d.decision, 'queue_review');
      assert.equal(d.ruleApplied, 'route_to_review_active_captain');
    });

    it('inactive captain does NOT trigger the captain rule', () => {
      const d = svc.evaluate({
        context: context(),
        matchingLeads: [],
        matchingCaptain: captain({ status: 'inactive' }),
        rules: rules(),
        now: NOW,
      });
      assert.equal(d.decision, 'create_first_attempt');
    });
  });

  describe('open-lead match', () => {
    it('manual trigger → reject_existing_open', () => {
      const d = svc.evaluate({
        context: context({ trigger: 'manual' }),
        matchingLeads: [lead({ lifecycleState: 'open', id: 'lead-open' })],
        matchingCaptain: null,
        rules: rules(),
        now: NOW,
      });
      assert.equal(d.decision, 'reject_existing_open');
      assert.equal(d.ruleApplied, 'reject_existing_open');
      assert.equal(d.matchedOpenLeadId, 'lead-open');
    });

    it('csv trigger → reject_existing_open', () => {
      const d = svc.evaluate({
        context: context({ trigger: 'csv' }),
        matchingLeads: [lead({ lifecycleState: 'open' })],
        matchingCaptain: null,
        rules: rules(),
        now: NOW,
      });
      assert.equal(d.decision, 'reject_existing_open');
    });

    it('meta trigger → reject_existing_open', () => {
      const d = svc.evaluate({
        context: context({ trigger: 'meta' }),
        matchingLeads: [lead({ lifecycleState: 'open' })],
        matchingCaptain: null,
        rules: rules(),
        now: NOW,
      });
      assert.equal(d.decision, 'reject_existing_open');
    });

    it('whatsapp_inbound trigger → link_to_existing', () => {
      const d = svc.evaluate({
        context: context({ trigger: 'whatsapp_inbound' }),
        matchingLeads: [lead({ lifecycleState: 'open', id: 'lead-open' })],
        matchingCaptain: null,
        rules: rules(),
        now: NOW,
      });
      assert.equal(d.decision, 'link_to_existing');
      assert.equal(d.ruleApplied, 'link_to_existing_open');
      assert.equal(d.matchedOpenLeadId, 'lead-open');
      assert.equal(d.recommendedOwnerStrategy, 'previous_owner');
    });

    it('review_resolve_new_lead trigger → link_to_existing', () => {
      const d = svc.evaluate({
        context: context({ trigger: 'review_resolve_new_lead' }),
        matchingLeads: [lead({ lifecycleState: 'open' })],
        matchingCaptain: null,
        rules: rules(),
        now: NOW,
      });
      assert.equal(d.decision, 'link_to_existing');
    });

    it('review_resolve_new_attempt trigger → link_to_existing', () => {
      const d = svc.evaluate({
        context: context({ trigger: 'review_resolve_new_attempt' }),
        matchingLeads: [lead({ lifecycleState: 'open' })],
        matchingCaptain: null,
        rules: rules(),
        now: NOW,
      });
      assert.equal(d.decision, 'link_to_existing');
    });
  });

  describe('won lead match (no active captain)', () => {
    it('always queues for review (locked: wonBehavior=always_review)', () => {
      const d = svc.evaluate({
        context: context(),
        matchingLeads: [
          lead({
            id: 'won-1',
            lifecycleState: 'won',
            closedAt: NOW_MINUS_100_DAYS,
          }),
        ],
        matchingCaptain: null,
        rules: rules(),
        now: NOW,
      });
      assert.equal(d.decision, 'queue_review');
      assert.equal(d.ruleApplied, 'route_to_review_won');
      assert.equal(d.confidence, 'high');
    });
  });

  describe('lost lead — cool-off rules', () => {
    it('lost > 30 days (default) → create_new_attempt', () => {
      const d = svc.evaluate({
        context: context(),
        matchingLeads: [
          lead({
            id: 'lost-old',
            lifecycleState: 'lost',
            closedAt: NOW_MINUS_31_DAYS,
            lostReasonCode: 'unqualified',
            assignedToId: 'agent-old',
          }),
        ],
        matchingCaptain: null,
        rules: rules(),
        now: NOW,
      });
      assert.equal(d.decision, 'create_new_attempt');
      assert.equal(d.ruleApplied, 'reactivate_lost_aged_out');
      assert.equal(d.previousLeadId, 'lost-old');
      assert.equal(d.confidence, 'high');
      // Default ownership strategy for reactivations is route_engine.
      assert.equal(d.recommendedOwnerStrategy, 'route_engine');
    });

    it('lost within 30 days (default) → queue_review (cooldown)', () => {
      const d = svc.evaluate({
        context: context(),
        matchingLeads: [
          lead({
            id: 'lost-recent',
            lifecycleState: 'lost',
            closedAt: NOW_MINUS_10_DAYS,
            lostReasonCode: 'unqualified',
          }),
        ],
        matchingCaptain: null,
        rules: rules(),
        now: NOW,
      });
      assert.equal(d.decision, 'queue_review');
      assert.equal(d.ruleApplied, 'route_to_review_cooldown');
      assert.equal(d.previousLeadId, 'lost-recent');
      assert.equal(d.confidence, 'medium');
    });

    it('lost as no_answer > 7 days → reactivate_no_answer_aged_out', () => {
      const d = svc.evaluate({
        context: context(),
        matchingLeads: [
          lead({
            id: 'lost-no-ans',
            lifecycleState: 'lost',
            closedAt: NOW_MINUS_10_DAYS,
            lostReasonCode: 'no_answer',
          }),
        ],
        matchingCaptain: null,
        rules: rules(),
        now: NOW,
      });
      assert.equal(d.decision, 'create_new_attempt');
      assert.equal(d.ruleApplied, 'reactivate_no_answer_aged_out');
    });

    it('lost as no_response > 7 days → reactivate_no_answer_aged_out (alt code)', () => {
      const d = svc.evaluate({
        context: context(),
        matchingLeads: [
          lead({
            lifecycleState: 'lost',
            closedAt: NOW_MINUS_10_DAYS,
            lostReasonCode: 'no_response',
          }),
        ],
        matchingCaptain: null,
        rules: rules(),
        now: NOW,
      });
      assert.equal(d.ruleApplied, 'reactivate_no_answer_aged_out');
    });

    it('lost as no_answer within 7 days → cooldown', () => {
      const d = svc.evaluate({
        context: context(),
        matchingLeads: [
          lead({
            lifecycleState: 'lost',
            closedAt: NOW_MINUS_5_DAYS,
            lostReasonCode: 'no_answer',
          }),
        ],
        matchingCaptain: null,
        rules: rules(),
        now: NOW,
      });
      assert.equal(d.decision, 'queue_review');
      assert.equal(d.ruleApplied, 'route_to_review_cooldown');
    });

    it('two historical lost leads → confidence=medium (heavy retry)', () => {
      const d = svc.evaluate({
        context: context(),
        matchingLeads: [
          lead({
            id: 'lost-old-1',
            lifecycleState: 'lost',
            closedAt: NOW_MINUS_100_DAYS,
            lostReasonCode: 'unqualified',
          }),
          lead({
            id: 'lost-old-2',
            lifecycleState: 'lost',
            closedAt: NOW_MINUS_31_DAYS,
            lostReasonCode: 'unqualified',
          }),
        ],
        matchingCaptain: null,
        rules: rules(),
        now: NOW,
      });
      assert.equal(d.decision, 'create_new_attempt');
      assert.equal(d.confidence, 'medium');
      // Most recent lost is the predecessor.
      assert.equal(d.previousLeadId, 'lost-old-2');
    });

    it('previous_owner ownership strategy is honoured when set', () => {
      const d = svc.evaluate({
        context: context(),
        matchingLeads: [
          lead({
            lifecycleState: 'lost',
            closedAt: NOW_MINUS_31_DAYS,
            lostReasonCode: 'unqualified',
          }),
        ],
        matchingCaptain: null,
        rules: rules({ ownershipOnReactivation: 'previous_owner' }),
        now: NOW,
      });
      assert.equal(d.recommendedOwnerStrategy, 'previous_owner');
    });

    it('unassigned ownership strategy is honoured when set', () => {
      const d = svc.evaluate({
        context: context(),
        matchingLeads: [
          lead({
            lifecycleState: 'lost',
            closedAt: NOW_MINUS_31_DAYS,
            lostReasonCode: 'unqualified',
          }),
        ],
        matchingCaptain: null,
        rules: rules({ ownershipOnReactivation: 'unassigned' }),
        now: NOW,
      });
      assert.equal(d.recommendedOwnerStrategy, 'unassigned');
    });
  });

  describe('crossPipelineMatch', () => {
    it('default (false): match in different pipeline → create_first_attempt with cross-pipeline rule', () => {
      const d = svc.evaluate({
        context: context({ pipelineId: PIPE_A }),
        matchingLeads: [
          lead({
            id: 'other-pipe',
            lifecycleState: 'open',
            pipelineId: PIPE_B,
          }),
        ],
        matchingCaptain: null,
        rules: rules({ crossPipelineMatch: false }),
        now: NOW,
      });
      assert.equal(d.decision, 'create_first_attempt');
      assert.equal(d.ruleApplied, 'route_to_review_cross_pipeline');
      assert.equal(d.confidence, 'medium');
      assert.equal(d.recommendedOwnerStrategy, 'route_engine');
      // The matched lead is still surfaced for the audit log.
      assert.deepEqual([...d.matchedLeadIds], ['other-pipe']);
    });

    it('default (false): match in different company → cross-pipeline rule fires too', () => {
      const d = svc.evaluate({
        context: context({ companyId: COMPANY_A }),
        matchingLeads: [
          lead({
            lifecycleState: 'open',
            pipelineId: null,
            companyId: COMPANY_B,
          }),
        ],
        matchingCaptain: null,
        rules: rules({ crossPipelineMatch: false }),
        now: NOW,
      });
      assert.equal(d.decision, 'create_first_attempt');
      assert.equal(d.ruleApplied, 'route_to_review_cross_pipeline');
    });

    it('flag flipped on: match in different pipeline blocks like in-scope match would', () => {
      const d = svc.evaluate({
        context: context({ pipelineId: PIPE_A, trigger: 'manual' }),
        matchingLeads: [
          lead({
            id: 'other-pipe',
            lifecycleState: 'open',
            pipelineId: PIPE_B,
          }),
        ],
        matchingCaptain: null,
        rules: rules({ crossPipelineMatch: true }),
        now: NOW,
      });
      assert.equal(d.decision, 'reject_existing_open');
    });
  });

  describe('null-pipeline / null-company tolerance', () => {
    it('null pipeline on the lead is treated as wildcard', () => {
      const d = svc.evaluate({
        context: context({ pipelineId: PIPE_A }),
        matchingLeads: [
          lead({
            lifecycleState: 'open',
            pipelineId: null, // legacy row
          }),
        ],
        matchingCaptain: null,
        rules: rules({ crossPipelineMatch: false }),
        now: NOW,
      });
      // The match is in scope (legacy row matches anything), so the
      // open-lead branch fires instead of cross-pipeline.
      assert.equal(d.decision, 'reject_existing_open');
    });

    it('null pipeline on the context is treated as wildcard', () => {
      const d = svc.evaluate({
        context: context({ pipelineId: null }),
        matchingLeads: [lead({ lifecycleState: 'open', pipelineId: PIPE_B })],
        matchingCaptain: null,
        rules: rules({ crossPipelineMatch: false }),
        now: NOW,
      });
      assert.equal(d.decision, 'reject_existing_open');
    });
  });

  describe('matchedLeadIds always includes every match for audit', () => {
    it('audit array preserves order even when only one match drives the decision', () => {
      const d = svc.evaluate({
        context: context(),
        matchingLeads: [
          lead({ id: 'lost-a', lifecycleState: 'lost', closedAt: NOW_MINUS_100_DAYS }),
          lead({ id: 'lost-b', lifecycleState: 'lost', closedAt: NOW_MINUS_31_DAYS }),
        ],
        matchingCaptain: null,
        rules: rules(),
        now: NOW,
      });
      assert.deepEqual([...d.matchedLeadIds], ['lost-a', 'lost-b']);
    });
  });
});
