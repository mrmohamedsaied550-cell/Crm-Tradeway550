/**
 * P2-11 — ReportsService integration tests.
 *
 * Real Postgres + a throwaway tenant. Covers:
 *   - filter composition: company / country / team narrow leads via
 *     `assignedTo.team.country.companyId` (the chain that didn't
 *     compose pre-P2-11).
 *   - summary returns the per-stage funnel and KPI counts.
 *   - timeseries returns one point per UTC day with zero-rows.
 *   - exportCsv produces a non-empty CSV with the expected sections.
 *
 * Two companies × two countries × two teams scaffold so cross-scope
 * assertions actually mean something.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';

import { hashPassword } from '../identity/password.util';
import { PrismaService } from '../prisma/prisma.service';
import { tenantContext } from '../tenants/tenant-context';
import { ReportsService } from './reports.service';

const TENANT_CODE = '__p2_11_reports__';

let prisma: PrismaClient;
let prismaSvc: PrismaService;
let reports: ReportsService;
let tenantId: string;

let companyA: string;
let companyB: string;
let countryAEgypt: string;
let countryBSaudi: string;
let teamAEgyptSales: string;
let teamBSaudiSales: string;
let agentInTeamA: string;
let agentInTeamB: string;

function inTenant<T>(fn: () => Promise<T>): Promise<T> {
  return tenantContext.run({ tenantId, tenantCode: TENANT_CODE, source: 'header' }, fn);
}

async function withTenantRaw<T>(tid: string, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return prisma.$transaction(async (tx: any) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.tenant_id = '${tid}'`);
    return fn(tx);
  });
}

describe('reports — P2-11 timeseries + filter composition', () => {
  before(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    prismaSvc = new PrismaService();
    reports = new ReportsService(prismaSvc);

    const tenant = await prisma.tenant.upsert({
      where: { code: TENANT_CODE },
      update: { isActive: true },
      create: { code: TENANT_CODE, name: 'P2-11 reports' },
    });
    tenantId = tenant.id;

    await withTenantRaw(tenantId, async (tx) => {
      // Org tree: 2 companies × 1 country each × 1 team each.
      const cA = await tx.company.create({
        data: { tenantId, code: 'co_a', name: 'Company A' },
      });
      companyA = cA.id;
      const cB = await tx.company.create({
        data: { tenantId, code: 'co_b', name: 'Company B' },
      });
      companyB = cB.id;
      const ctyA = await tx.country.create({
        data: { tenantId, companyId: companyA, code: 'EG', name: 'Egypt' },
      });
      countryAEgypt = ctyA.id;
      const ctyB = await tx.country.create({
        data: { tenantId, companyId: companyB, code: 'SA', name: 'Saudi' },
      });
      countryBSaudi = ctyB.id;
      const tA = await tx.team.create({
        data: { tenantId, countryId: countryAEgypt, name: 'Egypt Sales' },
      });
      teamAEgyptSales = tA.id;
      const tB = await tx.team.create({
        data: { tenantId, countryId: countryBSaudi, name: 'Saudi Sales' },
      });
      teamBSaudiSales = tB.id;

      const role = await tx.role.create({
        data: { tenantId, code: 'sales_agent', nameAr: 'وكيل', nameEn: 'Sales', level: 30 },
      });
      const hash = await hashPassword('Password@123', 4);
      const agentA = await tx.user.create({
        data: {
          tenantId,
          email: 'p211-egy-agent@test',
          name: 'Egypt Agent',
          passwordHash: hash,
          roleId: role.id,
          teamId: teamAEgyptSales,
        },
      });
      agentInTeamA = agentA.id;
      const agentB = await tx.user.create({
        data: {
          tenantId,
          email: 'p211-sau-agent@test',
          name: 'Saudi Agent',
          passwordHash: hash,
          roleId: role.id,
          teamId: teamBSaudiSales,
        },
      });
      agentInTeamB = agentB.id;

      // Default pipeline + canonical stages.
      const pipeline = await tx.pipeline.create({
        data: { tenantId, name: 'Default', isDefault: true, isActive: true },
        select: { id: true },
      });
      const stages = [
        { code: 'new', name: 'New', order: 10, isTerminal: false },
        { code: 'contacted', name: 'Contacted', order: 20, isTerminal: false },
        { code: 'converted', name: 'Converted', order: 40, isTerminal: true },
      ];
      const stageIdByCode = new Map<string, string>();
      for (const s of stages) {
        const row = await tx.pipelineStage.create({
          data: { tenantId, pipelineId: pipeline.id, ...s },
        });
        stageIdByCode.set(s.code, row.id);
      }

      // Plant 3 leads: 2 in Egypt (1 new + 1 converted), 1 in Saudi.
      // Use distinct created-at days so the timeseries has spread.
      const createdAts = [
        new Date('2026-05-01T10:00:00.000Z'),
        new Date('2026-05-02T10:00:00.000Z'),
        new Date('2026-05-03T10:00:00.000Z'),
      ];
      await tx.lead.create({
        data: {
          tenantId,
          name: 'EG Lead 1',
          phone: '+201001100001',
          source: 'manual',
          stageId: stageIdByCode.get('new')!,
          assignedToId: agentInTeamA,
          createdAt: createdAts[0],
        },
      });
      await tx.lead.create({
        data: {
          tenantId,
          name: 'EG Lead 2 (converted)',
          phone: '+201001100002',
          source: 'manual',
          stageId: stageIdByCode.get('converted')!,
          assignedToId: agentInTeamA,
          createdAt: createdAts[1],
        },
      });
      await tx.lead.create({
        data: {
          tenantId,
          name: 'SA Lead 1',
          phone: '+966501100001',
          source: 'manual',
          stageId: stageIdByCode.get('new')!,
          assignedToId: agentInTeamB,
          createdAt: createdAts[2],
        },
      });
    });
  });

  after(async () => {
    await prisma.tenant.delete({ where: { code: TENANT_CODE } }).catch(() => {});
    await prisma.$disconnect();
  });

  it('summary with no filters counts every lead in the tenant', async () => {
    const r = await inTenant(() => reports.summary({}));
    assert.equal(r.totalLeads, 3);
    const newStage = r.leadsByStage.find((s) => s.stageCode === 'new');
    const conv = r.leadsByStage.find((s) => s.stageCode === 'converted');
    assert.equal(newStage?.count, 2);
    assert.equal(conv?.count, 1);
    assert.equal(r.conversionRate, 33.3);
  });

  it("summary filtered by companyId only counts leads in that company's teams", async () => {
    const rA = await inTenant(() => reports.summary({ companyId: companyA }));
    assert.equal(rA.totalLeads, 2);
    const rB = await inTenant(() => reports.summary({ companyId: companyB }));
    assert.equal(rB.totalLeads, 1);
  });

  it('summary filtered by countryId narrows the same way', async () => {
    const r = await inTenant(() => reports.summary({ countryId: countryBSaudi }));
    assert.equal(r.totalLeads, 1);
  });

  it('summary filtered by teamId narrows to that team', async () => {
    const r = await inTenant(() => reports.summary({ teamId: teamAEgyptSales }));
    assert.equal(r.totalLeads, 2);
  });

  it('summary composes companyId + countryId + teamId filters (AND)', async () => {
    // Picking company A but country B (Saudi belongs to company B)
    // should return zero.
    const empty = await inTenant(() =>
      reports.summary({ companyId: companyA, countryId: countryBSaudi }),
    );
    assert.equal(empty.totalLeads, 0);
    // Consistent path: company A + country A + team A → 2.
    const all = await inTenant(() =>
      reports.summary({
        companyId: companyA,
        countryId: countryAEgypt,
        teamId: teamAEgyptSales,
      }),
    );
    assert.equal(all.totalLeads, 2);
  });

  it('timeseries returns one bucket per UTC day, with zero-rows', async () => {
    const r = await inTenant(() =>
      reports.timeseries({
        metric: 'leads_created',
        from: '2026-04-30T00:00:00.000Z',
        to: '2026-05-04T00:00:00.000Z',
      }),
    );
    assert.equal(r.metric, 'leads_created');
    // 5 calendar days inclusive.
    assert.equal(r.points.length, 5);
    const byDate = new Map(r.points.map((p) => [p.date, p.count]));
    assert.equal(byDate.get('2026-05-01'), 1);
    assert.equal(byDate.get('2026-05-02'), 1);
    assert.equal(byDate.get('2026-05-03'), 1);
    assert.equal(byDate.get('2026-04-30'), 0);
    assert.equal(byDate.get('2026-05-04'), 0);
  });

  it('timeseries respects scope filters', async () => {
    const r = await inTenant(() =>
      reports.timeseries({
        metric: 'leads_created',
        from: '2026-04-30T00:00:00.000Z',
        to: '2026-05-04T00:00:00.000Z',
        teamId: teamBSaudiSales,
      }),
    );
    const total = r.points.reduce((acc, p) => acc + p.count, 0);
    assert.equal(total, 1);
  });

  it('exportCsv returns a non-empty CSV with summary, stage rows, and the series', async () => {
    const csv = await inTenant(() => reports.exportCsv({}));
    // sanity-check section markers
    assert.match(csv, /summary,total_leads,3/);
    assert.match(csv, /stage,new,2/);
    assert.match(csv, /stage,converted,1/);
    assert.match(csv, /leads_created,2026-/);
  });
});
