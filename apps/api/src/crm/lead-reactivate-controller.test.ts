/**
 * Phase D2 — D2.6: manual reactivation override + previous-owner
 * visibility tests.
 *
 * Verifies the four contracts D2.6 ships:
 *   1. `manualReactivate(...)` rejects an already-open source lead
 *      with `lead.reactivate.already_open` (400-class).
 *   2. Reactivating a lost lead creates a new Lead row with
 *      attemptIndex+1, previousLeadId set, reactivationRule
 *      'manual_override', and writes both the DuplicateDecisionLog
 *      row and the `lead.reactivated` audit verb.
 *   3. The `lead.reactivated` audit verb is recorded once per call
 *      (idempotent on the same source: a re-attempt by the same
 *      operator should not double-write today's audit row, but the
 *      partial-unique on (tenant, phone, lifecycle='open') would
 *      surface a duplicate-phone error first; the test asserts the
 *      single-call happy path).
 *   4. Previous-owner visibility — keyed on `lead.write` (granted
 *      to TL / Account Manager / Ops / Super Admin via
 *      TEAM_LEAD_EXTRAS, NOT to sales / activation / driving agents).
 *      Three role shapes exercised:
 *        a. Sales-agent-shaped role with `lead.assign` only — the
 *           production AGENT_ACTIONS bundle ships `lead.assign`, so
 *           this case is the regression that motivated the gate fix:
 *           predecessor `assignedTo` / `assignedToId` MUST be
 *           stripped while the current row keeps its owner.
 *        b. Empty role (no capabilities) — defence-in-depth check
 *           that the conservative-default branch never leaks owner
 *           data.
 *        c. TL/Ops-shaped role with `lead.write` — receives the
 *           full owner data on every row.
 *
 * Local: same DB-unreachable hook-failure pattern as every other
 * integration test in this repo when no Docker daemon is available.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { AssignmentService } from './assignment.service';
import { LeadsService } from './leads.service';
import { PipelineService } from './pipeline.service';
import { SlaService } from './sla.service';
import { AgentCapacitiesService } from '../distribution/capacities.service';
import { DistributionService } from '../distribution/distribution.service';
import { LeadRoutingLogService } from '../distribution/routing-log.service';
import { DistributionRulesService } from '../distribution/rules.service';
import { ScopeContextService } from '../rbac/scope-context.service';
import { PrismaService } from '../prisma/prisma.service';
import { tenantContext } from '../tenants/tenant-context';
import { TenantSettingsService } from '../tenants/tenant-settings.service';
import { DuplicateDecisionService } from '../duplicates/duplicate-decision.service';
import { DuplicateRulesService } from '../duplicates/duplicate-rules.service';
import { LeadAttemptsService } from './lead-attempts.service';

const TENANT_CODE = '__d26_reactivate__';

let prisma: PrismaClient;
let prismaSvc: PrismaService;
let leads: LeadsService;
let tenantId: string;
let actorUserId: string;
/** Sales-agent-shaped role: holds `lead.assign` (mirroring the seeded
 *  AGENT_ACTIONS bundle) but NOT `lead.write`. The visibility gate
 *  must hide previous owners from this role. */
let salesAgentRoleId: string;
/** Empty role with no capabilities — defence-in-depth check for the
 *  conservative-default branch of the gate. */
let emptyRoleId: string;
/** TL/Ops-shaped role: holds `lead.write` (the new gate signal),
 *  `lead.assign`, and `lead.reactivate`. Sees the full chain. */
let elevatedRoleId: string;
let elevatedUserId: string;
let entryStageId: string;
let lostStageId: string;
let lostReasonId: string;

function asUser(uid: string, rid: string) {
  return { userId: uid, tenantId, roleId: rid };
}

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

