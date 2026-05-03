/**
 * Phase 1 — K1: LeadsService.listByStage (Kanban grouped query).
 *
 * Real Postgres + a throwaway tenant. Verifies:
 *   - returns one bucket per stage of the requested pipeline,
 *     ordered by stage.order asc.
 *   - empty stages return totalCount=0 + leads=[].
 *   - totalCount is the FILTER total, not the perStage cap.
 *   - perStage caps the cards inside the bucket.
 *   - all the same filters as list() narrow correctly:
 *       assignee, source, slaStatus, createdFrom/To, q, unassigned.
 *   - leads from a DIFFERENT pipeline are excluded.
 *   - unknown / empty pipeline → typed 404.
 *   - RLS still gates: another tenant's pipeline is invisible.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { AgentCapacitiesService } from '../distribution/capacities.service';
import { DistributionService } from '../distribution/distribution.service';
import { LeadRoutingLogService } from '../distribution/routing-log.service';
import { DistributionRulesService } from '../distribution/rules.service';
import { PrismaService } from '../prisma/prisma.service';
import { tenantContext } from '../tenants/tenant-context';
import { TenantSettingsService } from '../tenants/tenant-settings.service';
import { LeadsService } from './leads.service';
import { PipelineService } from './pipeline.service';
import { AssignmentService } from './assignment.service';
import { SlaService } from './sla.service';

const TENANT_CODE = '__k1_listbystage__';
const OTHER_TENANT_CODE = '__k1_listbystage_other__';

let prisma: PrismaClient;
let prismaSvc: PrismaService;
let leads: LeadsService;
let tenantId: string;
let otherTenantId: string;
let assigneeAId: string;
let assigneeBId: string;
let pipelineAId: string;
let pipelineBId: string;
let pNewId: string;
let pContactedId: string;
let pBStageOnlyId: string;

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

describe('crm — leads.listByStage (Kanban grouped query)', () => {
  before(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    prismaSvc = new PrismaService();
    const pipeline = new PipelineService(prismaSvc);
    const assignment = new AssignmentService(prismaSvc);
    const audit = new AuditService(prismaSvc);
    const tenantSettings = new TenantSettingsService(prismaSvc, audit);
    const sla = new SlaService(prismaSvc, assignment, undefined, tenantSettings);
    const rules = new DistributionRulesService(prismaSvc);
    const capacities = new AgentCapacitiesService(prismaSvc);
    const routingLog = new LeadRoutingLogService(prismaSvc);
    const distribution = new DistributionService(prismaSvc, rules, capacities, routingLog);
    leads = new LeadsService(prismaSvc, pipeline, sla, tenantSettings, distribution);

    const tenant = await prisma.tenant.upsert({
      where: { code: TENANT_CODE },
      update: { isActive: true },
      create: { code: TENANT_CODE, name: 'K1 listByStage' },
    });
    tenantId = tenant.id;
    const other = await prisma.tenant.upsert({
      where: { code: OTHER_TENANT_CODE },
      update: { isActive: true },
      create: { code: OTHER_TENANT_CODE, name: 'K1 other tenant' },
    });
    otherTenantId = other.id;

    await withTenantRaw(tenantId, async (tx) => {
      await tx.tenantSettings.upsert({
        where: { tenantId },
        update: {},
        create: { tenantId, timezone: 'Africa/Cairo', slaMinutes: 60, defaultDialCode: '+20' },
      });

      const role = await tx.role.create({
        data: { tenantId, code: 'sales_agent', nameAr: 'مبيعات', nameEn: 'Sales', level: 30 },
      });
      const a = await tx.user.create({
        data: {
          tenantId,
          email: 'k1-a@test',
          name: 'Assignee A',
          passwordHash: 'x',
          status: 'active',
          roleId: role.id,
        },
      });
      assigneeAId = a.id;
      const b = await tx.user.create({
        data: {
          tenantId,
          email: 'k1-b@test',
          name: 'Assignee B',
          passwordHash: 'x',
          status: 'active',
          roleId: role.id,
        },
      });
      assigneeBId = b.id;

      // Pipeline A — three stages: new, contacted, converted (terminal).
      const pA = await tx.pipeline.create({
        data: { tenantId, name: 'Pipeline A', isDefault: true, isActive: true },
        select: { id: true },
      });
      pipelineAId = pA.id;
      const sNew = await tx.pipelineStage.create({
        data: { tenantId, pipelineId: pA.id, code: 'new', name: 'New', order: 10 },
      });
      pNewId = sNew.id;
      const sCont = await tx.pipelineStage.create({
        data: { tenantId, pipelineId: pA.id, code: 'contacted', name: 'Contacted', order: 20 },
      });
      pContactedId = sCont.id;
      await tx.pipelineStage.create({
        data: {
          tenantId,
          pipelineId: pA.id,
          code: 'converted',
          name: 'Converted',
          order: 40,
          isTerminal: true,
        },
      });

      // Pipeline B — single stage. Used to verify cross-pipeline
      // isolation in the bucket response.
      const pB = await tx.pipeline.create({
        data: { tenantId, name: 'Pipeline B', isDefault: false, isActive: true },
        select: { id: true },
      });
      pipelineBId = pB.id;
      const bStage = await tx.pipelineStage.create({
        data: { tenantId, pipelineId: pB.id, code: 'b_only', name: 'B only', order: 10 },
      });
      pBStageOnlyId = bStage.id;
    });

    // Seed leads on Pipeline A:
    //   New:        4 (2 assigned to A, 1 to B, 1 unassigned)
    //   Contacted:  2 (1 with source='meta', 1 with source='manual')
    //   Converted:  0 (empty bucket — must still appear)
    //
    // Plus 1 lead on Pipeline B (different pipeline; must NOT appear
    // in the Pipeline A response).
    await withTenantRaw(tenantId, async (tx) => {
      await tx.lead.create({
        data: {
          tenantId,
          pipelineId: pipelineAId,
          stageId: pNewId,
          name: 'A1',
          phone: '+201001000001',
          source: 'manual',
          assignedToId: assigneeAId,
          slaStatus: 'active',
        },
      });
      await tx.lead.create({
        data: {
          tenantId,
          pipelineId: pipelineAId,
          stageId: pNewId,
          name: 'A2',
          phone: '+201001000002',
          source: 'manual',
          assignedToId: assigneeAId,
          slaStatus: 'active',
        },
      });
      await tx.lead.create({
        data: {
          tenantId,
          pipelineId: pipelineAId,
          stageId: pNewId,
          name: 'A3',
          phone: '+201001000003',
          source: 'meta',
          assignedToId: assigneeBId,
          slaStatus: 'breached',
        },
      });
      await tx.lead.create({
        data: {
          tenantId,
          pipelineId: pipelineAId,
          stageId: pNewId,
          name: 'A4',
          phone: '+201001000004',
          source: 'tiktok',
          assignedToId: null,
          slaStatus: 'active',
        },
      });
      await tx.lead.create({
        data: {
          tenantId,
          pipelineId: pipelineAId,
          stageId: pContactedId,
          name: 'B1',
          phone: '+201001000005',
          source: 'meta',
          assignedToId: assigneeAId,
          slaStatus: 'active',
        },
      });
      await tx.lead.create({
        data: {
          tenantId,
          pipelineId: pipelineAId,
          stageId: pContactedId,
          name: 'B2',
          phone: '+201001000006',
          source: 'manual',
          assignedToId: assigneeAId,
          slaStatus: 'active',
        },
      });
      // Pipeline B noise.
      await tx.lead.create({
        data: {
          tenantId,
          pipelineId: pipelineBId,
          stageId: pBStageOnlyId,
          name: 'OnB',
          phone: '+201001000099',
          source: 'manual',
          slaStatus: 'active',
        },
      });
    });
  });

  after(async () => {
    await prisma.tenant.delete({ where: { code: TENANT_CODE } }).catch(() => {});
    await prisma.tenant.delete({ where: { code: OTHER_TENANT_CODE } }).catch(() => {});
    await prisma.$disconnect();
  });

  it('returns one bucket per stage in stage.order, including empty ones', async () => {
    const r = await inTenant(() => leads.listByStage({ pipelineId: pipelineAId, perStage: 50 }));
    assert.equal(r.pipelineId, pipelineAId);
    assert.equal(r.stages.length, 3);
    assert.deepEqual(
      r.stages.map((b) => b.stage.code),
      ['new', 'contacted', 'converted'],
    );
    // The Converted stage has zero leads but must still appear so
    // the Kanban renders the column.
    const converted = r.stages.find((b) => b.stage.code === 'converted')!;
    assert.equal(converted.totalCount, 0);
    assert.deepEqual(converted.leads, []);
  });

  it('totalCount is the filter total, not the perStage cap', async () => {
    const r = await inTenant(() => leads.listByStage({ pipelineId: pipelineAId, perStage: 2 }));
    const newBucket = r.stages.find((b) => b.stage.code === 'new')!;
    assert.equal(newBucket.totalCount, 4);
    assert.equal(newBucket.leads.length, 2); // capped at perStage
  });

  it('cards are ordered by createdAt desc', async () => {
    const r = await inTenant(() => leads.listByStage({ pipelineId: pipelineAId, perStage: 50 }));
    const newBucket = r.stages.find((b) => b.stage.code === 'new')!;
    for (let i = 1; i < newBucket.leads.length; i += 1) {
      const prev = new Date(newBucket.leads[i - 1]!.createdAt).getTime();
      const cur = new Date(newBucket.leads[i]!.createdAt).getTime();
      assert.ok(prev >= cur, 'newest first');
    }
  });

  it('assigneeId filter narrows correctly', async () => {
    const r = await inTenant(() =>
      leads.listByStage({ pipelineId: pipelineAId, assignedToId: assigneeAId, perStage: 50 }),
    );
    const allLeads = r.stages.flatMap((b) => b.leads);
    for (const l of allLeads) {
      assert.equal(l.assignedToId, assigneeAId);
    }
    // A1 + A2 in New + B1 + B2 in Contacted = 4 leads.
    assert.equal(allLeads.length, 4);
    assert.equal(r.stages.find((b) => b.stage.code === 'new')!.totalCount, 2);
    assert.equal(r.stages.find((b) => b.stage.code === 'contacted')!.totalCount, 2);
  });

  it('source filter narrows correctly', async () => {
    const r = await inTenant(() =>
      leads.listByStage({ pipelineId: pipelineAId, source: 'meta', perStage: 50 }),
    );
    const all = r.stages.flatMap((b) => b.leads);
    assert.deepEqual(all.map((l) => l.name).sort(), ['A3', 'B1']);
  });

  it('slaStatus=breached filter narrows correctly', async () => {
    const r = await inTenant(() =>
      leads.listByStage({ pipelineId: pipelineAId, slaStatus: 'breached', perStage: 50 }),
    );
    const all = r.stages.flatMap((b) => b.leads);
    assert.equal(all.length, 1);
    assert.equal(all[0]!.name, 'A3');
  });

  it('unassigned=true narrows to leads with no owner', async () => {
    const r = await inTenant(() =>
      leads.listByStage({ pipelineId: pipelineAId, unassigned: true, perStage: 50 }),
    );
    const all = r.stages.flatMap((b) => b.leads);
    assert.equal(all.length, 1);
    assert.equal(all[0]!.name, 'A4');
  });

  it('text search (q) matches name + phone', async () => {
    const byName = await inTenant(() =>
      leads.listByStage({ pipelineId: pipelineAId, q: 'A3', perStage: 50 }),
    );
    const all = byName.stages.flatMap((b) => b.leads);
    assert.equal(all.length, 1);
    assert.equal(all[0]!.name, 'A3');
  });

  it('a different pipelineId returns only that pipeline’s leads', async () => {
    const r = await inTenant(() => leads.listByStage({ pipelineId: pipelineBId, perStage: 50 }));
    assert.equal(r.stages.length, 1);
    const all = r.stages.flatMap((b) => b.leads);
    assert.equal(all.length, 1);
    assert.equal(all[0]!.name, 'OnB');
  });

  it('unknown pipelineId throws typed 404', async () => {
    await assert.rejects(
      () =>
        inTenant(() =>
          leads.listByStage({
            pipelineId: '00000000-0000-0000-0000-000000000000',
            perStage: 50,
          }),
        ),
      (err: { response?: { code?: string } } & Error) => {
        assert.equal(err.response?.code, 'pipeline.not_found_or_empty');
        return true;
      },
    );
  });

  it('RLS isolates: a foreign pipelineId is invisible (treated as 404)', async () => {
    // Pipeline A is in tenantId; calling under otherTenantId must
    // return 404 because the row is filtered out by the RLS policy.
    await assert.rejects(
      () =>
        tenantContext.run(
          { tenantId: otherTenantId, tenantCode: OTHER_TENANT_CODE, source: 'header' },
          () => leads.listByStage({ pipelineId: pipelineAId, perStage: 50 }),
        ),
      (err: { response?: { code?: string } } & Error) => {
        assert.equal(err.response?.code, 'pipeline.not_found_or_empty');
        return true;
      },
    );
  });
});
