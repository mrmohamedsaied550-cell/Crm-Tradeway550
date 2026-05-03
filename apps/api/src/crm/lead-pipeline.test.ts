/**
 * Phase 1B — B3: lead create + moveStage on real stage UUIDs.
 *
 * Throwaway tenant + custom (company × country) pipeline. Verifies:
 *   - create with (companyId, countryId) populates pipelineId from
 *     the matching custom pipeline (NOT the tenant default).
 *   - create with explicit pipelineStageId honours that stage.
 *   - create with stageCode resolves the code against the lead's
 *     pipeline (so 'new' in custom pipeline ≠ 'new' in default).
 *   - moveStage by pipelineStageId accepts a stage in the lead's pipeline.
 *   - moveStage by pipelineStageId rejects a stage from a DIFFERENT
 *     pipeline with `pipeline.stage.cross_pipeline_move`.
 *   - moveStage by stageCode resolves against the lead's pipeline.
 *   - bulkMoveStage by pipelineStageId rejects cross-pipeline stages.
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

const TENANT_CODE = '__b3_lead_pipeline__';

let prisma: PrismaClient;
let prismaSvc: PrismaService;
let leads: LeadsService;
let pipeline: PipelineService;
let tenantId: string;
let actorUserId: string;
let companyId: string;
let countryId: string;
let defaultPipelineId: string;
let customPipelineId: string;
let defaultNewStageId: string;
let defaultContactedStageId: string;
let customNewStageId: string;
let customDoneStageId: string;

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

describe('crm — lead × pipeline integration (B3)', () => {
  before(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    prismaSvc = new PrismaService();
    pipeline = new PipelineService(prismaSvc);
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
      create: { code: TENANT_CODE, name: 'B3 lead pipeline' },
    });
    tenantId = tenant.id;

    await withTenantRaw(tenantId, async (tx) => {
      await tx.tenantSettings.upsert({
        where: { tenantId },
        update: {},
        create: {
          tenantId,
          timezone: 'Africa/Cairo',
          slaMinutes: 60,
          defaultDialCode: '+20',
        },
      });
    });

    await withTenantRaw(tenantId, async (tx) => {
      const role = await tx.role.create({
        data: { tenantId, code: 'sales_agent', nameAr: 'مبيعات', nameEn: 'Sales', level: 30 },
      });
      const actor = await tx.user.create({
        data: {
          tenantId,
          email: 'b3-actor@test',
          name: 'Actor',
          passwordHash: 'x',
          status: 'active',
          roleId: role.id,
        },
      });
      actorUserId = actor.id;

      const company = await tx.company.create({
        data: { tenantId, code: 'b3co', name: 'B3 Company' },
      });
      companyId = company.id;
      const country = await tx.country.create({
        data: { tenantId, companyId, code: 'EG', name: 'B3 Egypt' },
      });
      countryId = country.id;

      // Default pipeline + 2 stages.
      const def = await tx.pipeline.create({
        data: { tenantId, name: 'Default', isDefault: true, isActive: true },
        select: { id: true },
      });
      defaultPipelineId = def.id;
      const defNew = await tx.pipelineStage.create({
        data: { tenantId, pipelineId: def.id, code: 'new', name: 'New', order: 10 },
      });
      defaultNewStageId = defNew.id;
      const defContacted = await tx.pipelineStage.create({
        data: {
          tenantId,
          pipelineId: def.id,
          code: 'contacted',
          name: 'Contacted',
          order: 20,
        },
      });
      defaultContactedStageId = defContacted.id;
      // 'converted' is required for any captain-conversion path; not
      // exercised here but seeded for future use.
      await tx.pipelineStage.create({
        data: {
          tenantId,
          pipelineId: def.id,
          code: 'converted',
          name: 'Converted',
          order: 40,
          isTerminal: true,
        },
      });

      // Custom pipeline scoped to (B3 Company × B3 Egypt).
      const custom = await tx.pipeline.create({
        data: {
          tenantId,
          companyId,
          countryId,
          name: 'B3 Co × Egypt',
          isActive: true,
        },
        select: { id: true },
      });
      customPipelineId = custom.id;
      const cNew = await tx.pipelineStage.create({
        data: { tenantId, pipelineId: custom.id, code: 'new', name: 'C-New', order: 10 },
      });
      customNewStageId = cNew.id;
      const cDone = await tx.pipelineStage.create({
        data: {
          tenantId,
          pipelineId: custom.id,
          code: 'done',
          name: 'C-Done',
          order: 20,
          isTerminal: true,
        },
      });
      customDoneStageId = cDone.id;
    });
  });

  after(async () => {
    await prisma.tenant.delete({ where: { code: TENANT_CODE } }).catch(() => {});
    await prisma.$disconnect();
  });

  it('create with (companyId, countryId) lands on the custom pipeline', async () => {
    const lead = await inTenant(() =>
      leads.create(
        {
          name: 'Custom A',
          phone: '+201001110001',
          source: 'manual',
          companyId,
          countryId,
        },
        actorUserId,
      ),
    );
    assert.equal(lead.pipelineId, customPipelineId);
    assert.equal(lead.companyId, companyId);
    assert.equal(lead.countryId, countryId);
    // Picked the first non-terminal stage of the custom pipeline (C-New).
    assert.equal(lead.stageId, customNewStageId);
    assert.equal(lead.stage.code, 'new');
  });

  it('create without scope falls back to the tenant default pipeline', async () => {
    const lead = await inTenant(() =>
      leads.create({ name: 'Default A', phone: '+201001110002', source: 'manual' }, actorUserId),
    );
    assert.equal(lead.pipelineId, defaultPipelineId);
    assert.equal(lead.companyId, null);
    assert.equal(lead.countryId, null);
    assert.equal(lead.stageId, defaultNewStageId);
  });

  it('create with explicit pipelineStageId honours that stage and infers the pipeline', async () => {
    const lead = await inTenant(() =>
      leads.create(
        {
          name: 'Explicit A',
          phone: '+201001110003',
          source: 'manual',
          pipelineStageId: customDoneStageId,
        },
        actorUserId,
      ),
    );
    assert.equal(lead.stageId, customDoneStageId);
    assert.equal(lead.pipelineId, customPipelineId);
  });

  it('create with stageCode resolves against the LEAD pipeline (custom not default)', async () => {
    // 'new' exists on BOTH pipelines. With (company, country) set,
    // resolver picks custom → custom's 'new' stage wins.
    const lead = await inTenant(() =>
      leads.create(
        {
          name: 'Code-resolved A',
          phone: '+201001110004',
          source: 'manual',
          companyId,
          countryId,
          stageCode: 'new',
        },
        actorUserId,
      ),
    );
    assert.equal(lead.stageId, customNewStageId);
    assert.equal(lead.pipelineId, customPipelineId);
  });

  it('moveStage by pipelineStageId accepts a stage in the lead pipeline', async () => {
    const lead = await inTenant(() =>
      leads.create(
        {
          name: 'Move A',
          phone: '+201001110005',
          source: 'manual',
          companyId,
          countryId,
        },
        actorUserId,
      ),
    );
    const moved = await inTenant(() =>
      leads.moveStage(lead.id, { pipelineStageId: customDoneStageId }, actorUserId),
    );
    assert.equal(moved.stageId, customDoneStageId);
  });

  it('moveStage rejects a stage from a different pipeline with cross_pipeline_move', async () => {
    const lead = await inTenant(() =>
      leads.create(
        {
          name: 'Move B',
          phone: '+201001110006',
          source: 'manual',
          companyId,
          countryId,
        },
        actorUserId,
      ),
    );
    // Custom-pipeline lead, default-pipeline target → reject.
    await assert.rejects(
      () =>
        inTenant(() =>
          leads.moveStage(lead.id, { pipelineStageId: defaultContactedStageId }, actorUserId),
        ),
      (err: { response?: { code?: string } } & Error) => {
        assert.equal(err.response?.code, 'pipeline.stage.cross_pipeline_move');
        return true;
      },
    );
  });

  it('moveStage by stageCode resolves against the lead pipeline', async () => {
    const lead = await inTenant(() =>
      leads.create(
        {
          name: 'Move C',
          phone: '+201001110007',
          source: 'manual',
          companyId,
          countryId,
        },
        actorUserId,
      ),
    );
    // 'done' exists in custom pipeline but not in default. Move to it
    // by code — should succeed because the lookup is scoped to the
    // lead's (custom) pipeline.
    const moved = await inTenant(() =>
      leads.moveStage(lead.id, { stageCode: 'done' }, actorUserId),
    );
    assert.equal(moved.stageId, customDoneStageId);
    assert.equal(moved.slaStatus, 'paused'); // 'done' is terminal
  });

  it('moveStage rejects exactly-zero-or-two target inputs', async () => {
    const lead = await inTenant(() =>
      leads.create({ name: 'Move D', phone: '+201001110008', source: 'manual' }, actorUserId),
    );
    // Neither field
    await assert.rejects(
      () => inTenant(() => leads.moveStage(lead.id, {}, actorUserId)),
      (err: { response?: { code?: string } } & Error) => {
        assert.equal(err.response?.code, 'lead.move_stage.invalid_target');
        return true;
      },
    );
    // Both fields
    await assert.rejects(
      () =>
        inTenant(() =>
          leads.moveStage(
            lead.id,
            { stageCode: 'contacted', pipelineStageId: defaultContactedStageId },
            actorUserId,
          ),
        ),
      (err: { response?: { code?: string } } & Error) => {
        assert.equal(err.response?.code, 'lead.move_stage.invalid_target');
        return true;
      },
    );
  });

  it('list filters by pipelineId return only that pipeline', async () => {
    const result = await inTenant(() =>
      leads.list({ pipelineId: customPipelineId, limit: 50, offset: 0 }),
    );
    for (const l of result.items) {
      assert.equal(l.pipelineId, customPipelineId);
    }
    assert.ok(result.items.length >= 4); // we created several above
  });

  it('list filters by companyId narrows correctly', async () => {
    const result = await inTenant(() => leads.list({ companyId, limit: 50, offset: 0 }));
    for (const l of result.items) {
      assert.equal(l.companyId, companyId);
    }
  });

  it('bulkMoveStage by pipelineStageId rejects leads on a different pipeline', async () => {
    // One lead on custom, one on default.
    const a = await inTenant(() =>
      leads.create(
        {
          name: 'Bulk A',
          phone: '+201001110010',
          source: 'manual',
          companyId,
          countryId,
        },
        actorUserId,
      ),
    );
    const b = await inTenant(() =>
      leads.create({ name: 'Bulk B', phone: '+201001110011', source: 'manual' }, actorUserId),
    );
    // Move BOTH to the custom-pipeline 'done' stage — A succeeds, B fails.
    const result = await inTenant(() =>
      leads.bulkMoveStage(
        { leadIds: [a.id, b.id], pipelineStageId: customDoneStageId },
        actorUserId,
      ),
    );
    assert.deepEqual(result.updated.sort(), [a.id].sort());
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0]!.id, b.id);
    assert.equal(result.failed[0]!.code, 'pipeline.stage.cross_pipeline_move');
  });
});