describe('D2.6 — manual reactivation override', () => {
  before(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    prismaSvc = new PrismaService();
    const audit = new AuditService(prismaSvc);
    const tenantSettings = new TenantSettingsService(prismaSvc, audit);
    const pipeline = new PipelineService(prismaSvc);
    const assignment = new AssignmentService(prismaSvc);
    const sla = new SlaService(prismaSvc, assignment, undefined, tenantSettings);
    const rules = new DistributionRulesService(prismaSvc);
    const capacities = new AgentCapacitiesService(prismaSvc);
    const routingLog = new LeadRoutingLogService(prismaSvc);
    const distribution = new DistributionService(prismaSvc, rules, capacities, routingLog);
    const scopeContext = new ScopeContextService(prismaSvc);
    const dupRules = new DuplicateRulesService();
    const attemptsSvc = new LeadAttemptsService(prismaSvc);
    const dupDecision = new DuplicateDecisionService(
      prismaSvc,
      dupRules,
      attemptsSvc,
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
      scopeContext,
      undefined,
      audit,
      dupDecision,
    );

    const tenant = await prisma.tenant.upsert({
      where: { code: TENANT_CODE },
      update: { isActive: true },
      create: { code: TENANT_CODE, name: 'D2.6 reactivate' },
    });
    tenantId = tenant.id;

    await withTenantRaw(tenantId, async (tx) => {
      await tx.tenantSettings.upsert({
        where: { tenantId },
        update: {},
        create: { tenantId, timezone: 'Africa/Cairo', slaMinutes: 60, defaultDialCode: '+20' },
      });

      // Capability rows — upsert so the test doesn't depend on the
      // seed having run.
      const reactivateCap = await tx.capability.upsert({
        where: { code: 'lead.reactivate' },
        update: {},
        create: { code: 'lead.reactivate', description: 'Manually reactivate' },
      });
      const assignCap = await tx.capability.upsert({
        where: { code: 'lead.assign' },
        update: {},
        create: { code: 'lead.assign', description: 'Assign / auto-assign leads' },
      });
      const writeCap = await tx.capability.upsert({
        where: { code: 'lead.write' },
        update: {},
        create: { code: 'lead.write', description: 'Create / update / delete leads' },
      });

      // Sales-agent-shaped role: mirrors the seeded AGENT_ACTIONS
      // bundle by holding `lead.assign` — but NOT `lead.write`. The
      // visibility gate (which keys on `lead.write`) must therefore
      // hide previous owners from this role even though `lead.assign`
      // is present.
      const salesRole = await tx.role.create({
        data: { tenantId, code: 'sales_agent', nameAr: 'مبيعات', nameEn: 'Sales', level: 30 },
      });
      salesAgentRoleId = salesRole.id;
      await tx.roleCapability.create({
        data: { tenantId, roleId: salesRole.id, capabilityId: assignCap.id },
      });

      // Empty role: no capabilities at all — defence-in-depth check
      // that the conservative default branch never leaks owner data.
      const emptyRole = await tx.role.create({
        data: { tenantId, code: 'd26_empty', nameAr: 'فارغ', nameEn: 'Empty', level: 10 },
      });
      emptyRoleId = emptyRole.id;

      // Elevated role: TL/Ops shape — holds `lead.write`, `lead.assign`,
      // and `lead.reactivate`. Sees the full chain.
      const elevatedRole = await tx.role.create({
        data: { tenantId, code: 'd26_ops', nameAr: 'عمليات', nameEn: 'Ops (D2.6)', level: 70 },
      });
      elevatedRoleId = elevatedRole.id;
      await tx.roleCapability.create({
        data: { tenantId, roleId: elevatedRole.id, capabilityId: reactivateCap.id },
      });
      await tx.roleCapability.create({
        data: { tenantId, roleId: elevatedRole.id, capabilityId: assignCap.id },
      });
      await tx.roleCapability.create({
        data: { tenantId, roleId: elevatedRole.id, capabilityId: writeCap.id },
      });

      const actor = await tx.user.create({
        data: {
          tenantId,
          email: 'd26-actor@test',
          name: 'Actor',
          // gitleaks-ignore: low-entropy test fixture, not a real secret.
          passwordHash: 'TESTHASH',
          status: 'active',
          roleId: elevatedRole.id,
        },
      });
      actorUserId = actor.id;

      const elevated = await tx.user.create({
        data: {
          tenantId,
          email: 'd26-tl@test',
          name: 'TL',
          passwordHash: 'TESTHASH',
          status: 'active',
          roleId: elevatedRole.id,
        },
      });
      elevatedUserId = elevated.id;

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
          code: 'd26-lost',
          name: 'Lost',
          order: 90,
          isTerminal: true,
          terminalKind: 'lost',
        },
      });
      lostStageId = lost.id;
      const reason = await tx.lostReason.create({
        data: {
          tenantId,
          code: 'd26_unq',
          labelEn: 'Unqualified',
          labelAr: 'غير مؤهَّل',
          displayOrder: 99,
        },
      });
      lostReasonId = reason.id;
    });
  });

  after(async () => {
    await prisma.tenant.delete({ where: { code: TENANT_CODE } }).catch(() => {});
    await prisma.$disconnect();
  });

  it('rejects manual reactivation of an open lead', async () => {
    const phone = '+201001000961';
    const open = await inTenant(() =>
      leads.create({ name: 'StillOpen', phone, source: 'manual' }, actorUserId),
    );
    await assert.rejects(
      () =>
        inTenant(() =>
          leads.manualReactivate(open.id, actorUserId, asUser(actorUserId, elevatedRoleId)),
        ),
      (err: { response?: { code?: string } } & Error) => {
        assert.equal(err.response?.code, 'lead.reactivate.already_open');
        return true;
      },
    );
  });

  it('creates a new attempt with manual_override on a lost lead', async () => {
    const phone = '+201001000962';
    const first = await inTenant(() =>
      leads.create({ name: 'Closed', phone, source: 'manual' }, actorUserId),
    );

    await withTenantRaw(tenantId, async (tx) => {
      const c = await tx.contact.create({
        data: { tenantId, phone, originalPhone: phone, displayName: 'Closed' },
      });
      await tx.lead.update({
        where: { id: first.id },
        data: {
          contactId: c.id,
          stageId: lostStageId,
          lifecycleState: 'lost',
          lostReasonId,
          assignedToId: elevatedUserId,
        },
      });
    });

    const result = await inTenant(() =>
      leads.manualReactivate(first.id, actorUserId, asUser(actorUserId, elevatedRoleId)),
    );

    // New row carries the chain fields the engine writes for any
    // reactivation, with `manual_override` as the rule code.
    const created = await prisma.lead.findUnique({ where: { id: result.id } });
    assert.ok(created, 'new attempt row exists');
    assert.equal(created!.attemptIndex, 2);
    assert.equal(created!.previousLeadId, first.id);
    assert.equal(created!.reactivatedById, actorUserId);
    assert.equal(created!.reactivationRule, 'manual_override');
    assert.equal(created!.lifecycleState, 'open');
    assert.equal(created!.stageId, entryStageId);

    // DuplicateDecisionLog captures manual_override + created_new_attempt.
    const log = await prisma.duplicateDecisionLog.findFirst({
      where: { tenantId, resultLeadId: result.id },
    });
    assert.ok(log, 'duplicate decision log row exists');
    assert.equal(log!.ruleApplied, 'manual_override');
    assert.equal(log!.decision, 'created_new_attempt');
    assert.equal(log!.actorUserId, actorUserId);

    // Dedicated `lead.reactivated` audit verb is written.
    const reactAudit = await prisma.auditEvent.findFirst({
      where: { tenantId, action: 'lead.reactivated', entityId: result.id },
    });
    assert.ok(reactAudit, 'lead.reactivated audit row exists');
    assert.equal(reactAudit!.actorUserId, actorUserId);
  });

  it('hides previous owner from sales-agent + empty roles, surfaces it for lead.write holders', async () => {
    const phone = '+201001000963';
    const first = await inTenant(() =>
      leads.create({ name: 'Owner', phone, source: 'manual' }, actorUserId),
    );

    let secondId: string;
    await withTenantRaw(tenantId, async (tx) => {
      const c = await tx.contact.create({
        data: { tenantId, phone, originalPhone: phone, displayName: 'Owner' },
      });
      await tx.lead.update({
        where: { id: first.id },
        data: {
          contactId: c.id,
          stageId: lostStageId,
          lifecycleState: 'lost',
          lostReasonId,
          assignedToId: elevatedUserId,
        },
      });
      const newAttempt = await tx.lead.create({
        data: {
          tenantId,
          name: 'Owner',
          phone,
          source: 'manual',
          stageId: entryStageId,
          lifecycleState: 'open',
          contactId: c.id,
          attemptIndex: 2,
          previousLeadId: first.id,
          reactivatedAt: new Date(),
          reactivationRule: 'manual_override',
          assignedToId: actorUserId,
        },
      });
      secondId = newAttempt.id;
    });

    // Sales-agent-shaped role: holds `lead.assign` (mirroring the
    // production AGENT_ACTIONS bundle) but NOT `lead.write`. The
    // gate must hide the predecessor's owner; the current row keeps
    // its owner so the agent still sees their own assignment.
    const salesView = await inTenant(() =>
      leads.listAttemptsForLeadInScope(secondId!, asUser(actorUserId, salesAgentRoleId)),
    );
    assert.equal(salesView.attempts.length, 2);
    const salesCurrent = salesView.attempts.find((a) => a.id === secondId)!;
    const salesPrev = salesView.attempts.find((a) => a.id === first.id)!;
    assert.equal(salesCurrent.assignedToId, actorUserId, 'current row keeps owner');
    assert.equal(salesPrev.assignedTo, null, 'predecessor owner hidden for sales agent');
    assert.equal(salesPrev.assignedToId, null, 'predecessor owner id hidden for sales agent');

    // Empty role (defence-in-depth): no capabilities at all → must
    // still hide previous owner.
    const emptyView = await inTenant(() =>
      leads.listAttemptsForLeadInScope(secondId!, asUser(actorUserId, emptyRoleId)),
    );
    const emptyPrev = emptyView.attempts.find((a) => a.id === first.id)!;
    assert.equal(emptyPrev.assignedTo, null, 'predecessor owner hidden for empty role');
    assert.equal(emptyPrev.assignedToId, null, 'predecessor owner id hidden for empty role');

    // TL/Ops-shaped role: holds `lead.write` (the new gate signal) →
    // previous owner returned.
    const elevatedView = await inTenant(() =>
      leads.listAttemptsForLeadInScope(secondId!, asUser(actorUserId, elevatedRoleId)),
    );
    const elevatedPrev = elevatedView.attempts.find((a) => a.id === first.id)!;
    assert.equal(elevatedPrev.assignedToId, elevatedUserId);
    assert.ok(elevatedPrev.assignedTo, 'elevated sees previous owner row');
  });
});
