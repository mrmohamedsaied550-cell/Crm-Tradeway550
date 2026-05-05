/**
 * Phase D3 — D3.2: SLA threshold engine — integration tests.
 *
 * Real Postgres + a throwaway tenant. Verifies the four contracts the
 * D3.2 spec ships:
 *
 *   1. recomputeThreshold writes ONE LeadActivity row of type
 *      'sla_threshold_crossed' on a transition (ok → t100), updates
 *      `sla_threshold` + `sla_threshold_at`, and returns the
 *      transition shape.
 *
 *   2. recomputeThreshold is a no-op when the bucket is unchanged.
 *      Returns null and writes nothing.
 *
 *   3. recomputeThreshold is a no-op for non-'open' leads, paused
 *      timers, and missing slaDueAt — preserves the legacy slaStatus
 *      contract bit-for-bit.
 *
 *   4. SlaSchedulerService.runOnce produces threshold transitions
 *      when D3_ENGINE_V1=true and produces ZERO when the flag is
 *      false (existing breach behaviour byte-identical).
 *
 * Local: same DB-unreachable hook-failure pattern as every other
 * integration test in this repo when no Docker daemon is available;
 * CI runs against postgres:16-alpine.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { tenantContext } from '../tenants/tenant-context';
import { TenantSettingsService } from '../tenants/tenant-settings.service';
import { AssignmentService } from './assignment.service';
import { SlaService } from './sla.service';
import { SlaSchedulerService } from './sla.scheduler';
import { SlaThresholdsService } from './sla-thresholds.service';

const TENANT_CODE = '__d32_thresholds__';

let prisma: PrismaClient;
let prismaSvc: PrismaService;
let sla: SlaService;
let scheduler: SlaSchedulerService;
let tenantId: string;
let entryStageId: string;
let lostStageId: string;

async function withTenantRaw<T>(tid: string, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return prisma.$transaction(async (tx: any) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.tenant_id = '${tid}'`);
    return fn(tx);
  });
}

/** Run a recomputeThreshold call inside both AsyncLocalStorage tenant
 *  context AND a tx with `SET LOCAL app.tenant_id`. The service
 *  expects both — AsyncLocalStorage for `requireTenantId()` and the
 *  GUC for FORCE-RLS reads. */
function runRecompute(leadId: string, now: Date) {
  return tenantContext.run({ tenantId, tenantCode: TENANT_CODE, source: 'header' }, () =>
    withTenantRaw(tenantId, (tx) =>
      // The integration test uses the raw PrismaClient as the tx —
      // matches every other RLS-aware test in this repo.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sla.recomputeThreshold(tx as any, leadId, now),
    ),
  );
}

/** Build an `slaDueAt` such that elapsed/budget = `ratio`. */
function dueAtForRatio(ratio: number, budgetMinutes: number, now: Date): Date {
  const budgetMs = budgetMinutes * 60_000;
  const elapsedMs = ratio * budgetMs;
  return new Date(now.getTime() + (budgetMs - elapsedMs));
}

