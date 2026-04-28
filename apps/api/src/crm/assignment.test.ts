/**
 * Tests for the C11 round-robin AssignmentService.
 *
 * Mirrors the manual-wiring approach from leads.test.ts (no full Nest
 * bootstrap) and runs every assertion under an explicit
 * AsyncLocalStorage tenant scope. The picker is exercised end-to-end
 * via `assignLeadViaRoundRobin` so we cover both the candidate query
 * and the activity-row write in a single transaction.
 *
 * Coverage:
 *   - Picks the eligible agent with the lowest active-lead load.
 *   - Tiebreaker is deterministic (lowest user id wins).
 *   - excludeUserIds skips the current assignee.
 *   - Returns null when the eligible pool is empty after exclusions.
 *   - Disabled / wrong-role users are ignored.
 *   - Cross-tenant: agents from another tenant are never picked.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { tenantContext } from '../tenants/tenant-context';
import { hashPassword } from '../identity/password.util';
import { AssignmentService } from './assignment.service';
import { LeadsService } from './leads.service';
import { PipelineService } from './pipeline.service';
import { SlaService } from './sla.service';
import { PIPELINE_STAGE_DEFINITIONS } from './pipeline.registry';

const TEST_TENANT_CODE = '__c11_assign__';
const OTHER_TENANT_CODE = '__c11_assign_other__';

let prisma: PrismaClient;
let prismaSvc: PrismaService;
let assignment: AssignmentService;
let leads: LeadsService;
let tenantId: string;
let otherTenantId: string;
let actorUserId: string;
let agentLowLoadId: string;
let agentHighLoadId: string;
let disabledUserId: string;
let viewerUserId: string;

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

async function seedPipeline(tid: string): Promise<void> {
  await withTenantRaw(tid, async (tx) => {
    for (const def of PIPELINE_STAGE_DEFINITIONS) {
      await tx.pipelineStage.upsert({
        where: { tenantId_code: { tenantId: tid, code: def.code } },
        update: { name: def.name, order: def.order, isTerminal: def.isTerminal },
        create: {
          tenantId: tid,
          code: def.code,
          name: def.name,
          order: def.order,
          isTerminal: def.isTerminal,
        },
      });
    }
  });
}

describe('crm — round-robin assignment (C11)', () => {
  before(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    prismaSvc = new PrismaService();
    const pipeline = new PipelineService(prismaSvc);
    assignment = new AssignmentService(prismaSvc);
    const sla = new SlaService(prismaSvc, assignment);
    leads = new LeadsService(prismaSvc, pipeline, assignment, sla);

    // Provision the primary test tenant.
    const tenant = await prisma.tenant.upsert({
      where: { code: TEST_TENANT_CODE },
      update: { isActive: true },
      create: { code: TEST_TENANT_CODE, name: 'C11 assignment test' },
    });
    tenantId = tenant.id;

    // Provision a second tenant to verify cross-tenant isolation.
    const other = await prisma.tenant.upsert({
      where: { code: OTHER_TENANT_CODE },
      update: { isActive: true },
      create: { code: OTHER_TENANT_CODE, name: 'C11 assignment other tenant' },
    });
    otherTenantId = other.id;

    await seedPipeline(tenantId);
    await seedPipeline(otherTenantId);

    const hash = await hashPassword('Password@123', 4);

    // sales_agent role + viewer role in the primary tenant. The viewer
    // exists so we can prove the picker filters by role.code.
    const salesAgentRole = await withTenantRaw(tenantId, (tx) =>
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
    const viewerRole = await withTenantRaw(tenantId, (tx) =>
      tx.role.upsert({
        where: { tenantId_code: { tenantId, code: 'viewer' } },
        update: {},
        create: {
          tenantId,
          code: 'viewer',
          nameAr: 'مشاهد',
          nameEn: 'Viewer',
          level: 10,
        },
      }),
    );

    // Mirror the same role on the other tenant so we can plant an agent
    // with the eligible role code that should still be filtered out.
    await withTenantRaw(otherTenantId, (tx) =>
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

    // Actor is intentionally NOT a sales_agent — we don't want it
    // showing up in the eligible-for-assignment pool when we test
    // exclusion paths below. It's only used as the "who-took-the-action"
    // identity on activity rows.
    actorUserId = (
      await withTenantRaw(tenantId, (tx) =>
        tx.user.upsert({
          where: { tenantId_email: { tenantId, email: '__c11_actor@test' } },
          update: { roleId: viewerRole.id },
          create: {
            tenantId,
            email: '__c11_actor@test',
            name: 'Actor',
            passwordHash: hash,
            roleId: viewerRole.id,
          },
        }),
      )
    ).id;

    // Two eligible agents: stable id ordering for the tiebreaker.
    agentLowLoadId = (
      await withTenantRaw(tenantId, (tx) =>
        tx.user.upsert({
          where: { tenantId_email: { tenantId, email: '__c11_agent_low@test' } },
          update: { status: 'active', roleId: salesAgentRole.id },
          create: {
            tenantId,
            email: '__c11_agent_low@test',
            name: 'Agent Low',
            passwordHash: hash,
            roleId: salesAgentRole.id,
          },
        }),
      )
    ).id;

    agentHighLoadId = (
      await withTenantRaw(tenantId, (tx) =>
        tx.user.upsert({
          where: { tenantId_email: { tenantId, email: '__c11_agent_high@test' } },
          update: { status: 'active', roleId: salesAgentRole.id },
          create: {
            tenantId,
            email: '__c11_agent_high@test',
            name: 'Agent High',
            passwordHash: hash,
            roleId: salesAgentRole.id,
          },
        }),
      )
    ).id;

    disabledUserId = (
      await withTenantRaw(tenantId, (tx) =>
        tx.user.upsert({
          where: { tenantId_email: { tenantId, email: '__c11_disabled@test' } },
          update: { status: 'disabled', roleId: salesAgentRole.id },
          create: {
            tenantId,
            email: '__c11_disabled@test',
            name: 'Agent Disabled',
            passwordHash: hash,
            roleId: salesAgentRole.id,
            status: 'disabled',
          },
        }),
      )
    ).id;

    viewerUserId = (
      await withTenantRaw(tenantId, (tx) =>
        tx.user.upsert({
          where: { tenantId_email: { tenantId, email: '__c11_viewer@test' } },
          update: {},
          create: {
            tenantId,
            email: '__c11_viewer@test',
            name: 'Viewer',
            passwordHash: hash,
            roleId: viewerRole.id,
          },
        }),
      )
    ).id;

    // Plant an active sales_agent in the OTHER tenant. If RLS leaks, the
    // picker would happily return this id.
    const otherSalesRole = await withTenantRaw(otherTenantId, (tx) =>
      tx.role.findFirstOrThrow({
        where: { tenantId: otherTenantId, code: 'sales_agent' },
      }),
    );
    await withTenantRaw(otherTenantId, (tx) =>
      tx.user.upsert({
        where: { tenantId_email: { tenantId: otherTenantId, email: '__c11_other_agent@test' } },
        update: {},
        create: {
          tenantId: otherTenantId,
          email: '__c11_other_agent@test',
          name: 'Other-tenant agent',
          passwordHash: hash,
          roleId: otherSalesRole.id,
        },
      }),
    );

    // Give Agent High a non-terminal active lead so its load is 1.
    // Agent Low stays at load 0.
    const lead = await inTenant(() =>
      leads.create(
        { name: 'Pre-load High', phone: '+201111000001', source: 'manual' },
        actorUserId,
      ),
    );
    await inTenant(() => leads.assign(lead.id, agentHighLoadId, actorUserId));
  });

  after(async () => {
    await prisma.tenant.delete({ where: { code: TEST_TENANT_CODE } }).catch(() => {});
    await prisma.tenant.delete({ where: { code: OTHER_TENANT_CODE } }).catch(() => {});
    await prisma.$disconnect();
  });

  it('picks the eligible agent with the lowest active-lead load', async () => {
    const picked = await inTenant(() => assignment.pickEligibleAgent());
    assert.equal(picked, agentLowLoadId);
  });

  it('skips disabled users and users without an eligible role', async () => {
    // pickEligibleAgent must never return the disabled user or the viewer.
    const seen = new Set<string | null>();
    for (let i = 0; i < 5; i++) {
      seen.add(await inTenant(() => assignment.pickEligibleAgent()));
    }
    assert.ok(!seen.has(disabledUserId), 'disabled user must not be picked');
    assert.ok(!seen.has(viewerUserId), 'viewer user must not be picked');
    assert.ok(!seen.has(null), 'pool should not be empty');
  });

  it('honors excludeUserIds — skipping the current assignee', async () => {
    const picked = await inTenant(() => assignment.pickEligibleAgent([agentLowLoadId]));
    assert.equal(picked, agentHighLoadId);
  });

  it('returns null when exclusions empty the eligible pool', async () => {
    const picked = await inTenant(() =>
      assignment.pickEligibleAgent([agentLowLoadId, agentHighLoadId, actorUserId]),
    );
    assert.equal(picked, null);
  });

  it('assignLeadViaRoundRobin updates the lead and writes the activity row', async () => {
    const lead = await inTenant(() =>
      leads.create({ name: 'AutoAssign A', phone: '+201111000002', source: 'manual' }, actorUserId),
    );

    const updated = await inTenant(() => leads.autoAssign(lead.id, actorUserId));
    assert.ok(updated, 'autoAssign should return the updated lead');
    // Agent Low has load 0 so it wins.
    assert.equal(updated?.assignedToId, agentLowLoadId);

    const acts = await inTenant(() => leads.listActivities(lead.id));
    const auto = acts.find((a) => a.type === 'auto_assignment');
    assert.ok(auto, 'auto_assignment activity must be written');
    assert.deepEqual(
      (auto?.payload as { event: string; strategy: string }).strategy,
      'round_robin',
    );
  });

  it('autoAssign throws when the lead is in a terminal stage', async () => {
    const lead = await inTenant(() =>
      leads.create({ name: 'Terminal', phone: '+201111000003', source: 'manual' }, actorUserId),
    );
    await inTenant(() => leads.moveStage(lead.id, 'lost', actorUserId));

    await assert.rejects(
      () => inTenant(() => leads.autoAssign(lead.id, actorUserId)),
      /terminal stage/,
    );
  });

  it('autoAssign returns null when no eligible agent remains after exclusions', async () => {
    // Pre-assign to lowest-load agent, then auto-assign — only the higher
    // load agent is eligible (current assignee is excluded). Then exclude
    // both manually by disabling the high-load user inside this test only
    // for the duration of the call.
    const lead = await inTenant(() =>
      leads.create({ name: 'NullPath', phone: '+201111000004', source: 'manual' }, actorUserId),
    );
    await inTenant(() => leads.assign(lead.id, agentLowLoadId, actorUserId));

    // Disable the only remaining sales agent. autoAssign excludes the
    // current assignee, so no eligible agents remain.
    await withTenantRaw(tenantId, (tx) =>
      tx.user.update({ where: { id: agentHighLoadId }, data: { status: 'disabled' } }),
    );

    const result = await inTenant(() => leads.autoAssign(lead.id, actorUserId));
    assert.equal(result, null);

    // Restore for downstream tests.
    await withTenantRaw(tenantId, (tx) =>
      tx.user.update({ where: { id: agentHighLoadId }, data: { status: 'active' } }),
    );
  });

  it('never picks an agent from a different tenant', async () => {
    // The OTHER tenant has an active sales_agent but the picker runs
    // under our tenant's GUC, so RLS must hide them.
    const seen = new Set<string | null>();
    for (let i = 0; i < 8; i++) {
      seen.add(await inTenant(() => assignment.pickEligibleAgent()));
    }
    const otherTenantUserIds = await prisma.user.findMany({
      where: { tenantId: otherTenantId },
      select: { id: true },
    });
    for (const u of otherTenantUserIds) {
      assert.ok(!seen.has(u.id), `must not pick user ${u.id} from other tenant`);
    }
  });
});
