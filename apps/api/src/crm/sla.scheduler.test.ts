/**
 * C29 — SLA scheduler tests.
 *
 * Covers:
 *   - the env-driven enable/disable contract
 *   - runOnce iterates every active tenant and counts breaches
 *   - runOnce isolates tenant failures (one tenant throwing does not
 *     stop the rest)
 *   - the @Cron-decorated tick() de-duplicates overlapping ticks via
 *     the in-process running flag
 *
 * Real Postgres so the underlying SLA + RLS path is exercised.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { tenantContext } from '../tenants/tenant-context';
import { TenantSettingsService } from '../tenants/tenant-settings.service';
import { AssignmentService } from './assignment.service';
import { LeadsService } from './leads.service';
import { PipelineService } from './pipeline.service';
import { SlaService } from './sla.service';
import { SlaSchedulerService } from './sla.scheduler';
import { PIPELINE_STAGE_DEFINITIONS } from './pipeline.registry';
import { hashPassword } from '../identity/password.util';

const TENANT_A_CODE = '__c29_sched_a__';
const TENANT_B_CODE = '__c29_sched_b__';

let prisma: PrismaClient;
let prismaSvc: PrismaService;
let scheduler: SlaSchedulerService;
let leadsSvc: LeadsService;
let slaSvc: SlaService;
let tenantAId: string;
let tenantBId: string;
let agentAaId: string;
let agentAbId: string;
let agentBaId: string;
let agentBbId: string;

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
        update: {},
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

async function seedAgents(tid: string, prefix: string): Promise<{ a: string; b: string }> {
  const hash = await hashPassword('Password@123', 4);
  return withTenantRaw(tid, async (tx) => {
    const role = await tx.role.upsert({
      where: { tenantId_code: { tenantId: tid, code: 'sales_agent' } },
      update: {},
      create: {
        tenantId: tid,
        code: 'sales_agent',
        nameAr: 'وكيل',
        nameEn: 'Sales Agent',
        level: 30,
      },
    });
    const a = await tx.user.upsert({
      where: { tenantId_email: { tenantId: tid, email: `${prefix}-a@test` } },
      update: { status: 'active', roleId: role.id },
      create: {
        tenantId: tid,
        email: `${prefix}-a@test`,
        name: `${prefix} A`,
        passwordHash: hash,
        roleId: role.id,
      },
    });
    const b = await tx.user.upsert({
      where: { tenantId_email: { tenantId: tid, email: `${prefix}-b@test` } },
      update: { status: 'active', roleId: role.id },
      create: {
        tenantId: tid,
        email: `${prefix}-b@test`,
        name: `${prefix} B`,
        passwordHash: hash,
        roleId: role.id,
      },
    });
    return { a: a.id, b: b.id };
  });
}

function inTenant<T>(tid: string, code: string, fn: () => Promise<T>): Promise<T> {
  return tenantContext.run({ tenantId: tid, tenantCode: code, source: 'header' }, fn);
}

describe('crm — sla scheduler (C29)', () => {
  before(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    prismaSvc = new PrismaService();

    const a = await prisma.tenant.upsert({
      where: { code: TENANT_A_CODE },
      update: { isActive: true },
      create: { code: TENANT_A_CODE, name: 'C29 sched tenant A' },
    });
    tenantAId = a.id;
    const b = await prisma.tenant.upsert({
      where: { code: TENANT_B_CODE },
      update: { isActive: true },
      create: { code: TENANT_B_CODE, name: 'C29 sched tenant B' },
    });
    tenantBId = b.id;

    await seedPipeline(tenantAId);
    await seedPipeline(tenantBId);
    const agentsA = await seedAgents(tenantAId, 'c29-a');
    const agentsB = await seedAgents(tenantBId, 'c29-b');
    agentAaId = agentsA.a;
    agentAbId = agentsA.b;
    agentBaId = agentsB.a;
    agentBbId = agentsB.b;

    const pipelineSvc = new PipelineService(prismaSvc);
    const assignment = new AssignmentService(prismaSvc);
    const audit = new AuditService(prismaSvc);
    const tenantSettings = new TenantSettingsService(prismaSvc, audit);
    slaSvc = new SlaService(prismaSvc, assignment, undefined, tenantSettings);
    // A5 — LeadsService no longer takes AssignmentService directly;
    // routing is delegated to DistributionService (not exercised by
    // this scheduler test, so omitted).
    leadsSvc = new LeadsService(prismaSvc, pipelineSvc, slaSvc, tenantSettings);
    scheduler = new SlaSchedulerService(prismaSvc, slaSvc);
  });

  after(async () => {
    await prisma.tenant.delete({ where: { code: TENANT_A_CODE } }).catch(() => {});
    await prisma.tenant.delete({ where: { code: TENANT_B_CODE } }).catch(() => {});
    await prisma.$disconnect();
  });

  it('isEnabled honours SLA_SCHEDULER_ENABLED, defaulting on in production', () => {
    assert.equal(scheduler.isEnabled({ NODE_ENV: 'test' }), false);
    assert.equal(scheduler.isEnabled({ NODE_ENV: 'production' }), true);
    assert.equal(
      scheduler.isEnabled({ NODE_ENV: 'production', SLA_SCHEDULER_ENABLED: 'false' }),
      false,
    );
    assert.equal(scheduler.isEnabled({ NODE_ENV: 'test', SLA_SCHEDULER_ENABLED: 'true' }), true);
    assert.equal(scheduler.isEnabled({ NODE_ENV: 'test', SLA_SCHEDULER_ENABLED: '1' }), true);
  });

  it('runOnce scans every active tenant and processes breaches in each', async () => {
    // Plant an overdue lead in EACH tenant.
    const past = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2h ago
    const leadA = await inTenant(tenantAId, TENANT_A_CODE, () =>
      leadsSvc.create(
        { name: 'Tenant A breach', phone: '+201001100400', source: 'manual' },
        agentAaId,
      ),
    );
    const leadB = await inTenant(tenantBId, TENANT_B_CODE, () =>
      leadsSvc.create(
        { name: 'Tenant B breach', phone: '+966500110400', source: 'manual' },
        agentBaId,
      ),
    );
    // Force both leads into "overdue + assigned" state so the scanner sees them.
    await withTenantRaw(tenantAId, (tx) =>
      tx.lead.update({
        where: { id: leadA.id },
        data: { slaDueAt: past, slaStatus: 'active', assignedToId: agentAaId },
      }),
    );
    await withTenantRaw(tenantBId, (tx) =>
      tx.lead.update({
        where: { id: leadB.id },
        data: { slaDueAt: past, slaStatus: 'active', assignedToId: agentBaId },
      }),
    );

    const summary = await scheduler.runOnce();
    assert.ok(summary.tenantsScanned >= 2, 'must have scanned both tenants');
    assert.ok(summary.breachesProcessed >= 2, 'each tenant produced at least one breach result');
    assert.equal(summary.failures, 0);

    // Each lead is now either reassigned to the OTHER agent in its
    // tenant or marked breached. Verify cross-tenant isolation: tenant
    // A's lead must NOT be assigned to a tenant B agent.
    const refreshedA = await withTenantRaw(tenantAId, (tx) =>
      tx.lead.findUnique({ where: { id: leadA.id }, select: { assignedToId: true } }),
    );
    assert.notEqual(refreshedA?.assignedToId, agentBaId);
    assert.notEqual(refreshedA?.assignedToId, agentBbId);

    const refreshedB = await withTenantRaw(tenantBId, (tx) =>
      tx.lead.findUnique({ where: { id: leadB.id }, select: { assignedToId: true } }),
    );
    assert.notEqual(refreshedB?.assignedToId, agentAaId);
    assert.notEqual(refreshedB?.assignedToId, agentAbId);
  });

  it('runOnce does not blow up the whole sweep when one tenant fails', async () => {
    // Create a one-off scheduler with a stub SLA service that throws
    // for tenant A, succeeds for tenant B.
    const fakeSla = {
      runReassignmentForBreaches: async () => {
        const ctx = tenantContext.getStore();
        if (ctx?.tenantCode === TENANT_A_CODE) throw new Error('boom');
        return [];
      },
    } as unknown as SlaService;
    const local = new SlaSchedulerService(prismaSvc, fakeSla);
    const summary = await local.runOnce();
    assert.equal(summary.failures >= 1, true, 'tenant A failure should be counted');
    // tenantsScanned counts every active tenant including the failing one.
    assert.ok(summary.tenantsScanned >= 2);
  });

  it('tick() is a no-op when isEnabled() is false', async () => {
    // NODE_ENV is "test" in our suite, so isEnabled should be false by
    // default and the tick should be a fast no-op (no breaches counted).
    let called = false;
    const fakeSla = {
      runReassignmentForBreaches: async () => {
        called = true;
        return [];
      },
    } as unknown as SlaService;
    const local = new SlaSchedulerService(prismaSvc, fakeSla);
    await local.tick();
    assert.equal(called, false, 'disabled scheduler must not invoke SLA service');
  });

  it('tick() refuses to overlap with an in-progress tick (mutex)', async () => {
    // Force-enable for this test only.
    const originalEnv = process.env['SLA_SCHEDULER_ENABLED'];
    process.env['SLA_SCHEDULER_ENABLED'] = 'true';
    try {
      let inFlight = 0;
      let maxConcurrent = 0;
      const fakeSla = {
        runReassignmentForBreaches: async () => {
          inFlight += 1;
          maxConcurrent = Math.max(maxConcurrent, inFlight);
          await new Promise((r) => setTimeout(r, 30));
          inFlight -= 1;
          return [];
        },
      } as unknown as SlaService;
      const local = new SlaSchedulerService(prismaSvc, fakeSla);
      // Fire two ticks back-to-back; the second should bail because the
      // first is still in flight.
      const [, second] = await Promise.all([local.tick(), local.tick()]);
      // tick() resolves to void in both branches; the proof is that
      // the mock never saw two concurrent invocations.
      void second;
      assert.equal(maxConcurrent, 1, 'mutex must serialize ticks');
    } finally {
      if (originalEnv === undefined) delete process.env['SLA_SCHEDULER_ENABLED'];
      else process.env['SLA_SCHEDULER_ENABLED'] = originalEnv;
    }
  });
});