describe('D3.2 — SLA threshold engine integration', () => {
  before(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    prismaSvc = new PrismaService();
    const audit = new AuditService(prismaSvc);
    const tenantSettings = new TenantSettingsService(prismaSvc, audit);
    const assignment = new AssignmentService(prismaSvc);
    const thresholds = new SlaThresholdsService();
    sla = new SlaService(
      prismaSvc,
      assignment,
      undefined,
      tenantSettings,
      undefined,
      undefined,
      thresholds,
    );
    scheduler = new SlaSchedulerService(prismaSvc, sla);

    const tenant = await prisma.tenant.upsert({
      where: { code: TENANT_CODE },
      update: { isActive: true },
      create: { code: TENANT_CODE, name: 'D3.2 thresholds' },
    });
    tenantId = tenant.id;

    await withTenantRaw(tenantId, async (tx) => {
      await tx.tenantSettings.upsert({
        where: { tenantId },
        update: {},
        create: { tenantId, timezone: 'Africa/Cairo', slaMinutes: 60, defaultDialCode: '+20' },
      });
      const pipe = await tx.pipeline.create({
        data: { tenantId, name: 'Default', isDefault: true, isActive: true },
        select: { id: true },
      });
      const entry = await tx.pipelineStage.create({
        data: { tenantId, pipelineId: pipe.id, code: 'new', name: 'New', order: 10 },
      });
      entryStageId = entry.id;
      const lost = await tx.pipelineStage.create({
        data: {
          tenantId,
          pipelineId: pipe.id,
          code: 'd32-lost',
          name: 'Lost',
          order: 90,
          isTerminal: true,
          terminalKind: 'lost',
        },
      });
      lostStageId = lost.id;
    });
  });

  after(async () => {
    await prisma.tenant.delete({ where: { code: TENANT_CODE } }).catch(() => {});
    await prisma.$disconnect();
  });

  /** Fresh open lead with `slaDueAt` set to the requested ratio. */
  async function makeLead(ratio: number, now: Date): Promise<string> {
    return withTenantRaw(tenantId, async (tx) => {
      const lead = await tx.lead.create({
        data: {
          tenantId,
          name: 'L',
          phone: `+201001${Math.floor(Math.random() * 1_000_000)
            .toString()
            .padStart(6, '0')}`,
          source: 'manual',
          stageId: entryStageId,
          lifecycleState: 'open',
          slaStatus: 'active',
          slaDueAt: dueAtForRatio(ratio, 60, now),
          slaThreshold: 'ok',
        },
        select: { id: true },
      });
      return lead.id;
    });
  }

  it('writes activity + updates lead on ok → t100 transition', async () => {
    const now = new Date('2026-05-05T12:00:00.000Z');
    const leadId = await makeLead(1.2, now); // ratio 1.2 → t100

    const transition = await runRecompute(leadId, now);
    assert.ok(transition, 'transition returned');
    assert.equal(transition!.from, 'ok');
    assert.equal(transition!.to, 't100');
    assert.equal(transition!.budgetMinutes, 60);

    const updated = await withTenantRaw(tenantId, (tx) =>
      tx.lead.findUnique({
        where: { id: leadId },
        select: { slaThreshold: true, slaThresholdAt: true },
      }),
    );
    assert.equal(updated!.slaThreshold, 't100');
    assert.ok(updated!.slaThresholdAt, 'slaThresholdAt stamped');

    const activities = await withTenantRaw(tenantId, (tx) =>
      tx.leadActivity.findMany({
        where: { leadId, type: 'sla_threshold_crossed' },
        select: { type: true, payload: true, actionSource: true },
      }),
    );
    assert.equal(activities.length, 1, 'exactly one threshold activity row');
    assert.equal(activities[0]!.actionSource, 'system');
    const payload = activities[0]!.payload as Record<string, unknown>;
    assert.equal(payload['from'], 'ok');
    assert.equal(payload['to'], 't100');
    assert.equal(payload['event'], 'sla_threshold_crossed');
  });

  it('returns null and writes nothing when threshold is unchanged', async () => {
    const now = new Date('2026-05-05T12:00:00.000Z');
    const leadId = await makeLead(1.2, now);

    // First call writes ok → t100.
    await runRecompute(leadId, now);
    // Second call with the same now sees threshold == 't100' already.
    const noChange = await runRecompute(leadId, now);
    assert.equal(noChange, null, 'no-op when bucket unchanged');

    const activities = await withTenantRaw(tenantId, (tx) =>
      tx.leadActivity.findMany({ where: { leadId, type: 'sla_threshold_crossed' } }),
    );
    assert.equal(activities.length, 1, 'still only one activity row');
  });

  it('no-ops on paused / closed / breached / no-due-at leads', async () => {
    const now = new Date('2026-05-05T12:00:00.000Z');
    // 1. paused
    const pausedId = await makeLead(1.2, now);
    await withTenantRaw(tenantId, (tx) =>
      tx.lead.update({
        where: { id: pausedId },
        data: { slaStatus: 'paused', slaDueAt: null },
      }),
    );
    assert.equal(await runRecompute(pausedId, now), null);

    // 2. terminal stage (lifecycleState != 'open' AND stage.isTerminal)
    const lostId = await makeLead(1.2, now);
    await withTenantRaw(tenantId, (tx) =>
      tx.lead.update({
        where: { id: lostId },
        data: { lifecycleState: 'lost', stageId: lostStageId },
      }),
    );
    assert.equal(await runRecompute(lostId, now), null);

    // 3. breached (slaStatus = 'breached' — legacy binary path
    //    handles this; threshold engine stays out of the way)
    const breachedId = await makeLead(1.5, now);
    await withTenantRaw(tenantId, (tx) =>
      tx.lead.update({
        where: { id: breachedId },
        data: { slaStatus: 'breached' },
      }),
    );
    assert.equal(await runRecompute(breachedId, now), null);
  });

  it('scheduler with D3_ENGINE_V1=false produces zero threshold transitions', async () => {
    const now = new Date('2026-05-05T12:00:00.000Z');
    await makeLead(1.2, now);

    const prev = process.env['D3_ENGINE_V1'];
    process.env['D3_ENGINE_V1'] = 'false';
    try {
      const result = await scheduler.runOnce(now);
      assert.equal(result.thresholdTransitions, 0, 'flag-off → no threshold pass');
    } finally {
      if (prev === undefined) delete process.env['D3_ENGINE_V1'];
      else process.env['D3_ENGINE_V1'] = prev;
    }
  });

  it('scheduler with D3_ENGINE_V1=true emits threshold transitions for at-risk leads', async () => {
    const now = new Date('2026-05-05T12:30:00.000Z');
    // Two fresh leads: one at 't75' ratio, one already 'ok'.
    const atRiskId = await makeLead(0.8, now);
    const okId = await makeLead(0.5, now);

    const prev = process.env['D3_ENGINE_V1'];
    process.env['D3_ENGINE_V1'] = 'true';
    try {
      const result = await scheduler.runOnce(now);
      assert.ok(result.thresholdTransitions >= 1, 'at-risk lead transitioned');
    } finally {
      if (prev === undefined) delete process.env['D3_ENGINE_V1'];
      else process.env['D3_ENGINE_V1'] = prev;
    }

    const atRisk = await withTenantRaw(tenantId, (tx) =>
      tx.lead.findUnique({ where: { id: atRiskId }, select: { slaThreshold: true } }),
    );
    const ok = await withTenantRaw(tenantId, (tx) =>
      tx.lead.findUnique({ where: { id: okId }, select: { slaThreshold: true } }),
    );
    assert.equal(atRisk!.slaThreshold, 't75', 'at-risk lead bucket bumped');
    assert.equal(ok!.slaThreshold, 'ok', 'ok lead untouched');
  });
});
