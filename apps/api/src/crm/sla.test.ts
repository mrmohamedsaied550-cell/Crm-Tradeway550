/**
 * Tests for the C11 response-SLA engine.
 *
 * Same harness as assignment.test.ts: manual service wiring, explicit
 * AsyncLocalStorage tenant context, throwaway tenant for isolation.
 *
 * Coverage:
 *   - create() populates slaDueAt + slaStatus='active'.
 *   - addActivity({type:'note'|'call'}) resets slaDueAt + lastResponseAt.
 *   - addActivity({type:'note'}) on a terminal lead does NOT resurrect SLA.
 *   - moveStage() to a non-terminal stage resets slaDueAt.
 *   - moveStage() to a terminal stage pauses (slaDueAt=null,status='paused').
 *   - assign() resets slaDueAt for non-terminal leads.
 *   - convertFromLead() pauses SLA on the underlying lead.
 *   - findBreachedLeads() filters to active+overdue+non-terminal only.
 *   - runReassignmentForBreaches() reassigns + writes 2 activities.
 *   - runReassignmentForBreaches() leaves an unassigned lead breached.
 *   - runReassignmentForBreaches() with no eligible agent stays breached.
 *   - Cross-tenant: scanner running under tenant A never touches tenant B leads.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { tenantContext } from '../tenants/tenant-context';
import { TenantSettingsService } from '../tenants/tenant-settings.service';
import { hashPassword } from '../identity/password.util';
import { AssignmentService } from './assignment.service';
import { LeadsService } from './leads.service';
import { CaptainsService } from './captains.service';
import { PipelineService } from './pipeline.service';
import { SlaService } from './sla.service';
import { PIPELINE_STAGE_DEFINITIONS } from './pipeline.registry';
import { getSlaWindowMs } from './sla.config';

const TEST_TENANT_CODE = '__c11_sla__';
const OTHER_TENANT_CODE = '__c11_sla_other__';

let prisma: PrismaClient;
let prismaSvc: PrismaService;
let leads: LeadsService;
let captains: CaptainsService;
let sla: SlaService;
let tenantId: string;
let otherTenantId: string;
let actorUserId: string;
let agentAId: string;
let agentBId: string;

function inTenant<T>(fn: () => Promise<T>): Promise<T> {
  return tenantContext.run({ tenantId, tenantCode: TEST_TENANT_CODE, source: 'header' }, fn);
}

function inOtherTenant<T>(fn: () => Promise<T>): Promise<T> {
  return tenantContext.run(
    { tenantId: otherTenantId, tenantCode: OTHER_TENANT_CODE, source: 'header' },
    fn,
  );
}

async function withTenantRaw<T>(tid: string, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return prisma.$transaction(async (tx: any) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.tenant_id = '${tid}'`);
    return fn(tx);
  });
}

async function seedPipeline(tid: string): Promise<void> {
  await withTenantRaw(tid, async (tx) => {
    const existing = await tx.pipeline.findFirst({
      where: { tenantId: tid, isDefault: true },
      select: { id: true },
    });
    const pipelineId =
      existing?.id ??
      (
        await tx.pipeline.create({
          data: { tenantId: tid, name: 'Default', isDefault: true, isActive: true },
          select: { id: true },
        })
      ).id;
    for (const def of PIPELINE_STAGE_DEFINITIONS) {
      await tx.pipelineStage.upsert({
        where: { pipelineId_code: { pipelineId, code: def.code } },
        update: { name: def.name, order: def.order, isTerminal: def.isTerminal },
        create: {
          tenantId: tid,
          pipelineId,
          code: def.code,
          name: def.name,
          order: def.order,
          isTerminal: def.isTerminal,
        },
      });
    }
  });
}

/** Force-expire a lead's SLA so the breach scanner picks it up. */
async function expireLeadSla(tid: string, leadId: string): Promise<void> {
  await withTenantRaw(tid, (tx) =>
    tx.lead.update({
      where: { id: leadId },
      data: {
        slaDueAt: new Date(Date.now() - 60_000), // 1 min in the past
        slaStatus: 'active',
      },
    }),
  );
}

