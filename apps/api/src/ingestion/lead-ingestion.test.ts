/**
 * P2-06 — LeadIngestionService integration tests.
 *
 * Real Postgres + a throwaway tenant. Covers:
 *   1. CSV import: creates leads, normalises phones, applies the
 *      column mapping, marks duplicates idempotent, surfaces row
 *      errors without aborting the batch, writes an audit row.
 *   2. CSV import auto-assign: when on, every created lead lands on
 *      an eligible sales agent.
 *   3. Meta payload ingestion: a single mapped lead end-to-end.
 *   4. Meta payload duplicate skip.
 *
 * The webhook controller (signature, payload routing) is tested
 * indirectly via the service surface — the controller is a thin
 * adapter with deterministic helpers.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { AssignmentService } from '../crm/assignment.service';
import { LeadsService } from '../crm/leads.service';
import { PipelineService } from '../crm/pipeline.service';
import { SlaService } from '../crm/sla.service';
import { AgentCapacitiesService } from '../distribution/capacities.service';
import { DistributionService } from '../distribution/distribution.service';
import { LeadRoutingLogService } from '../distribution/routing-log.service';
import { DistributionRulesService } from '../distribution/rules.service';
import { hashPassword } from '../identity/password.util';
import { PrismaService } from '../prisma/prisma.service';
import { tenantContext } from '../tenants/tenant-context';
import { TenantSettingsService } from '../tenants/tenant-settings.service';
import { LeadIngestionService } from './lead-ingestion.service';

const TENANT_CODE = '__p2_06_ingestion__';

let prisma: PrismaClient;
let prismaSvc: PrismaService;
let ingestion: LeadIngestionService;
let tenantId: string;
let actorUserId: string;
let agentUserId: string;

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

describe('ingestion — lead-ingestion (P2-06)', () => {
  before(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    prismaSvc = new PrismaService();
    const pipeline = new PipelineService(prismaSvc);
    const assignment = new AssignmentService(prismaSvc);
    const audit = new AuditService(prismaSvc);
    const tenantSettings = new TenantSettingsService(prismaSvc, audit);
    const sla = new SlaService(prismaSvc, assignment, undefined, tenantSettings);
    // A5.5 — ingestion now routes through LeadsService.autoAssign,
    // which delegates to DistributionService. We wire the same dep
    // graph leads.test.ts uses so the integration-test path is
    // identical to production.
    const rulesSvc = new DistributionRulesService(prismaSvc);
    const capacitiesSvc = new AgentCapacitiesService(prismaSvc);
    const routingLogSvc = new LeadRoutingLogService(prismaSvc);
    const distribution = new DistributionService(
      prismaSvc,
      rulesSvc,
      capacitiesSvc,
      routingLogSvc,
      tenantSettings,
    );
    const leads = new LeadsService(prismaSvc, pipeline, sla, tenantSettings, distribution);
    ingestion = new LeadIngestionService(prismaSvc, pipeline, leads, sla, audit, tenantSettings);

    const tenant = await prisma.tenant.upsert({
      where: { code: TENANT_CODE },
      update: { isActive: true },
      create: { code: TENANT_CODE, name: 'P2-06 ingestion' },
    });
    tenantId = tenant.id;

    await withTenantRaw(tenantId, async (tx) => {
      // Pipeline stages live under a Pipeline (P2-07).
      const pipeline = await tx.pipeline.create({
        data: { tenantId, name: 'Default', isDefault: true, isActive: true },
      });
      await tx.pipelineStage.create({
        data: {
          tenantId,
          pipelineId: pipeline.id,
          code: 'new',
          name: 'New',
          order: 10,
          isTerminal: false,
        },
      });
      await tx.pipelineStage.create({
        data: {
          tenantId,
          pipelineId: pipeline.id,
          code: 'converted',
          name: 'Converted',
          order: 40,
          isTerminal: true,
        },
      });

      const adminRole = await tx.role.create({
        data: {
          tenantId,
          code: 'ops_manager',
          nameAr: 'إدارة',
          nameEn: 'Ops',
          level: 90,
        },
      });
      const agentRole = await tx.role.create({
        data: {
          tenantId,
          code: 'sales_agent',
          nameAr: 'وكيل',
          nameEn: 'Sales Agent',
          level: 30,
        },
      });

      const hash = await hashPassword('Password@123', 4);
      const actor = await tx.user.create({
        data: {
          tenantId,
          email: 'p206-actor@test',
          name: 'Actor',
          passwordHash: hash,
          roleId: adminRole.id,
        },
      });
      const agent = await tx.user.create({
        data: {
          tenantId,
          email: 'p206-agent@test',
          name: 'Agent',
          passwordHash: hash,
          roleId: agentRole.id,
        },
      });
      actorUserId = actor.id;
      agentUserId = agent.id;
    });
  });

  after(async () => {
    await prisma.tenant.delete({ where: { code: TENANT_CODE } }).catch(() => {});
    await prisma.$disconnect();
  });

  it('imports a CSV with mapping, dedupes, and reports per-row errors', async () => {
    const csv =
      'full_name,mobile,email\n' +
      'Alice,+201001100601,alice@example.com\n' +
      // duplicate phone (same after normalisation as line 1) → counted dup
      'Alice 2,201001100601,alice2@example.com\n' +
      // missing name → counted error
      ',+201001100602,bob@example.com\n' +
      // valid second lead
      'Carol,+201001100603,\n' +
      // bad phone → counted error
      'Dan,not-a-phone,\n';

    const result = await inTenant(() =>
      ingestion.importCsv(
        {
          csv,
          mapping: { name: 'full_name', phone: 'mobile', email: 'email' },
          defaultSource: 'import',
          autoAssign: false,
        },
        actorUserId,
      ),
    );

    assert.equal(result.total, 5);
    assert.equal(result.created, 2, 'two valid rows created');
    assert.equal(result.duplicates, 1, 'one duplicate phone skipped');
    assert.equal(result.errors.length, 2, 'two rows error');
    // Lines: header is line 1, so data rows start at 2.
    assert.deepEqual(result.errors.map((e) => e.row).sort(), [4, 6]);

    // Verify rows exist + activity row + audit row.
    const leadCount = await withTenantRaw(tenantId, (tx) =>
      tx.lead.count({ where: { source: 'import' } }),
    );
    assert.equal(leadCount, 2);

    const audits = await withTenantRaw(tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'lead.import.csv' } }),
    );
    assert.equal(audits.length, 1);
    const payload = audits[0]?.payload as Record<string, unknown> | null;
    assert.equal((payload as { total?: number }).total, 5);
    assert.equal((payload as { created?: number }).created, 2);
  });

  it('auto-assigns imported leads when autoAssign=true', async () => {
    const csv = 'name,phone\nEmma,+201001100604\nFiona,+201001100605\n';

    const result = await inTenant(() =>
      ingestion.importCsv(
        {
          csv,
          mapping: { name: 'name', phone: 'phone' },
          defaultSource: 'import',
          autoAssign: true,
        },
        actorUserId,
      ),
    );

    assert.equal(result.created, 2);

    // Both rows should be assigned to the only eligible agent.
    const leads = await withTenantRaw(tenantId, (tx) =>
      tx.lead.findMany({
        where: { phone: { in: ['+201001100604', '+201001100605'] } },
        select: { phone: true, assignedToId: true },
      }),
    );
    assert.equal(leads.length, 2);
    for (const lead of leads) {
      assert.equal(lead.assignedToId, agentUserId, `lead ${lead.phone} should be auto-assigned`);
    }
  });

  it('rejects an invalid mapping (CSV missing referenced column)', async () => {
    await assert.rejects(
      () =>
        inTenant(() =>
          ingestion.importCsv(
            {
              csv: 'name,phone\nA,+201001100610\n',
              mapping: { name: 'name', phone: 'phone', email: 'NOT_THERE' },
              defaultSource: 'import',
              autoAssign: false,
            },
            actorUserId,
          ),
        ),
      /missing column/,
    );
  });

  it('ingests a Meta-payload lead and dedupes a re-delivery', async () => {
    const first = await ingestion.ingestMetaPayload({
      tenantId,
      name: 'Hassan',
      phoneRaw: '+201001100620',
      email: 'h@example.com',
      source: 'meta',
      actorUserId: null,
      metadata: { leadgenId: 'LG_1' },
    });
    assert.equal(first.kind, 'created');

    const second = await ingestion.ingestMetaPayload({
      tenantId,
      name: 'Hassan',
      phoneRaw: '+201001100620',
      email: 'h@example.com',
      source: 'meta',
      actorUserId: null,
      metadata: { leadgenId: 'LG_1' },
    });
    assert.equal(second.kind, 'duplicate');

    // Lead should be auto-assigned to the only eligible agent.
    const lead = await withTenantRaw(tenantId, (tx) =>
      tx.lead.findFirst({
        where: { phone: '+201001100620' },
        select: { assignedToId: true, source: true },
      }),
    );
    assert.equal(lead?.source, 'meta');
    assert.equal(lead?.assignedToId, agentUserId);

    // Audit rows: one create + one duplicate.
    const audits = await withTenantRaw(tenantId, (tx) =>
      tx.auditEvent.findMany({
        where: { action: { in: ['lead.ingest.meta', 'lead.ingest.meta.duplicate'] } },
      }),
    );
    assert.equal(audits.length, 2);
  });

  it('returns an error result on a Meta payload missing required fields', async () => {
    const result = await ingestion.ingestMetaPayload({
      tenantId,
      name: '',
      phoneRaw: '+201001100621',
      source: 'meta',
      actorUserId: null,
    });
    assert.equal(result.kind, 'error');
  });

  // ─── A5.5 — distribution rules apply to ingested leads ───
  // Pre-A5.5 the ingestion path called AssignmentService directly,
  // bypassing rule consultation. After A5.5 ingestion routes through
  // LeadsService.autoAssign → DistributionService.route, so source /
  // company / country / team rules apply identically to manual
  // /auto-assign. The next two tests prove that.

  it('A5.5 — Meta-ingested lead honours a source-based distribution rule', async () => {
    // Plant a specific_user rule for source=meta → agentUserId.
    // Since agentUserId is the ONLY active sales agent in the test
    // tenant, we wouldn't be able to distinguish "rule fired" from
    // "default strategy fired" if we left it there. Add a SECOND
    // sales agent so the routing decision becomes meaningful.
    const hash = await hashPassword('Password@123', 4);
    const role = await withTenantRaw(tenantId, (tx) =>
      tx.role.findFirstOrThrow({ where: { code: 'sales_agent' } }),
    );
    const otherAgent = await withTenantRaw(tenantId, (tx) =>
      tx.user.create({
        data: {
          tenantId,
          email: '__a55_other@x',
          name: 'Other',
          passwordHash: hash,
          roleId: role.id,
        },
      }),
    );
    await withTenantRaw(tenantId, (tx) =>
      tx.distributionRule.create({
        data: {
          tenantId,
          name: 'Test (A5.5): meta → otherAgent',
          strategy: 'specific_user',
          source: 'meta',
          targetUserId: otherAgent.id,
          updatedAt: new Date(),
        },
      }),
    );

    const ingested = await ingestion.ingestMetaPayload({
      tenantId,
      name: 'Routed-By-Rule',
      phoneRaw: '+201001100700',
      source: 'meta',
      actorUserId: null,
    });
    assert.equal(ingested.kind, 'created');

    // Lead must be assigned to otherAgent (the rule's target),
    // NOT to agentUserId (the default-strategy winner).
    const lead = await withTenantRaw(tenantId, (tx) =>
      tx.lead.findFirstOrThrow({
        where: { phone: '+201001100700' },
        select: { id: true, assignedToId: true },
      }),
    );
    assert.equal(
      lead.assignedToId,
      otherAgent.id,
      'rule should route Meta-ingested lead to its target',
    );

    // Routing log row written with strategy='specific_user' + ruleId.
    const logs = await withTenantRaw(tenantId, (tx) =>
      tx.leadRoutingLog.findMany({ where: { leadId: lead.id } }),
    );
    assert.equal(logs.length, 1);
    assert.equal(logs[0]!.strategy, 'specific_user');
    assert.equal(logs[0]!.chosenUserId, otherAgent.id);
    assert.ok(logs[0]!.ruleId, 'log records the matched rule');

    // Cleanup so subsequent tests aren't perturbed.
    await withTenantRaw(tenantId, (tx) =>
      tx.distributionRule.deleteMany({
        where: { name: 'Test (A5.5): meta → otherAgent' },
      }),
    );
    await withTenantRaw(tenantId, (tx) =>
      tx.user.delete({ where: { id: otherAgent.id } }).catch(() => null),
    );
  });

  it('A5.5 — CSV-ingested lead writes a routing log row even when default strategy fires', async () => {
    // No matching rule → tenant default strategy ('capacity') fires.
    // The contract under test is that the log row IS written for
    // every ingested lead — pre-A5.5 there was no log at all.
    const csv = 'name,phone\nLogged,+201001100800\n';
    await inTenant(() =>
      ingestion.importCsv(
        {
          csv,
          mapping: { name: 'name', phone: 'phone' },
          defaultSource: 'import',
          autoAssign: true,
        },
        actorUserId,
      ),
    );

    const lead = await withTenantRaw(tenantId, (tx) =>
      tx.lead.findFirstOrThrow({
        where: { phone: '+201001100800' },
        select: { id: true, assignedToId: true },
      }),
    );
    assert.ok(lead.assignedToId, 'CSV-imported lead must be auto-assigned');

    const logs = await withTenantRaw(tenantId, (tx) =>
      tx.leadRoutingLog.findMany({ where: { leadId: lead.id } }),
    );
    assert.equal(logs.length, 1, 'exactly one routing log row per ingested auto-assign');
    assert.equal(logs[0]!.ruleId, null, 'no rule matched');
    assert.equal(logs[0]!.strategy, 'capacity', 'fallback strategy fires');
    assert.equal(logs[0]!.chosenUserId, lead.assignedToId);
  });

  it('A5.5 — Meta-ingested lead leaves itself unassigned when no eligible agent exists', async () => {
    // Disable every sales agent in the tenant. Ingestion must NOT
    // throw; the lead lands but stays unassigned. The routing log
    // records chosenUserId=null.
    await withTenantRaw(tenantId, (tx) =>
      tx.user.updateMany({
        where: { tenantId, role: { code: 'sales_agent' } },
        data: { status: 'disabled' },
      }),
    );
    try {
      const result = await ingestion.ingestMetaPayload({
        tenantId,
        name: 'Stranded',
        phoneRaw: '+201001100900',
        source: 'meta',
        actorUserId: null,
      });
      assert.equal(result.kind, 'created');

      const lead = await withTenantRaw(tenantId, (tx) =>
        tx.lead.findFirstOrThrow({
          where: { phone: '+201001100900' },
          select: { id: true, assignedToId: true },
        }),
      );
      assert.equal(lead.assignedToId, null, 'no eligible agent → lead unassigned');

      const logs = await withTenantRaw(tenantId, (tx) =>
        tx.leadRoutingLog.findMany({ where: { leadId: lead.id } }),
      );
      assert.equal(logs.length, 1);
      assert.equal(logs[0]!.chosenUserId, null);
      assert.equal(logs[0]!.candidateCount, 0, 'no surviving candidates');
    } finally {
      // Restore so subsequent tests have agents.
      await withTenantRaw(tenantId, (tx) =>
        tx.user.updateMany({
          where: { tenantId, role: { code: 'sales_agent' } },
          data: { status: 'active' },
        }),
      );
    }
  });
});
