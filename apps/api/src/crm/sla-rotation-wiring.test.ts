/**
 * Phase D3 — D3.5: SLA-driven rotation + escalation policy — integration tests.
 *
 * Real Postgres + a throwaway tenant. Verifies:
 *
 *   1. EscalationPolicyService returns the locked product defaults
 *      when the tenant has no `escalation_rules` row override:
 *        - t75 / t100 / t150 / t200 actions match the spec.
 *        - t150 has `rotate_or_review` with 24-hour repeat window.
 *        - defaultHandoverMode = 'full'.
 *
 *   2. Tenant-overridden `escalation_rules` JSON parses through and
 *      surfaces in `getPolicy()`.
 *
 *   3. SLA breach scanner under `D3_ENGINE_V1=false`:
 *        - Legacy inline reassignment path runs.
 *        - NO `LeadRotationLog` row is written.
 *
 *   4. SLA breach scanner under `D3_ENGINE_V1=true`:
 *        - The breach is recorded (sla_breach activity + slaStatus
 *          flipped to 'breached').
 *        - The rotation runs through `RotationService.rotateLead`,
 *          writing exactly one `LeadRotationLog` row + one
 *          `LeadActivity { type: 'rotation' }` + one
 *          `audit_events.lead.rotated` row.
 *        - Lead.assignedToId flips, lead.lastRotatedAt is stamped,
 *          slaStatus resets to 'active' on the new owner.
 *
 *   5. t150 repeat detection:
 *        - When a `LeadRotationLog` for `trigger='sla_breach'`
 *          exists within the policy's `reviewOnRepeatWithinHours`
 *          window, the second SLA breach does NOT rotate.
 *          Instead, an `audit_events.lead.sla.review_pending`
 *          row is written carrying the prior rotation id +
 *          `priorAssigneeId`. Outcome = 'review_pending'.
 *
 *   6. Sales-agent visibility on rotation history remains redacted
 *      (canSeeOwners=false; from/to/actor stripped) — same D2.6
 *      anti-regression pattern as D3.4.
 *
 * Local: same DB-unreachable hook-failure pattern as every other
 * integration test.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';

import { Prisma } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { AssignmentService } from './assignment.service';
import { AgentCapacitiesService } from '../distribution/capacities.service';
import { DistributionService } from '../distribution/distribution.service';
import { LeadRoutingLogService } from '../distribution/routing-log.service';
import { DistributionRulesService } from '../distribution/rules.service';
import { PrismaService } from '../prisma/prisma.service';
import { ScopeContextService } from '../rbac/scope-context.service';
import { tenantContext } from '../tenants/tenant-context';
import { TenantSettingsService } from '../tenants/tenant-settings.service';
import { EscalationPolicyService } from './escalation-policy.service';
import { RotationService } from './rotation.service';
import { SlaService } from './sla.service';

const TENANT_CODE = '__d35_sla_rotation__';

let prisma: PrismaClient;
let prismaSvc: PrismaService;
let sla: SlaService;
let rotation: RotationService;
let escalationPolicy: EscalationPolicyService;
let tenantId: string;
let priorOwnerId: string;
let nextOwnerId: string;
let entryStageId: string;

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

/** Create a freshly-breached lead assigned to the prior owner. */
async function makeBreachedLead(now: Date, phoneSuffix: string): Promise<string> {
  return withTenantRaw(tenantId, async (tx) => {
    const lead = await tx.lead.create({
      data: {
        tenantId,
        name: 'L',
        phone: `+201001000${phoneSuffix}`,
        source: 'manual',
        stageId: entryStageId,
        lifecycleState: 'open',
        slaStatus: 'active',
        // 5 minutes overdue.
        slaDueAt: new Date(now.getTime() - 5 * 60 * 1000),
        attemptIndex: 1,
        assignedToId: priorOwnerId,
      },
      select: { id: true },
    });
    return lead.id;
  });
}

