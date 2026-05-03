/**
 * Phase 1A — A4: candidate-filter unit tests.
 * Pure: no DB, no Nest, no Prisma.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { EffectiveCapacity } from './capacities.service';
import { filterCandidates, type RawCandidate } from './candidate-filter';

const NOW = new Date('2026-05-15T12:00:00Z');

function defaultCapacity(
  userId: string,
  overrides: Partial<EffectiveCapacity> = {},
): EffectiveCapacity {
  return {
    userId,
    weight: 1,
    isAvailable: true,
    outOfOfficeUntil: null,
    maxActiveLeads: null,
    ...overrides,
  };
}

function candidate(overrides: Partial<RawCandidate> = {}): RawCandidate {
  const id = overrides.id ?? 'u1';
  return {
    id,
    status: 'active',
    roleCode: 'sales_agent',
    teamId: null,
    lastAssignedAt: null,
    capacity: defaultCapacity(id),
    activeLeadCount: 0,
    ...overrides,
  };
}

describe('candidate-filter (A4)', () => {
  it('passes a healthy default candidate through to surviving', () => {
    const result = filterCandidates([candidate({ id: 'alice' })], {
      ruleTargetTeamId: null,
      excludeUserIds: [],
      now: NOW,
    });
    assert.equal(result.surviving.length, 1);
    assert.equal(result.surviving[0]!.id, 'alice');
    assert.deepEqual(result.excluded, {});
  });

  it('inactive_user: status !== "active" rejects regardless of role', () => {
    const result = filterCandidates([candidate({ id: 'alice', status: 'disabled' })], {
      ruleTargetTeamId: null,
      excludeUserIds: [],
      now: NOW,
    });
    assert.equal(result.surviving.length, 0);
    assert.equal(result.excluded['alice'], 'inactive_user');
  });

  it('not_eligible_role: super_admin / qa_specialist / random rejects', () => {
    const result = filterCandidates(
      [
        candidate({ id: 'alice', roleCode: 'super_admin' }),
        candidate({ id: 'bob', roleCode: 'qa_specialist' }),
        candidate({ id: 'carol', roleCode: 'sales_agent' }),
      ],
      { ruleTargetTeamId: null, excludeUserIds: [], now: NOW },
    );
    assert.equal(result.surviving.length, 1);
    assert.equal(result.surviving[0]!.id, 'carol');
    assert.equal(result.excluded['alice'], 'not_eligible_role');
    assert.equal(result.excluded['bob'], 'not_eligible_role');
  });

  it('excluded_by_caller: ids in excludeUserIds rejected (e.g. current assignee)', () => {
    const result = filterCandidates([candidate({ id: 'alice' }), candidate({ id: 'bob' })], {
      ruleTargetTeamId: null,
      excludeUserIds: ['alice'],
      now: NOW,
    });
    assert.equal(result.surviving.length, 1);
    assert.equal(result.surviving[0]!.id, 'bob');
    assert.equal(result.excluded['alice'], 'excluded_by_caller');
  });

  it('wrong_team: rule.targetTeamId set rejects users in any other team', () => {
    const result = filterCandidates(
      [
        candidate({ id: 'alice', teamId: 'team-a' }),
        candidate({ id: 'bob', teamId: 'team-b' }),
        candidate({ id: 'carol', teamId: null }),
      ],
      { ruleTargetTeamId: 'team-a', excludeUserIds: [], now: NOW },
    );
    assert.equal(result.surviving.length, 1);
    assert.equal(result.surviving[0]!.id, 'alice');
    assert.equal(result.excluded['bob'], 'wrong_team');
    assert.equal(result.excluded['carol'], 'wrong_team');
  });

  it('wrong_team: ruleTargetTeamId=null does not exclude anyone on team grounds', () => {
    const result = filterCandidates(
      [candidate({ id: 'alice', teamId: 'team-a' }), candidate({ id: 'bob', teamId: null })],
      { ruleTargetTeamId: null, excludeUserIds: [], now: NOW },
    );
    assert.equal(result.surviving.length, 2);
  });

  it('unavailable: capacity.isAvailable=false rejects', () => {
    const result = filterCandidates(
      [
        candidate({ id: 'alice', capacity: defaultCapacity('alice', { isAvailable: false }) }),
        candidate({ id: 'bob' }),
      ],
      { ruleTargetTeamId: null, excludeUserIds: [], now: NOW },
    );
    assert.equal(result.surviving.length, 1);
    assert.equal(result.surviving[0]!.id, 'bob');
    assert.equal(result.excluded['alice'], 'unavailable');
  });

  it('out_of_office: outOfOfficeUntil > now rejects; <= now does not', () => {
    const tomorrow = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
    const yesterday = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);
    const result = filterCandidates(
      [
        candidate({
          id: 'alice',
          capacity: defaultCapacity('alice', { outOfOfficeUntil: tomorrow }),
        }),
        candidate({
          id: 'bob',
          capacity: defaultCapacity('bob', { outOfOfficeUntil: yesterday }),
        }),
        candidate({ id: 'carol' }),
      ],
      { ruleTargetTeamId: null, excludeUserIds: [], now: NOW },
    );
    assert.equal(result.surviving.length, 2);
    assert.deepEqual(result.surviving.map((c) => c.id).sort(), ['bob', 'carol']);
    assert.equal(result.excluded['alice'], 'out_of_office');
  });

  it('at_capacity: activeLeadCount >= maxActiveLeads rejects; null max never rejects', () => {
    const result = filterCandidates(
      [
        candidate({
          id: 'alice',
          capacity: defaultCapacity('alice', { maxActiveLeads: 5 }),
          activeLeadCount: 5,
        }),
        candidate({
          id: 'bob',
          capacity: defaultCapacity('bob', { maxActiveLeads: 5 }),
          activeLeadCount: 4,
        }),
        candidate({
          id: 'carol',
          capacity: defaultCapacity('carol', { maxActiveLeads: null }),
          activeLeadCount: 999, // null max = no cap
        }),
      ],
      { ruleTargetTeamId: null, excludeUserIds: [], now: NOW },
    );
    assert.equal(result.surviving.length, 2);
    assert.equal(result.excluded['alice'], 'at_capacity');
  });

  it('filter order: short-circuits on first failure (records ONE reason per user)', () => {
    // alice is BOTH disabled AND unavailable AND at-capacity — only
    // the FIRST failure (inactive_user) should be recorded.
    const result = filterCandidates(
      [
        candidate({
          id: 'alice',
          status: 'disabled',
          capacity: defaultCapacity('alice', { isAvailable: false, maxActiveLeads: 1 }),
          activeLeadCount: 99,
        }),
      ],
      { ruleTargetTeamId: null, excludeUserIds: [], now: NOW },
    );
    assert.equal(result.surviving.length, 0);
    assert.equal(result.excluded['alice'], 'inactive_user');
  });

  it('flattens RoutingCandidate shape correctly (drops role/status/team/capacity object)', () => {
    const result = filterCandidates(
      [
        candidate({
          id: 'alice',
          roleCode: 'tl_sales',
          teamId: 'team-x',
          lastAssignedAt: new Date('2026-05-01T08:00:00Z'),
          capacity: defaultCapacity('alice', { weight: 7 }),
          activeLeadCount: 3,
        }),
      ],
      { ruleTargetTeamId: null, excludeUserIds: [], now: NOW },
    );
    const c = result.surviving[0]!;
    assert.deepEqual(Object.keys(c).sort(), ['activeLeadCount', 'id', 'lastAssignedAt', 'weight']);
    assert.equal(c.id, 'alice');
    assert.equal(c.weight, 7);
    assert.equal(c.activeLeadCount, 3);
  });

  it('handles empty candidate list', () => {
    const result = filterCandidates([], {
      ruleTargetTeamId: null,
      excludeUserIds: [],
      now: NOW,
    });
    assert.deepEqual(result.surviving, []);
    assert.deepEqual(result.excluded, {});
  });
});