describe('crm — response-SLA engine (C11)', () => {
  before(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    prismaSvc = new PrismaService();
    const pipeline = new PipelineService(prismaSvc);
    const assignment = new AssignmentService(prismaSvc);
    const audit = new AuditService(prismaSvc);
    const tenantSettings = new TenantSettingsService(prismaSvc, audit);
    sla = new SlaService(prismaSvc, assignment, undefined, tenantSettings);
    // A5 — LeadsService no longer takes AssignmentService directly;
    // SLA tests don't exercise autoAssign, so DistributionService is
    // omitted here too.
    leads = new LeadsService(prismaSvc, pipeline, sla, tenantSettings);
    captains = new CaptainsService(prismaSvc, pipeline, leads);

    const tenant = await prisma.tenant.upsert({
      where: { code: TEST_TENANT_CODE },
      update: { isActive: true },
      create: { code: TEST_TENANT_CODE, name: 'C11 SLA test' },
    });
    tenantId = tenant.id;

    const other = await prisma.tenant.upsert({
      where: { code: OTHER_TENANT_CODE },
      update: { isActive: true },
      create: { code: OTHER_TENANT_CODE, name: 'C11 SLA other tenant' },
    });
    otherTenantId = other.id;

    await seedPipeline(tenantId);
    await seedPipeline(otherTenantId);

    const hash = await hashPassword('Password@123', 4);

    const salesRole = await withTenantRaw(tenantId, (tx) =>
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

    const otherSalesRole = await withTenantRaw(otherTenantId, (tx) =>
      tx.role.upsert({
        where: { tenantId_code: { tenantId: otherTenantId, code: 'sales_agent' } },
        update: {},
        create: {
          tenantId: otherTenantId,
          code: 'sales_agent',
          nameAr: 'وكيل',
          nameEn: 'Sales Agent',
          level: 30,
        },
      }),
    );

    actorUserId = (
      await withTenantRaw(tenantId, (tx) =>
        tx.user.upsert({
          where: { tenantId_email: { tenantId, email: '__c11sla_actor@test' } },
          update: {},
          create: {
            tenantId,
            email: '__c11sla_actor@test',
            name: 'Actor',
            passwordHash: hash,
            roleId: salesRole.id,
          },
        }),
      )
    ).id;

    agentAId = (
      await withTenantRaw(tenantId, (tx) =>
        tx.user.upsert({
          where: { tenantId_email: { tenantId, email: '__c11sla_agent_a@test' } },
          update: { status: 'active', roleId: salesRole.id },
          create: {
            tenantId,
            email: '__c11sla_agent_a@test',
            name: 'Agent A',
            passwordHash: hash,
            roleId: salesRole.id,
          },
        }),
      )
    ).id;

    agentBId = (
      await withTenantRaw(tenantId, (tx) =>
        tx.user.upsert({
          where: { tenantId_email: { tenantId, email: '__c11sla_agent_b@test' } },
          update: { status: 'active', roleId: salesRole.id },
          create: {
            tenantId,
            email: '__c11sla_agent_b@test',
            name: 'Agent B',
            passwordHash: hash,
            roleId: salesRole.id,
          },
        }),
      )
    ).id;

    // Plant a sales_agent in the OTHER tenant so the cross-tenant test
    // has someone the scanner could *theoretically* pick if RLS broke.
    await withTenantRaw(otherTenantId, (tx) =>
      tx.user.upsert({
        where: { tenantId_email: { tenantId: otherTenantId, email: '__c11sla_other_agent@test' } },
        update: {},
        create: {
          tenantId: otherTenantId,
          email: '__c11sla_other_agent@test',
          name: 'Other Agent',
          passwordHash: hash,
          roleId: otherSalesRole.id,
        },
      }),
    );
  });

  after(async () => {
    await prisma.tenant.delete({ where: { code: TEST_TENANT_CODE } }).catch(() => {});
    await prisma.tenant.delete({ where: { code: OTHER_TENANT_CODE } }).catch(() => {});
    await prisma.$disconnect();
  });

  // ───────────────────────────────────────────────────────────────────────
  // SLA reset / pause behaviour around the lead lifecycle
  // ───────────────────────────────────────────────────────────────────────

  it('create() populates slaDueAt + slaStatus=active for a non-terminal lead', async () => {
    const before = Date.now();
    const lead = await inTenant(() =>
      leads.create({ name: 'SLA-A', phone: '+201112000001', source: 'manual' }, actorUserId),
    );
    const after = Date.now();
    const window = getSlaWindowMs();

    const fresh = await withTenantRaw(tenantId, (tx) =>
      tx.lead.findUniqueOrThrow({ where: { id: lead.id } }),
    );
    assert.equal(fresh.slaStatus, 'active');
    assert.ok(fresh.slaDueAt, 'slaDueAt must be set');
    const due = fresh.slaDueAt!.getTime();
    assert.ok(
      due >= before + window - 5_000 && due <= after + window + 5_000,
      `slaDueAt ${new Date(due).toISOString()} should be ~now+window`,
    );
  });

  it('addActivity({type:note|call}) resets the SLA window', async () => {
    const lead = await inTenant(() =>
      leads.create({ name: 'SLA-B', phone: '+201112000002', source: 'manual' }, actorUserId),
    );
    // Fast-forward the due time backward so we can detect a reset.
    await withTenantRaw(tenantId, (tx) =>
      tx.lead.update({
        where: { id: lead.id },
        data: { slaDueAt: new Date(Date.now() - 60_000) },
      }),
    );

    await inTenant(() => leads.addActivity(lead.id, { type: 'note', body: 'hi' }, actorUserId));
    const reset = await withTenantRaw(tenantId, (tx) =>
      tx.lead.findUniqueOrThrow({ where: { id: lead.id } }),
    );
    assert.equal(reset.slaStatus, 'active');
    assert.ok(reset.slaDueAt && reset.slaDueAt.getTime() > Date.now() - 1_000);
    assert.ok(reset.lastResponseAt, 'lastResponseAt must be stamped on note');
  });

  it('addActivity on a terminal-stage lead does NOT resurrect SLA', async () => {
    const lead = await inTenant(() =>
      leads.create({ name: 'SLA-C', phone: '+201112000003', source: 'manual' }, actorUserId),
    );
    await inTenant(() => leads.moveStage(lead.id, 'lost', actorUserId));
    // sanity: paused
    let row = await withTenantRaw(tenantId, (tx) =>
      tx.lead.findUniqueOrThrow({ where: { id: lead.id } }),
    );
    assert.equal(row.slaStatus, 'paused');
    assert.equal(row.slaDueAt, null);

    await inTenant(() =>
      leads.addActivity(lead.id, { type: 'note', body: 'post-mortem' }, actorUserId),
    );
    row = await withTenantRaw(tenantId, (tx) =>
      tx.lead.findUniqueOrThrow({ where: { id: lead.id } }),
    );
    assert.equal(row.slaStatus, 'paused');
    assert.equal(row.slaDueAt, null);
  });

  it('moveStage() to a non-terminal stage resets the SLA window', async () => {
    const lead = await inTenant(() =>
      leads.create({ name: 'SLA-D', phone: '+201112000004', source: 'manual' }, actorUserId),
    );
    await withTenantRaw(tenantId, (tx) =>
      tx.lead.update({
        where: { id: lead.id },
        data: { slaDueAt: new Date(Date.now() - 60_000) },
      }),
    );

    await inTenant(() => leads.moveStage(lead.id, 'contacted', actorUserId));
    const row = await withTenantRaw(tenantId, (tx) =>
      tx.lead.findUniqueOrThrow({ where: { id: lead.id } }),
    );
    assert.equal(row.slaStatus, 'active');
    assert.ok(row.slaDueAt && row.slaDueAt.getTime() > Date.now() - 1_000);
  });

  it('moveStage() to a terminal stage pauses the SLA', async () => {
    const lead = await inTenant(() =>
      leads.create({ name: 'SLA-E', phone: '+201112000005', source: 'manual' }, actorUserId),
    );
    await inTenant(() => leads.moveStage(lead.id, 'lost', actorUserId));
    const row = await withTenantRaw(tenantId, (tx) =>
      tx.lead.findUniqueOrThrow({ where: { id: lead.id } }),
    );
    assert.equal(row.slaStatus, 'paused');
    assert.equal(row.slaDueAt, null);
  });

  it('assign() resets the SLA window for non-terminal leads', async () => {
    const lead = await inTenant(() =>
      leads.create({ name: 'SLA-F', phone: '+201112000006', source: 'manual' }, actorUserId),
    );
    await withTenantRaw(tenantId, (tx) =>
      tx.lead.update({
        where: { id: lead.id },
        data: { slaDueAt: new Date(Date.now() - 60_000) },
      }),
    );

    await inTenant(() => leads.assign(lead.id, agentAId, actorUserId));
    const row = await withTenantRaw(tenantId, (tx) =>
      tx.lead.findUniqueOrThrow({ where: { id: lead.id } }),
    );
    assert.equal(row.slaStatus, 'active');
    assert.ok(row.slaDueAt && row.slaDueAt.getTime() > Date.now() - 1_000);
    assert.equal(row.assignedToId, agentAId);
  });

  it('convertFromLead() pauses the SLA on the underlying lead', async () => {
    const lead = await inTenant(() =>
      leads.create({ name: 'SLA-G', phone: '+201112000007', source: 'manual' }, actorUserId),
    );
    await inTenant(() => captains.convertFromLead(lead.id, {}, actorUserId));

    const row = await withTenantRaw(tenantId, (tx) =>
      tx.lead.findUniqueOrThrow({ where: { id: lead.id } }),
    );
    assert.equal(row.slaStatus, 'paused');
    assert.equal(row.slaDueAt, null);
  });

  // ───────────────────────────────────────────────────────────────────────
  // Breach detection + reassignment
  // ───────────────────────────────────────────────────────────────────────

  it('findBreachedLeads filters to active + overdue + non-terminal only', async () => {
    const overdue = await inTenant(() =>
      leads.create({ name: 'SLA-H', phone: '+201112000008', source: 'manual' }, actorUserId),
    );
    const fresh = await inTenant(() =>
      leads.create({ name: 'SLA-I', phone: '+201112000009', source: 'manual' }, actorUserId),
    );
    const terminal = await inTenant(() =>
      leads.create({ name: 'SLA-J', phone: '+201112000010', source: 'manual' }, actorUserId),
    );

    await expireLeadSla(tenantId, overdue.id);
    // terminal: move to lost — SLA paused.
    await inTenant(() => leads.moveStage(terminal.id, 'lost', actorUserId));
    // Even if we forcibly back-date the (now paused) one, it must stay
    // out of the result set because slaStatus !== 'active'.
    await withTenantRaw(tenantId, (tx) =>
      tx.lead.update({
        where: { id: terminal.id },
        data: { slaDueAt: new Date(Date.now() - 60_000) },
      }),
    );

    const breaches = await inTenant(() => sla.findBreachedLeads());
    const ids = breaches.map((b) => b.id);
    assert.ok(ids.includes(overdue.id), 'overdue active lead must appear');
    assert.ok(!ids.includes(fresh.id), 'fresh lead must NOT appear');
    assert.ok(!ids.includes(terminal.id), 'terminal lead must NOT appear');
  });

  it('runReassignmentForBreaches reassigns to a different agent and writes 2 activities', async () => {
    // Assign to agent A, then expire — the scanner should move it to B.
    const lead = await inTenant(() =>
      leads.create({ name: 'SLA-K', phone: '+201112000011', source: 'manual' }, actorUserId),
    );
    await inTenant(() => leads.assign(lead.id, agentAId, actorUserId));
    await expireLeadSla(tenantId, lead.id);

    const results = await inTenant(() => sla.runReassignmentForBreaches(actorUserId));
    const mine = results.find((r) => r.leadId === lead.id);
    assert.ok(mine, 'breach result must include our lead');
    assert.equal(mine?.outcome, 'reassigned');
    assert.equal(mine?.fromUserId, agentAId);
    assert.notEqual(mine?.toUserId, agentAId);

    const fresh = await withTenantRaw(tenantId, (tx) =>
      tx.lead.findUniqueOrThrow({ where: { id: lead.id } }),
    );
    assert.equal(fresh.slaStatus, 'active', 'reassignment resets to active');
    assert.notEqual(fresh.assignedToId, agentAId);

    const acts = await inTenant(() => leads.listActivities(lead.id));
    const slaBreaches = acts.filter((a) => a.type === 'sla_breach');
    // Two `sla_breach` rows: the breach itself + the reassignment audit.
    assert.equal(slaBreaches.length, 2, 'expected breach + reassignment audit rows');
  });

  it('runReassignmentForBreaches marks unassigned overdue leads as unassigned_breached', async () => {
    const lead = await inTenant(() =>
      leads.create({ name: 'SLA-L', phone: '+201112000012', source: 'manual' }, actorUserId),
    );
    // No assign() call → assignedToId stays null.
    await expireLeadSla(tenantId, lead.id);

    const results = await inTenant(() => sla.runReassignmentForBreaches(actorUserId));
    const mine = results.find((r) => r.leadId === lead.id);
    assert.ok(mine);
    assert.equal(mine?.outcome, 'unassigned_breached');

    const fresh = await withTenantRaw(tenantId, (tx) =>
      tx.lead.findUniqueOrThrow({ where: { id: lead.id } }),
    );
    assert.equal(fresh.slaStatus, 'breached');
  });

  it('runReassignmentForBreaches with no eligible alternate keeps the lead breached', async () => {
    // Disable agent B so the only sales agents left are agentA + actor.
    // Then create a lead assigned to agentA and disable agentA after
    // assignment → exclusion list = [agentA] and the only remaining
    // sales agent (the actor) must be excluded too.
    await withTenantRaw(tenantId, (tx) =>
      tx.user.update({ where: { id: agentBId }, data: { status: 'disabled' } }),
    );
    await withTenantRaw(tenantId, (tx) =>
      tx.user.update({ where: { id: actorUserId }, data: { status: 'disabled' } }),
    );

    const lead = await inTenant(() =>
      leads.create({ name: 'SLA-M', phone: '+201112000013', source: 'manual' }, actorUserId),
    );
    await inTenant(() => leads.assign(lead.id, agentAId, actorUserId));
    await expireLeadSla(tenantId, lead.id);

    const results = await inTenant(() => sla.runReassignmentForBreaches(actorUserId));
    const mine = results.find((r) => r.leadId === lead.id);
    assert.ok(mine);
    assert.equal(mine?.outcome, 'no_eligible_agent');
    assert.equal(mine?.fromUserId, agentAId);
    assert.equal(mine?.toUserId, null);

    const fresh = await withTenantRaw(tenantId, (tx) =>
      tx.lead.findUniqueOrThrow({ where: { id: lead.id } }),
    );
    assert.equal(fresh.slaStatus, 'breached');
    assert.equal(fresh.assignedToId, agentAId, 'original assignee retained');

    // Restore for downstream tests.
    await withTenantRaw(tenantId, (tx) =>
      tx.user.update({ where: { id: agentBId }, data: { status: 'active' } }),
    );
    await withTenantRaw(tenantId, (tx) =>
      tx.user.update({ where: { id: actorUserId }, data: { status: 'active' } }),
    );
  });

  it('breach scanner under tenant A never reads or reassigns tenant B leads', async () => {
    // Plant an overdue lead inside the OTHER tenant via raw SQL — using
    // its own GUC so it lands cleanly in that tenant's RLS scope.
    const otherStage = await withTenantRaw(otherTenantId, (tx) =>
      tx.pipelineStage.findFirstOrThrow({ where: { tenantId: otherTenantId, code: 'new' } }),
    );
    const otherLead = await withTenantRaw(otherTenantId, (tx) =>
      tx.lead.create({
        data: {
          tenantId: otherTenantId,
          name: 'Other-tenant overdue',
          phone: '+209998880001',
          source: 'manual',
          stageId: otherStage.id,
          slaDueAt: new Date(Date.now() - 60_000),
          slaStatus: 'active',
        },
      }),
    );

    const breaches = await inTenant(() => sla.findBreachedLeads());
    const ids = breaches.map((b) => b.id);
    assert.ok(!ids.includes(otherLead.id), "tenant A scanner must not see tenant B's lead");

    // The reassign call should also not write any activity rows on the
    // other-tenant lead.
    const before = await withTenantRaw(otherTenantId, (tx) =>
      tx.leadActivity.count({ where: { leadId: otherLead.id } }),
    );
    await inTenant(() => sla.runReassignmentForBreaches(actorUserId));
    const after = await withTenantRaw(otherTenantId, (tx) =>
      tx.leadActivity.count({ where: { leadId: otherLead.id } }),
    );
    assert.equal(before, after, 'no activities written on cross-tenant lead');

    // Sanity-check the other-tenant scanner DOES see its own breach.
    const otherBreaches = await inOtherTenant(() => sla.findBreachedLeads());
    const otherIds = otherBreaches.map((b) => b.id);
    assert.ok(otherIds.includes(otherLead.id), 'other-tenant scanner sees its own breach');
  });
});