describe('D3.5 — SLA-driven rotation + escalation policy', () => {
  before(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    prismaSvc = new PrismaService();
    const audit = new AuditService(prismaSvc);
    const tenantSettings = new TenantSettingsService(prismaSvc, audit);
    const assignment = new AssignmentService(prismaSvc);
    const rules = new DistributionRulesService(prismaSvc);
    const capacities = new AgentCapacitiesService(prismaSvc);
    const routingLog = new LeadRoutingLogService(prismaSvc);
    const distribution = new DistributionService(prismaSvc, rules, capacities, routingLog);
    const scopeContext = new ScopeContextService(prismaSvc);
    rotation = new RotationService(prismaSvc, distribution, scopeContext, audit);
    escalationPolicy = new EscalationPolicyService(prismaSvc);
    sla = new SlaService(
      prismaSvc,
      assignment,
      undefined, // notifications
      tenantSettings,
      undefined, // realtime
      distribution,
      undefined, // thresholds
      rotation,
      escalationPolicy,
      audit,
    );

    const tenant = await prisma.tenant.upsert({
      where: { code: TENANT_CODE },
      update: { isActive: true },
      create: { code: TENANT_CODE, name: 'D3.5 sla-rotation' },
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

      const role = await tx.role.create({
        data: { tenantId, code: 'sales_agent', nameAr: 'مبيعات', nameEn: 'Sales', level: 30 },
      });
      // Two active users so DistributionService has someone to pick.
      const prior = await tx.user.create({
        data: {
          tenantId,
          email: 'd35-prior@test',
          name: 'Prior',
          // gitleaks-ignore: low-entropy test fixture, not a real secret.
          passwordHash: 'TESTHASH',
          status: 'active',
          roleId: role.id,
        },
      });
      priorOwnerId = prior.id;
      const next = await tx.user.create({
        data: {
          tenantId,
          email: 'd35-next@test',
          name: 'Next',
          passwordHash: 'TESTHASH',
          status: 'active',
          roleId: role.id,
        },
      });
      nextOwnerId = next.id;

      const pipe = await tx.pipeline.create({
        data: { tenantId, name: 'D35', isDefault: true, isActive: true },
        select: { id: true },
      });
      const entry = await tx.pipelineStage.create({
        data: { tenantId, pipelineId: pipe.id, code: 'new', name: 'New', order: 10 },
      });
      entryStageId = entry.id;
    });
  });

  after(async () => {
    await prisma.tenant.delete({ where: { code: TENANT_CODE } }).catch(() => {});
    await prisma.$disconnect();
  });

  it('escalation policy: NULL tenant rules → product defaults', async () => {
    const policy = await inTenant(() => escalationPolicy.getPolicy());
    assert.equal(policy.thresholds.t75.action, 'notify_only');
    assert.equal(policy.thresholds.t100.action, 'notify_and_tag');
    assert.equal(policy.thresholds.t150.action, 'rotate_or_review');
    assert.equal(policy.thresholds.t150.reviewOnRepeatWithinHours, 24);
    assert.equal(policy.thresholds.t200.action, 'raise_review');
    assert.equal(policy.defaultHandoverMode, 'full');
  });

  it('escalation policy: tenant override surfaces through getPolicy()', async () => {
    await withTenantRaw(tenantId, (tx) =>
      tx.tenantSettings.update({
        where: { tenantId },
        data: {
          escalationRules: {
            thresholds: {
              t75: { action: 'notify_only', rotateOnFirst: true, reviewOnRepeatWithinHours: 24 },
              t100: { action: 'notify_only', rotateOnFirst: true, reviewOnRepeatWithinHours: 24 },
              t150: {
                action: 'rotate_or_review',
                rotateOnFirst: true,
                reviewOnRepeatWithinHours: 6,
              },
              t200: { action: 'raise_review', rotateOnFirst: true, reviewOnRepeatWithinHours: 24 },
            },
            defaultHandoverMode: 'summary',
          },
        },
      }),
    );
    const policy = await inTenant(() => escalationPolicy.getPolicy());
    assert.equal(policy.thresholds.t150.reviewOnRepeatWithinHours, 6);
    assert.equal(policy.defaultHandoverMode, 'summary');

    // Reset the override to NULL for the rest of the suite. Prisma
    // requires the explicit `Prisma.JsonNull` sentinel for nullable
    // JSON columns — `null` alone resolves to "no change".
    await withTenantRaw(tenantId, (tx) =>
      tx.tenantSettings.update({
        where: { tenantId },
        data: { escalationRules: Prisma.JsonNull },
      }),
    );
  });

  it('flag-off: SLA breach uses legacy path; no LeadRotationLog written', async () => {
    const now = new Date();
    const leadId = await makeBreachedLead(now, '110');

    const prev = process.env['D3_ENGINE_V1'];
    process.env['D3_ENGINE_V1'] = 'false';
    try {
      const results = await inTenant(() => sla.runReassignmentForBreaches(null, now));
      const myResult = results.find((r) => r.leadId === leadId);
      assert.ok(myResult, 'breach was processed');

      const logs = await withTenantRaw(tenantId, (tx) =>
        tx.leadRotationLog.findMany({ where: { tenantId, leadId } }),
      );
      assert.equal(logs.length, 0, 'no rotation log under flag-off');
    } finally {
      if (prev === undefined) delete process.env['D3_ENGINE_V1'];
      else process.env['D3_ENGINE_V1'] = prev;
    }
  });

  it('flag-on: SLA breach writes rotation log + activity + audit and flips assignedToId', async () => {
    const now = new Date();
    const leadId = await makeBreachedLead(now, '111');

    const prev = process.env['D3_ENGINE_V1'];
    process.env['D3_ENGINE_V1'] = 'true';
    try {
      const results = await inTenant(() => sla.runReassignmentForBreaches(null, now));
      const myResult = results.find((r) => r.leadId === leadId);
      assert.ok(myResult, 'breach was processed');
      assert.equal(myResult!.outcome, 'reassigned');
      assert.notEqual(myResult!.toUserId, priorOwnerId);

      const log = await withTenantRaw(tenantId, (tx) =>
        tx.leadRotationLog.findFirst({
          where: { tenantId, leadId, trigger: 'sla_breach' },
        }),
      );
      assert.ok(log, 'rotation log written');
      assert.equal(log!.handoverMode, 'full');
      assert.equal(log!.fromUserId, priorOwnerId);

      const rotationActivity = await withTenantRaw(tenantId, (tx) =>
        tx.leadActivity.findFirst({
          where: { leadId, type: 'rotation' },
        }),
      );
      assert.ok(rotationActivity, 'rotation activity written');

      const slaActivity = await withTenantRaw(tenantId, (tx) =>
        tx.leadActivity.findFirst({
          where: { leadId, type: 'sla_breach' },
        }),
      );
      assert.ok(slaActivity, 'sla_breach activity preserved for backwards compat');

      const auditRow = await withTenantRaw(tenantId, (tx) =>
        tx.auditEvent.findFirst({
          where: { tenantId, action: 'lead.rotated', entityId: leadId },
        }),
      );
      assert.ok(auditRow, 'lead.rotated audit row written');

      const lead = await withTenantRaw(tenantId, (tx) =>
        tx.lead.findUnique({
          where: { id: leadId },
          select: { assignedToId: true, slaStatus: true, lastRotatedAt: true },
        }),
      );
      assert.notEqual(lead!.assignedToId, priorOwnerId);
      assert.equal(lead!.slaStatus, 'active', 'SLA reset on the new owner');
      assert.ok(lead!.lastRotatedAt, 'lastRotatedAt stamped');
    } finally {
      if (prev === undefined) delete process.env['D3_ENGINE_V1'];
      else process.env['D3_ENGINE_V1'] = prev;
    }
  });

  it('flag-on: t150 repeat within 24h surfaces review_pending audit + skips rotation', async () => {
    const now = new Date();
    const leadId = await makeBreachedLead(now, '112');

    // Plant a prior `sla_breach` rotation 1h ago (within the 24h window).
    await withTenantRaw(tenantId, (tx) =>
      tx.leadRotationLog.create({
        data: {
          tenantId,
          leadId,
          fromUserId: priorOwnerId,
          toUserId: nextOwnerId,
          trigger: 'sla_breach',
          handoverMode: 'full',
          attemptIndex: 1,
          createdAt: new Date(now.getTime() - 60 * 60 * 1000),
        },
      }),
    );

    const prev = process.env['D3_ENGINE_V1'];
    process.env['D3_ENGINE_V1'] = 'true';
    try {
      const results = await inTenant(() => sla.runReassignmentForBreaches(null, now));
      const myResult = results.find((r) => r.leadId === leadId);
      assert.ok(myResult, 'breach was processed');
      assert.equal(myResult!.outcome, 'review_pending');
      assert.equal(myResult!.toUserId, null, 'no new owner picked on repeat');

      // No NEW rotation log row from this run.
      const logCount = await withTenantRaw(tenantId, (tx) =>
        tx.leadRotationLog.count({ where: { tenantId, leadId, trigger: 'sla_breach' } }),
      );
      assert.equal(logCount, 1, 'still only the planted rotation log');

      // review_pending audit row written.
      const reviewAudit = await withTenantRaw(tenantId, (tx) =>
        tx.auditEvent.findFirst({
          where: { tenantId, action: 'lead.sla.review_pending', entityId: leadId },
        }),
      );
      assert.ok(reviewAudit, 'review_pending audit row written');
      const payload = reviewAudit!.payload as Record<string, unknown>;
      assert.equal(payload['reason'], 'sla_t150_repeat');
      assert.equal(payload['windowHours'], 24);

      // Lead stays breached + still owned by priorOwner.
      const lead = await withTenantRaw(tenantId, (tx) =>
        tx.lead.findUnique({
          where: { id: leadId },
          select: { assignedToId: true, slaStatus: true },
        }),
      );
      assert.equal(lead!.assignedToId, priorOwnerId);
      assert.equal(lead!.slaStatus, 'breached');
    } finally {
      if (prev === undefined) delete process.env['D3_ENGINE_V1'];
      else process.env['D3_ENGINE_V1'] = prev;
    }
  });

  it('rotation history visibility (D2.6 gate) survives D3.5 wiring', async () => {
    // Use the lead from the flag-on test which now has a rotation
    // log row written by RotationService. Build a sales-agent-shaped
    // role (lead.assign only) and verify the gate.
    const writeCap = await prisma.capability.upsert({
      where: { code: 'lead.write' },
      update: {},
      create: { code: 'lead.write', description: 'Create / update / delete leads' },
    });
    const assignCap = await prisma.capability.upsert({
      where: { code: 'lead.assign' },
      update: {},
      create: { code: 'lead.assign', description: 'Assign / auto-assign leads' },
    });
    let salesRoleId: string;
    let elevatedRoleId: string;
    await withTenantRaw(tenantId, async (tx) => {
      const sales = await tx.role.create({
        data: {
          tenantId,
          code: 'sales_agent_d35',
          nameAr: 'مبيعات',
          nameEn: 'Sales (D35)',
          level: 30,
        },
      });
      salesRoleId = sales.id;
      await tx.roleCapability.create({
        data: { tenantId, roleId: sales.id, capabilityId: assignCap.id },
      });
      const elevated = await tx.role.create({
        data: { tenantId, code: 'tl_d35', nameAr: 'قائد', nameEn: 'TL (D35)', level: 60 },
      });
      elevatedRoleId = elevated.id;
      await tx.roleCapability.create({
        data: { tenantId, roleId: elevated.id, capabilityId: writeCap.id },
      });
    });

    const leadWithRotation = await withTenantRaw(tenantId, (tx) =>
      tx.leadRotationLog.findFirst({
        where: { tenantId, trigger: 'sla_breach' },
        select: { leadId: true },
      }),
    );
    assert.ok(leadWithRotation, 'a rotation row exists from the earlier flag-on test');

    const salesView = await inTenant(() =>
      rotation.listRotationsForLead(leadWithRotation!.leadId, {
        userId: priorOwnerId,
        tenantId,
        roleId: salesRoleId!,
      }),
    );
    assert.equal(salesView.canSeeOwners, false);
    for (const r of salesView.rotations) {
      assert.equal(r.fromUser, null);
      assert.equal(r.toUser, null);
    }

    const elevatedView = await inTenant(() =>
      rotation.listRotationsForLead(leadWithRotation!.leadId, {
        userId: priorOwnerId,
        tenantId,
        roleId: elevatedRoleId!,
      }),
    );
    assert.equal(elevatedView.canSeeOwners, true);
  });
});
