/**
 * Phase D2 — D2.3.1: regression + audit-coverage tests for the
 * duplicate-decision-engine wiring fixes.
 *
 * Two bugs were caught in the D2.3 audit and fixed in D2.3.1:
 *   - Bug #1: flag-off legacy "lifelong unique on phone" semantic was
 *             dropped at the DB level when the partial-unique-on-open
 *             migration replaced the original UNIQUE. The service-
 *             level guard restores it under LEAD_ATTEMPTS_V2=false.
 *   - Bug #2: under flag-on, manual create + createFromWhatsApp
 *             threw their early-decision errors (reject / link /
 *             queue_review) BEFORE writing the DuplicateDecisionLog
 *             row. The fix logs the row first, then throws, so
 *             every flag-on evaluation is auditable.
 *
 * These tests need a real Postgres + the D2.1 + D2.3 migrations
 * applied. They run in CI (per `.github/workflows/ci.yml`'s
 * postgres:16-alpine service + `prisma migrate deploy`). Locally,
 * the suite is cancelled with the same DB-unreachable hook-failure
 * pattern as the rest of the integration tests when no Docker is
 * available.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { LeadAttemptsService } from '../crm/lead-attempts.service';
import { LeadsService } from '../crm/leads.service';
import { PipelineService } from '../crm/pipeline.service';
import { AssignmentService } from '../crm/assignment.service';
import { SlaService } from '../crm/sla.service';
import { AgentCapacitiesService } from '../distribution/capacities.service';
import { DistributionService } from '../distribution/distribution.service';
import { LeadRoutingLogService } from '../distribution/routing-log.service';
import { DistributionRulesService } from '../distribution/rules.service';
import { PrismaService } from '../prisma/prisma.service';
import { tenantContext } from '../tenants/tenant-context';
import { TenantSettingsService } from '../tenants/tenant-settings.service';

import { DuplicateDecisionService } from './duplicate-decision.service';
import { DuplicateRulesService } from './duplicate-rules.service';

const TENANT_CODE = '__d231_engine_wiring__';

let prisma: PrismaClient;
let prismaSvc: PrismaService;
let leads: LeadsService;
let tenantId: string;
let actorUserId: string;
let lostReasonId: string;

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

async function clearLeadAttemptsFlag(): Promise<void> {
  delete process.env['LEAD_ATTEMPTS_V2'];
}

describe('D2.3.1 — duplicate engine wiring fixes', () => {
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
    const leadAttempts = new LeadAttemptsService(prismaSvc);
    const dupRules = new DuplicateRulesService();
    const dupDecision = new DuplicateDecisionService(
      prismaSvc,
      dupRules,
      leadAttempts,
      audit,
      tenantSettings,
    );
    leads = new LeadsService(
      prismaSvc,
      pipeline,
      sla,
      tenantSettings,
      distribution,
      undefined,
      undefined,
      undefined,
      undefined,
      audit,
      dupDecision,
    );

    const tenant = await prisma.tenant.upsert({
      where: { code: TENANT_CODE },
      update: { isActive: true },
      create: { code: TENANT_CODE, name: 'D2.3.1 wiring' },
    });
    tenantId = tenant.id;

    await withTenantRaw(tenantId, async (tx) => {
      await tx.tenantSettings.upsert({
        where: { tenantId },
        update: {},
        create: { tenantId, timezone: 'Africa/Cairo', slaMinutes: 60, defaultDialCode: '+20' },
      });

      const role = await tx.role.create({
        data: { tenantId, code: 'sales_agent', nameAr: 'مبيعات', nameEn: 'Sales', level: 30 },
      });
      const actor = await tx.user.create({
        data: {
          tenantId,
          email: 'd231-actor@test',
          name: 'D231 Actor',
          passwordHash: 'x',
          status: 'active',
          roleId: role.id,
        },
      });
      actorUserId = actor.id;

      const pipe = await tx.pipeline.create({
        data: { tenantId, name: 'Default', isDefault: true, isActive: true },
        select: { id: true },
      });
      await tx.pipelineStage.create({
        data: { tenantId, pipelineId: pipe.id, code: 'new', name: 'New', order: 10 },
      });
      await tx.pipelineStage.create({
        data: {
          tenantId,
          pipelineId: pipe.id,
          code: 'lost',
          name: 'Lost',
          order: 50,
          isTerminal: true,
          terminalKind: 'lost',
        },
      });

      const reason = await tx.lostReason.create({
        data: {
          tenantId,
          code: 'no_answer',
          labelEn: 'No answer',
          labelAr: 'لا يوجد ردّ',
          displayOrder: 10,
        },
      });
      lostReasonId = reason.id;
    });
  });

  after(async () => {
    await clearLeadAttemptsFlag();
    await prisma.tenant.delete({ where: { code: TENANT_CODE } }).catch(() => {});
    await prisma.$disconnect();
  });

  // ─── Bug #1: flag-off lifelong-unique semantic ────────────────────

  it('flag-off rejects manual create when only a CLOSED lead exists for the phone', async () => {
    process.env['LEAD_ATTEMPTS_V2'] = 'false';
    try {
      // Create a lead, move it to lost (closed), then attempt a fresh
      // create on the same phone. Pre-D2.3 the lifelong UNIQUE caught
      // this; post-D2.3 the partial-unique-on-open does NOT — D2.3.1's
      // service-level guard must restore the rejection.
      const phone = '+201001000201';
      const first = await inTenant(() =>
        leads.create({ name: 'First', phone, source: 'manual' }, actorUserId),
      );
      // Move to lost so the partial-unique no longer protects.
      await inTenant(() =>
        leads.moveStage(first.id, { stageCode: 'lost', lostReasonId }, actorUserId),
      );
      // A second create should still be rejected at the service layer.
      await assert.rejects(
        () =>
          inTenant(() => leads.create({ name: 'Second', phone, source: 'manual' }, actorUserId)),
        (err: { response?: { code?: string } } & Error) => {
          assert.equal(err.response?.code, 'lead.duplicate_phone');
          return true;
        },
      );
    } finally {
      await clearLeadAttemptsFlag();
    }
  });

  it('flag-off rejects createFromWhatsApp when only a CLOSED lead exists for the phone', async () => {
    process.env['LEAD_ATTEMPTS_V2'] = 'false';
    try {
      const phone = '+201001000202';
      // Seed a closed lead via the manual path then move to lost.
      const first = await inTenant(() =>
        leads.create({ name: 'WA First', phone, source: 'manual' }, actorUserId),
      );
      await inTenant(() =>
        leads.moveStage(first.id, { stageCode: 'lost', lostReasonId }, actorUserId),
      );
      // createFromWhatsApp runs inside an external tx; mimic the
      // inbound orchestrator's call shape.
      await assert.rejects(
        () =>
          withTenantRaw(tenantId, async (tx) => {
            // Need a fake Contact + WhatsAppConversation to satisfy
            // the FK requirements of createFromWhatsApp's Lead row.
            // The exact inbound fixtures are tested elsewhere; here
            // we just want to exercise the early throw.
            const contact = await tx.contact.create({
              data: { tenantId, phone, originalPhone: phone, displayName: 'WA' },
            });
            const account = await tx.whatsAppAccount.create({
              data: {
                tenantId,
                displayName: 'wa-test',
                phoneNumber: '+201000000000',
                phoneNumberId: 'p1',
                provider: 'meta_cloud',
                // gitleaks-ignore: low-entropy test fixture, not a real secret.
                accessToken: 'TESTTOKEN_AAAA',
                verifyToken: 'TESTVERIFYTOKEN',
              },
            });
            const conv = await tx.whatsAppConversation.create({
              data: { tenantId, accountId: account.id, phone, status: 'open' },
            });
            return leads.createFromWhatsApp(tx as never, {
              tenantId,
              contactId: contact.id,
              phone,
              name: 'WA Second',
              companyId: null,
              countryId: null,
              assignedToId: actorUserId,
              primaryConversationId: conv.id,
            });
          }),
        (err: { response?: { code?: string } } & Error) => {
          assert.equal(err.response?.code, 'lead.duplicate_phone');
          return true;
        },
      );
    } finally {
      await clearLeadAttemptsFlag();
    }
  });

  // ─── Bug #2: flag-on early-decision audit log ─────────────────────

  it('flag-on early reject_existing_open writes a DuplicateDecisionLog row before throwing', async () => {
    process.env['LEAD_ATTEMPTS_V2'] = 'true';
    try {
      const phone = '+201001000301';
      // Seed an OPEN lead so a second create triggers reject_existing_open.
      await inTenant(() => leads.create({ name: 'Open', phone, source: 'manual' }, actorUserId));

      // Capture the log baseline before triggering the second create.
      const baselineCount = await withTenantRaw(tenantId, (tx) =>
        tx.duplicateDecisionLog.count({ where: { tenantId, phone } }),
      );

      await assert.rejects(
        () => inTenant(() => leads.create({ name: 'Dup', phone, source: 'manual' }, actorUserId)),
        (err: { response?: { code?: string } } & Error) => {
          assert.equal(err.response?.code, 'lead.duplicate_phone');
          return true;
        },
      );

      const afterCount = await withTenantRaw(tenantId, (tx) =>
        tx.duplicateDecisionLog.count({ where: { tenantId, phone } }),
      );
      assert.equal(afterCount, baselineCount + 1, 'reject decision should write one log row');

      const row = await withTenantRaw(tenantId, (tx) =>
        tx.duplicateDecisionLog.findFirst({
          where: { tenantId, phone },
          orderBy: { createdAt: 'desc' },
        }),
      );
      assert.ok(row, 'log row must exist');
      assert.equal(row!.decision, 'rejected');
      assert.equal(row!.ruleApplied, 'reject_existing_open');
      assert.equal(row!.resultLeadId, null);
    } finally {
      await clearLeadAttemptsFlag();
    }
  });

  it('flag-on queue_review writes a DuplicateDecisionLog row before throwing', async () => {
    process.env['LEAD_ATTEMPTS_V2'] = 'true';
    try {
      const phone = '+201001000302';
      // Seed a Won lead (terminal won) so the engine returns
      // queue_review → throws lead.requires_review at manual create.
      const lead = await inTenant(() =>
        leads.create({ name: 'Won', phone, source: 'manual' }, actorUserId),
      );
      // Move to a 'won' terminal stage. We need one — add inline.
      await withTenantRaw(tenantId, async (tx) => {
        const pipe = await tx.pipeline.findFirst({ where: { tenantId }, select: { id: true } });
        await tx.pipelineStage
          .upsert({
            where: {
              pipelineId_code: { pipelineId: pipe!.id, code: 'converted' },
            },
            update: {},
            create: {
              tenantId,
              pipelineId: pipe!.id,
              code: 'converted',
              name: 'Converted',
              order: 40,
              isTerminal: true,
              terminalKind: 'won',
            },
          })
          .catch(() => {});
      });
      await inTenant(() => leads.moveStage(lead.id, { stageCode: 'converted' }, actorUserId));

      const baselineCount = await withTenantRaw(tenantId, (tx) =>
        tx.duplicateDecisionLog.count({ where: { tenantId, phone } }),
      );

      await assert.rejects(
        () =>
          inTenant(() => leads.create({ name: 'Won-Dup', phone, source: 'manual' }, actorUserId)),
        (err: { response?: { code?: string } } & Error) => {
          assert.equal(err.response?.code, 'lead.requires_review');
          return true;
        },
      );

      const afterCount = await withTenantRaw(tenantId, (tx) =>
        tx.duplicateDecisionLog.count({ where: { tenantId, phone } }),
      );
      assert.equal(afterCount, baselineCount + 1, 'queue_review decision should write one log row');

      const row = await withTenantRaw(tenantId, (tx) =>
        tx.duplicateDecisionLog.findFirst({
          where: { tenantId, phone },
          orderBy: { createdAt: 'desc' },
        }),
      );
      assert.ok(row, 'log row must exist');
      assert.equal(row!.decision, 'queued_review');
      assert.equal(row!.ruleApplied, 'route_to_review_won');
      assert.equal(row!.resultLeadId, null);
    } finally {
      await clearLeadAttemptsFlag();
    }
  });

  // ─── Sanity: flag-off writes NO decision log ──────────────────────

  it('flag-off does NOT write a DuplicateDecisionLog row on duplicate rejection', async () => {
    process.env['LEAD_ATTEMPTS_V2'] = 'false';
    try {
      const phone = '+201001000401';
      await inTenant(() => leads.create({ name: 'A', phone, source: 'manual' }, actorUserId));

      const baselineCount = await withTenantRaw(tenantId, (tx) =>
        tx.duplicateDecisionLog.count({ where: { tenantId, phone } }),
      );

      await assert.rejects(
        () => inTenant(() => leads.create({ name: 'A-dup', phone, source: 'manual' }, actorUserId)),
        (err: { response?: { code?: string } } & Error) => {
          assert.equal(err.response?.code, 'lead.duplicate_phone');
          return true;
        },
      );

      const afterCount = await withTenantRaw(tenantId, (tx) =>
        tx.duplicateDecisionLog.count({ where: { tenantId, phone } }),
      );
      assert.equal(afterCount, baselineCount, 'flag-off must not write any decision log row');
    } finally {
      await clearLeadAttemptsFlag();
    }
  });
});
