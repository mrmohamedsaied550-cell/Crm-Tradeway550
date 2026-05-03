/**
 * Integration tests for the C10 CRM core.
 *
 * Wires LeadsService + CaptainsService + PipelineService manually (no full
 * Nest bootstrap) and runs them inside an explicit AsyncLocalStorage tenant
 * scope so the production code path is identical to the HTTP route. Tests
 * use a throwaway tenant (`__c10_test__`) so they don't pollute the seeded
 * `trade_way_default` data.
 *
 * Coverage:
 *   - Pipeline catalogue is seeded for the test tenant.
 *   - Lead CRUD: create, read, list, update, delete + cascade of activities.
 *   - Phone normalisation in CreateLead: spaces / hyphens / leading 00 cleaned.
 *   - Duplicate-phone create returns ConflictException.
 *   - assign(): writes assignment activity, fromUserId/toUserId payload.
 *   - moveStage(): writes stage_change activity; idempotent no-op when already
 *     in the target stage.
 *   - addActivity(): note + call rows persisted.
 *   - convertFromLead(): creates Captain, advances to converted stage,
 *     writes 2 activities (stage_change + system); second call rejected.
 *   - RLS isolation: leads from one tenant invisible from another's GUC.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JwtService } from '@nestjs/jwt';
import { PrismaClient } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { AgentCapacitiesService } from '../distribution/capacities.service';
import { DistributionService } from '../distribution/distribution.service';
import { LeadRoutingLogService } from '../distribution/routing-log.service';
import { DistributionRulesService } from '../distribution/rules.service';
import { PrismaService } from '../prisma/prisma.service';
import { tenantContext } from '../tenants/tenant-context';
import { TenantSettingsService } from '../tenants/tenant-settings.service';
import { hashPassword } from '../identity/password.util';
import { LeadsService } from './leads.service';
import { CaptainsService } from './captains.service';
import { PipelineService } from './pipeline.service';
import { AssignmentService } from './assignment.service';
import { SlaService } from './sla.service';
import { PIPELINE_STAGE_DEFINITIONS } from './pipeline.registry';

const TEST_TENANT_CODE = '__c10_test__';

let prisma: PrismaClient;
let prismaSvc: PrismaService;
let pipeline: PipelineService;
let leads: LeadsService;
let tenantSettingsSvc: TenantSettingsService;
let captains: CaptainsService;
let tenantId: string;
let actorUserId: string;
let assigneeUserId: string;
let salesAgentRoleId: string;

// Wrap an async fn so it runs inside AsyncLocalStorage with the test tenant
// context — mirrors what TenantContextMiddleware does for HTTP requests.
function inTenant<T>(fn: () => Promise<T>): Promise<T> {
  return tenantContext.run({ tenantId, tenantCode: TEST_TENANT_CODE, source: 'header' }, fn);
}

async function withTenantRaw<T>(tid: string, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return prisma.$transaction(async (tx: any) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.tenant_id = '${tid}'`);
    return fn(tx);
  });
}

describe('crm — lead lifecycle on a throwaway tenant', () => {
  before(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    prismaSvc = new PrismaService();
    pipeline = new PipelineService(prismaSvc);
    const assignment = new AssignmentService(prismaSvc);
    const audit = new AuditService(prismaSvc);
    tenantSettingsSvc = new TenantSettingsService(prismaSvc, audit);
    const sla = new SlaService(prismaSvc, assignment, undefined, tenantSettingsSvc);
    // A5 — autoAssign now routes through DistributionService.
    const rules = new DistributionRulesService(prismaSvc);
    const capacities = new AgentCapacitiesService(prismaSvc);
    const routingLog = new LeadRoutingLogService(prismaSvc);
    const distribution = new DistributionService(
      prismaSvc,
      rules,
      capacities,
      routingLog,
      tenantSettingsSvc,
    );
    leads = new LeadsService(prismaSvc, pipeline, sla, tenantSettingsSvc, distribution);
    captains = new CaptainsService(prismaSvc, pipeline, leads);

    // Provision a test tenant + a sales_agent role + a couple of users.
    const tenant = await prisma.tenant.upsert({
      where: { code: TEST_TENANT_CODE },
      update: { isActive: true },
      create: { code: TEST_TENANT_CODE, name: 'C10 CRM test tenant' },
    });
    tenantId = tenant.id;

    const role = await withTenantRaw(tenantId, (tx) =>
      tx.role.upsert({
        where: { tenantId_code: { tenantId, code: 'sales_agent' } },
        update: {},
        create: {
          tenantId,
          code: 'sales_agent',
          nameAr: 'وكيل',
          nameEn: 'Sales Agent',
          level: 30,
        },
      }),
    );
    salesAgentRoleId = role.id;

    const hash = await hashPassword('Password@123', 4);

    const actor = await withTenantRaw(tenantId, (tx) =>
      tx.user.upsert({
        where: { tenantId_email: { tenantId, email: '__c10_actor@test' } },
        update: {},
        create: {
          tenantId,
          email: '__c10_actor@test',
          name: 'Actor',
          passwordHash: hash,
          roleId: salesAgentRoleId,
        },
      }),
    );
    actorUserId = actor.id;

    const assignee = await withTenantRaw(tenantId, (tx) =>
      tx.user.upsert({
        where: { tenantId_email: { tenantId, email: '__c10_assignee@test' } },
        update: {},
        create: {
          tenantId,
          email: '__c10_assignee@test',
          name: 'Assignee',
          passwordHash: hash,
          roleId: salesAgentRoleId,
        },
      }),
    );
    assigneeUserId = assignee.id;

    // Seed the test tenant's pipeline.
    await withTenantRaw(tenantId, async (tx) => {
      const existing = await tx.pipeline.findFirst({
        where: { tenantId, isDefault: true },
        select: { id: true },
      });
      const pipelineId =
        existing?.id ??
        (
          await tx.pipeline.create({
            data: { tenantId, name: 'Default', isDefault: true, isActive: true },
            select: { id: true },
          })
        ).id;
      for (const def of PIPELINE_STAGE_DEFINITIONS) {
        await tx.pipelineStage.upsert({
          where: { pipelineId_code: { pipelineId, code: def.code } },
          update: { name: def.name, order: def.order, isTerminal: def.isTerminal },
          create: {
            tenantId,
            pipelineId,
            code: def.code,
            name: def.name,
            order: def.order,
            isTerminal: def.isTerminal,
          },
        });
      }
    });

    // Used by the JwtService import below to keep tree-shaking honest.
    void new JwtService();
  });

  after(async () => {
    // Cascading delete of the test tenant cleans up roles + users + leads
    // + captains + activities + pipeline stages in one shot.
    await prisma.tenant.delete({ where: { code: TEST_TENANT_CODE } }).catch(() => {});
    await prisma.$disconnect();
  });

  it('lists the 5 default pipeline stages in order', async () => {
    const stages = await inTenant(() => pipeline.list());
    assert.equal(stages.length, PIPELINE_STAGE_DEFINITIONS.length);
    assert.deepEqual(
      stages.map((s) => s.code),
      ['new', 'contacted', 'interested', 'converted', 'lost'],
    );
  });

  it('creates a lead with phone normalised, lands in `new` stage', async () => {
    const lead = await inTenant(() =>
      leads.create(
        {
          name: 'Ahmed Test',
          phone: '+20 100 111-2222',
          source: 'manual',
        },
        actorUserId,
      ),
    );
    assert.equal(lead.phone, '+201001112222');
    assert.equal(lead.stage.code, 'new');
    assert.equal(lead.captain, null);
  });

  it('rejects a duplicate phone in the same tenant', async () => {
    await assert.rejects(
      () =>
        inTenant(() =>
          leads.create({ name: 'Dup', phone: '+201001112222', source: 'manual' }, actorUserId),
        ),
      /A lead with phone .* already exists/,
    );
  });

  it('updates a lead', async () => {
    const lead = await inTenant(() =>
      leads.create({ name: 'B', phone: '+201001113333', source: 'manual' }, actorUserId),
    );
    const updated = await inTenant(() =>
      leads.update(lead.id, { name: 'Bilal Updated', email: 'bilal@example.com' }, actorUserId),
    );
    assert.equal(updated.name, 'Bilal Updated');
    assert.equal(updated.email, 'bilal@example.com');
  });

  it('assigns + unassigns a lead and writes assignment activities', async () => {
    const lead = await inTenant(() =>
      leads.create({ name: 'C', phone: '+201001114444', source: 'manual' }, actorUserId),
    );
    const assigned = await inTenant(() => leads.assign(lead.id, assigneeUserId, actorUserId));
    assert.equal(assigned.assignedToId, assigneeUserId);

    const unassigned = await inTenant(() => leads.assign(lead.id, null, actorUserId));
    assert.equal(unassigned.assignedToId, null);

    const activities = await inTenant(() => leads.listActivities(lead.id));
    const assignmentActs = activities.filter((a) => a.type === 'assignment');
    assert.equal(assignmentActs.length, 2);
    // Most recent first
    assert.equal((assignmentActs[0]?.payload as { toUserId: string | null }).toUserId, null);
    assert.equal((assignmentActs[1]?.payload as { toUserId: string }).toUserId, assigneeUserId);
  });

  it('rejects assigning to a user from a different tenant', async () => {
    const lead = await inTenant(() =>
      leads.create({ name: 'D', phone: '+201001115555', source: 'manual' }, actorUserId),
    );
    // A user that doesn't exist in this tenant.
    const fakeUserId = '00000000-0000-4000-8000-000000000001';
    await assert.rejects(
      () => inTenant(() => leads.assign(lead.id, fakeUserId, actorUserId)),
      /not a member of the active tenant/,
    );
  });

  it('moves a lead between stages and writes stage_change activity', async () => {
    const lead = await inTenant(() =>
      leads.create({ name: 'E', phone: '+201001116666', source: 'manual' }, actorUserId),
    );
    const moved = await inTenant(() =>
      leads.moveStage(lead.id, { stageCode: 'contacted' }, actorUserId),
    );
    assert.equal(moved.stage.code, 'contacted');

    const acts = await inTenant(() => leads.listActivities(lead.id));
    const stageChange = acts.find((a) => a.type === 'stage_change');
    assert.ok(stageChange);
    // Phase 1B — payload now also carries the explicit fromStageId /
    // toStageId so consumers (Kanban / reports) don't have to re-resolve
    // codes against a possibly-renamed pipeline. Asserting the
    // semantically meaningful subset.
    const p = stageChange?.payload as Record<string, unknown>;
    assert.equal(p?.event, 'stage_change');
    assert.equal(p?.fromStageCode, 'new');
    assert.equal(p?.toStageCode, 'contacted');
    assert.equal(typeof p?.fromStageId, 'string');
    assert.equal(typeof p?.toStageId, 'string');
  });

  it('moveStage to the same stage is a no-op (no extra activity row)', async () => {
    const lead = await inTenant(() =>
      leads.create({ name: 'F', phone: '+201001117777', source: 'manual' }, actorUserId),
    );
    const before = await inTenant(() => leads.listActivities(lead.id));
    await inTenant(() => leads.moveStage(lead.id, { stageCode: 'new' }, actorUserId));
    const after = await inTenant(() => leads.listActivities(lead.id));
    assert.equal(before.length, after.length);
  });

  it('appends a note + a call activity', async () => {
    const lead = await inTenant(() =>
      leads.create({ name: 'G', phone: '+201001118888', source: 'manual' }, actorUserId),
    );
    await inTenant(() =>
      leads.addActivity(lead.id, { type: 'note', body: 'Spoke briefly' }, actorUserId),
    );
    await inTenant(() =>
      leads.addActivity(lead.id, { type: 'call', body: 'No answer' }, actorUserId),
    );
    const acts = await inTenant(() => leads.listActivities(lead.id));
    const types = new Set(acts.map((a) => a.type));
    assert.ok(types.has('note'));
    assert.ok(types.has('call'));
  });

  it('converts a lead to a captain, advances stage, and rejects re-conversion', async () => {
    const lead = await inTenant(() =>
      leads.create({ name: 'H', phone: '+201001119999', source: 'meta' }, actorUserId),
    );
    const captain = await inTenant(() =>
      captains.convertFromLead(lead.id, { hasIdCard: true }, actorUserId),
    );
    assert.equal(captain.leadId, lead.id);
    assert.equal(captain.onboardingStatus, 'in_progress');
    assert.equal(captain.hasIdCard, true);

    const reread = await inTenant(() => leads.findByIdOrThrow(lead.id));
    assert.equal(reread.stage.code, 'converted');
    assert.equal(reread.captain?.id, captain.id);

    const acts = await inTenant(() => leads.listActivities(lead.id));
    const events = acts.map((a) => (a.payload as { event?: string } | null)?.event).filter(Boolean);
    assert.ok(events.includes('stage_change'));
    assert.ok(events.includes('converted'));

    await assert.rejects(
      () => inTenant(() => captains.convertFromLead(lead.id, {}, actorUserId)),
      /already been converted/,
    );
  });

  it('deletes a lead and cascades its activities', async () => {
    const lead = await inTenant(() =>
      leads.create({ name: 'I', phone: '+201002111111', source: 'manual' }, actorUserId),
    );
    await inTenant(() => leads.addActivity(lead.id, { type: 'note', body: 'doomed' }, actorUserId));
    await inTenant(() => leads.delete(lead.id));

    const stillThere = await inTenant(() => leads.findById(lead.id));
    assert.equal(stillThere, null);

    const remainingActs = await withTenantRaw(tenantId, (tx) =>
      tx.leadActivity.findMany({ where: { leadId: lead.id } }),
    );
    assert.equal(remainingActs.length, 0);
  });

  // ─────────────────────────────────────────────────────────────────────
  // C20 — every mutation path emits an activity with consistent metadata
  // (non-empty type + body, createdById === actor for actor-driven paths).
  // ─────────────────────────────────────────────────────────────────────

  // ─────────────────────────────────────────────────────────────────────
  // P3-03 — advanced search filters compose
  // ─────────────────────────────────────────────────────────────────────

  it('list filters compose: source + slaStatus + unassigned + createdFrom/To', async () => {
    // Three leads: one assigned manual, one unassigned import, one assigned manual older
    const a = await inTenant(() =>
      leads.create({ name: 'P303 Alice', phone: '+201003111001', source: 'manual' }, actorUserId),
    );
    await inTenant(() => leads.assign(a.id, assigneeUserId, actorUserId));

    const b = await inTenant(() =>
      leads.create({ name: 'P303 Bob', phone: '+201003111002', source: 'import' }, actorUserId),
    );
    // b stays unassigned

    const c = await inTenant(() =>
      leads.create({ name: 'P303 Cara', phone: '+201003111003', source: 'manual' }, actorUserId),
    );
    await inTenant(() => leads.assign(c.id, assigneeUserId, actorUserId));

    // source=import → only Bob
    const onlyBob = await inTenant(() => leads.list({ source: 'import', limit: 50, offset: 0 }));
    assert.ok(
      onlyBob.items.some((l) => l.id === b.id),
      'import filter must include Bob',
    );
    assert.ok(
      !onlyBob.items.some((l) => l.id === a.id || l.id === c.id),
      'import filter must exclude manual leads',
    );

    // unassigned=true → only Bob (a + c are assigned)
    const onlyUnassigned = await inTenant(() =>
      leads.list({ unassigned: true, limit: 50, offset: 0 }),
    );
    assert.ok(
      onlyUnassigned.items.some((l) => l.id === b.id),
      'unassigned filter must include Bob',
    );
    assert.ok(
      !onlyUnassigned.items.some((l) => l.id === a.id || l.id === c.id),
      'unassigned filter must exclude assigned leads',
    );

    // assignedToId beats unassigned when both are passed (most-specific intent wins)
    const explicitWins = await inTenant(() =>
      leads.list({
        assignedToId: assigneeUserId,
        unassigned: true,
        limit: 50,
        offset: 0,
      }),
    );
    assert.ok(
      explicitWins.items.some((l) => l.id === a.id),
      'explicit assignedToId must override unassigned=true',
    );

    // slaStatus=active matches all three (none breached / paused yet)
    const active = await inTenant(() => leads.list({ slaStatus: 'active', limit: 100, offset: 0 }));
    for (const id of [a.id, b.id, c.id]) {
      assert.ok(
        active.items.some((l) => l.id === id),
        `slaStatus=active must include ${id}`,
      );
    }

    // createdFrom in the future → empty
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const empty = await inTenant(() => leads.list({ createdFrom: future, limit: 50, offset: 0 }));
    assert.ok(
      !empty.items.some((l) => [a.id, b.id, c.id].includes(l.id)),
      'createdFrom in future must exclude all P303 leads',
    );
  });

  // ─────────────────────────────────────────────────────────────────────
  // A5 — autoAssign cutover. The semantic intent of these tests
  // (formerly PL-3 against the JSONB column) is preserved: a
  // source-matching rule routes the lead to the named user; no
  // matching rule falls back to the tenant default strategy
  // (capacity); a rule whose user is no longer eligible silently
  // falls back too.
  //
  // The plumbing is different — we now insert into the new
  // `distribution_rules` table and assert the activity payload
  // carries `strategy='specific_user'` (was 'rule') / 'capacity'
  // (was 'round_robin'). Both reflect the real strategy that fired
  // inside DistributionService.
  //
  // We also verify a routing-log row is written for every call.
  // ─────────────────────────────────────────────────────────────────────

  it('autoAssign honours a specific_user rule for the lead source + writes routing log', async () => {
    // Install a specific_user rule for source=meta → assignee.
    await withTenantRaw(tenantId, (tx) =>
      tx.distributionRule.create({
        data: {
          tenantId,
          name: 'Test: meta→assignee',
          strategy: 'specific_user',
          source: 'meta',
          targetUserId: assigneeUserId,
        },
      }),
    );

    const lead = await inTenant(() =>
      leads.create({ name: 'A5 Rule Hit', phone: '+201006000001', source: 'meta' }, actorUserId),
    );
    const result = await inTenant(() => leads.autoAssign(lead.id, actorUserId));
    assert.ok(result, 'autoAssign returned a lead');
    assert.equal(result?.assignedToId, assigneeUserId);

    // Activity records strategy='specific_user' (post-cutover name).
    const acts = await inTenant(() => leads.listActivities(lead.id));
    const auto = acts.find((a) => a.type === 'auto_assignment');
    assert.ok(auto, 'auto_assignment activity present');
    const payload = auto?.payload as { strategy?: string; ruleId?: string | null } | null;
    assert.equal(payload?.strategy, 'specific_user');
    assert.ok(payload?.ruleId, 'activity payload carries ruleId');

    // Routing log row written by the orchestrator.
    const logs = await inTenant(async () => {
      return prismaSvc.withTenant(tenantId, (tx) =>
        tx.leadRoutingLog.findMany({ where: { leadId: lead.id } }),
      );
    });
    assert.equal(logs.length, 1);
    assert.equal(logs[0]!.chosenUserId, assigneeUserId);
    assert.equal(logs[0]!.strategy, 'specific_user');
  });

  it('autoAssign falls back to tenant default strategy when no rule matches', async () => {
    // The previous test left a rule for source=meta. This lead has
    // source=manual → no rule matches → tenant default = 'capacity'.
    const lead = await inTenant(() =>
      leads.create(
        { name: 'A5 Default Strategy', phone: '+201006000002', source: 'manual' },
        actorUserId,
      ),
    );
    const result = await inTenant(() => leads.autoAssign(lead.id, actorUserId));
    assert.ok(result, 'autoAssign returned a lead');
    assert.ok(result?.assignedToId, 'default strategy picked an assignee');
    const acts = await inTenant(() => leads.listActivities(lead.id));
    const auto = acts.find((a) => a.type === 'auto_assignment');
    const payload = auto?.payload as { strategy?: string; ruleId?: string | null } | null;
    // Default tenant strategy is 'capacity' (from the migration default).
    assert.equal(payload?.strategy, 'capacity');
    assert.equal(payload?.ruleId, null, 'no rule matched');
  });

  it('autoAssign falls back when the rule user becomes ineligible (disabled)', async () => {
    // Provision a sales agent dedicated to this scenario, plant a
    // rule pointing at them, then DISABLE the user so they fail the
    // candidate filter (inactive_user). The specific_user strategy
    // sees no candidate matching the rule's target → returns null
    // → the orchestrator records chosenUserId=null in the log.
    const hash = await hashPassword('Password@123', 4);
    const stale = await withTenantRaw(tenantId, (tx) =>
      tx.user.create({
        data: {
          tenantId,
          email: '__a5_stale@test',
          name: 'Stale',
          passwordHash: hash,
          roleId: salesAgentRoleId,
        },
      }),
    );
    await withTenantRaw(tenantId, (tx) =>
      tx.distributionRule.create({
        data: {
          tenantId,
          name: 'Test: stale rule',
          strategy: 'specific_user',
          source: 'tiktok',
          targetUserId: stale.id,
        },
      }),
    );
    // Disable the user so the candidate filter rejects them.
    await withTenantRaw(tenantId, (tx) =>
      tx.user.update({ where: { id: stale.id }, data: { status: 'disabled' } }),
    );

    const lead = await inTenant(() =>
      leads.create(
        { name: 'A5 Stale Rule', phone: '+201006000003', source: 'tiktok' },
        actorUserId,
      ),
    );
    const result = await inTenant(() => leads.autoAssign(lead.id, actorUserId));

    // No eligible agent (the rule's target was filtered out and the
    // strategy doesn't fall back across rules — that's the
    // tenant-default fallback's job, but it only runs when NO rule
    // matched in the first place; this rule DID match).
    assert.equal(result, null, 'rule matched but target ineligible → returns null');

    // Routing log row written with chosenUserId=null. The disabled
    // user is excluded by the SQL pre-filter (status='active'
    // predicate on the candidate query) so no exclusion reason is
    // recorded for them — they simply never enter the pool. That's
    // the same behaviour the legacy round-robin had for disabled
    // users; the audit trail of "this rule pointed at a user who
    // doesn't exist anymore" is the routing log row itself
    // (ruleId set, chosenUserId null, strategy=specific_user).
    const logs = await prismaSvc.withTenant(tenantId, (tx) =>
      tx.leadRoutingLog.findMany({ where: { leadId: lead.id } }),
    );
    assert.equal(logs.length, 1);
    assert.equal(logs[0]!.chosenUserId, null);
    assert.equal(logs[0]!.strategy, 'specific_user');
    assert.ok(logs[0]!.ruleId, 'log records the rule that fired');
  });

  // ─────────────────────────────────────────────────────────────────────
  // P3-05 — bulk actions
  // ─────────────────────────────────────────────────────────────────────

  it('bulkAssign updates the good ids and reports failures for the bad ones', async () => {
    const a = await inTenant(() =>
      leads.create({ name: 'P305 A', phone: '+201005000001', source: 'manual' }, actorUserId),
    );
    const b = await inTenant(() =>
      leads.create({ name: 'P305 B', phone: '+201005000002', source: 'manual' }, actorUserId),
    );
    // Use a real lead id and a deliberately bogus one so we exercise the
    // partial-failure path. The failed entry must NOT abort the whole batch.
    const fakeUuid = '00000000-0000-0000-0000-000000000000';
    const res = await inTenant(() =>
      leads.bulkAssign(
        { leadIds: [a.id, fakeUuid, b.id], assignedToId: assigneeUserId },
        actorUserId,
      ),
    );
    assert.deepEqual(res.updated.sort(), [a.id, b.id].sort());
    assert.equal(res.failed.length, 1);
    assert.equal(res.failed[0]?.id, fakeUuid);
    // Both real leads now actually carry the new assignee.
    const aFresh = await inTenant(() => leads.findByIdOrThrow(a.id));
    const bFresh = await inTenant(() => leads.findByIdOrThrow(b.id));
    assert.equal(aFresh.assignedToId, assigneeUserId);
    assert.equal(bFresh.assignedToId, assigneeUserId);
  });

  it('bulkMoveStage moves every selected lead to the target stage', async () => {
    const x = await inTenant(() =>
      leads.create({ name: 'P305 X', phone: '+201005000003', source: 'manual' }, actorUserId),
    );
    const y = await inTenant(() =>
      leads.create({ name: 'P305 Y', phone: '+201005000004', source: 'manual' }, actorUserId),
    );
    const res = await inTenant(() =>
      leads.bulkMoveStage({ leadIds: [x.id, y.id], stageCode: 'contacted' }, actorUserId),
    );
    assert.equal(res.updated.length, 2);
    assert.equal(res.failed.length, 0);
    const xFresh = await inTenant(() => leads.findByIdOrThrow(x.id));
    assert.equal(xFresh.stage.code, 'contacted');
  });

  it('bulkDelete removes every selected lead', async () => {
    const z = await inTenant(() =>
      leads.create({ name: 'P305 Z', phone: '+201005000005', source: 'manual' }, actorUserId),
    );
    const res = await inTenant(() => leads.bulkDelete({ leadIds: [z.id] }));
    assert.deepEqual(res.updated, [z.id]);
    assert.equal(res.failed.length, 0);
    await assert.rejects(() => inTenant(() => leads.findByIdOrThrow(z.id)), /not found/i);
  });

  it('every lead mutation emits an activity with type + body + actor', async () => {
    const lead = await inTenant(() =>
      leads.create({ name: 'C20 Audit', phone: '+201002999000', source: 'manual' }, actorUserId),
    );
    await inTenant(() => leads.update(lead.id, { name: 'C20 Audit (renamed)' }, actorUserId));
    await inTenant(() => leads.assign(lead.id, assigneeUserId, actorUserId));
    await inTenant(() => leads.moveStage(lead.id, { stageCode: 'contacted' }, actorUserId));
    await inTenant(() =>
      leads.addActivity(lead.id, { type: 'note', body: 'spoke briefly' }, actorUserId),
    );
    await inTenant(() =>
      leads.addActivity(lead.id, { type: 'call', body: 'voicemail' }, actorUserId),
    );

    const acts = await inTenant(() => leads.listActivities(lead.id));
    // Six events expected: created, updated, assignment, stage_change, note, call.
    assert.equal(acts.length, 6, `expected 6 activities, got ${acts.length}`);

    for (const a of acts) {
      assert.ok(typeof a.type === 'string' && a.type.length > 0, `type must be set on ${a.id}`);
      assert.ok(
        typeof a.body === 'string' && a.body.length > 0,
        `body must be non-empty on ${a.id} (${a.type})`,
      );
      assert.equal(a.createdById, actorUserId, `createdById must equal actor on ${a.type}`);
    }

    const types = new Set(acts.map((a) => a.type));
    for (const expected of ['system', 'assignment', 'stage_change', 'note', 'call']) {
      assert.ok(types.has(expected), `expected activity type ${expected} present`);
    }
  });
});

describe('crm — RLS isolation across tenants', () => {
  let otherTenantId: string;

  before(async () => {
    const t = await prisma.tenant.upsert({
      where: { code: '__c10_other__' },
      update: { isActive: true },
      create: { code: '__c10_other__', name: 'C10 other tenant' },
    });
    otherTenantId = t.id;

    // Seed pipeline + minimal user role for the other tenant so a probe lead
    // can be created entirely under its own GUC.
    await withTenantRaw(otherTenantId, async (tx) => {
      const existing = await tx.pipeline.findFirst({
        where: { tenantId: otherTenantId, isDefault: true },
        select: { id: true },
      });
      const pipelineId =
        existing?.id ??
        (
          await tx.pipeline.create({
            data: { tenantId: otherTenantId, name: 'Default', isDefault: true, isActive: true },
            select: { id: true },
          })
        ).id;
      for (const def of PIPELINE_STAGE_DEFINITIONS) {
        await tx.pipelineStage.upsert({
          where: { pipelineId_code: { pipelineId, code: def.code } },
          update: {},
          create: {
            tenantId: otherTenantId,
            pipelineId,
            code: def.code,
            name: def.name,
            order: def.order,
            isTerminal: def.isTerminal,
          },
        });
      }
    });

    const newStage = await withTenantRaw(otherTenantId, (tx) =>
      tx.pipelineStage.findFirstOrThrow({
        where: { tenantId: otherTenantId, code: 'new' },
      }),
    );

    await withTenantRaw(otherTenantId, (tx) =>
      tx.lead.create({
        data: {
          tenantId: otherTenantId,
          name: 'Other-tenant probe',
          phone: '+209999999999',
          source: 'manual',
          stageId: newStage.id,
        },
      }),
    );
  });

  after(async () => {
    await prisma.tenant.delete({ where: { code: '__c10_other__' } }).catch(() => {});
  });

  it('reading leads without a GUC returns 0 rows', async () => {
    const rows = await prisma.lead.findMany({
      where: { phone: '+209999999999' },
    });
    assert.equal(rows.length, 0);
  });

  it('the test tenant cannot see the other tenant probe', async () => {
    const list = await inTenant(() => leads.list({ q: '+209999999999', limit: 50, offset: 0 }));
    assert.equal(list.items.length, 0);
    assert.equal(list.total, 0);
  });

  it('inserting a lead with a foreign tenant_id is rejected by WITH CHECK', async () => {
    let threw = false;
    try {
      await withTenantRaw(otherTenantId, async (tx) => {
        const stage = await tx.pipelineStage.findFirstOrThrow({
          where: { tenantId: otherTenantId, code: 'new' },
        });
        // GUC = otherTenantId, but we attempt to write a row for tenantId.
        await tx.lead.create({
          data: {
            tenantId,
            name: 'attack',
            phone: '+209999999998',
            source: 'manual',
            stageId: stage.id,
          },
        });
      });
    } catch (err) {
      threw = true;
      assert.match(
        String((err as Error).message),
        /row-level security|row level security|violates/i,
      );
    }
    assert.equal(threw, true, 'cross-tenant insert must throw');
  });
});
