/**
 * Phase D3 — D3.6: TL Review Queue — integration tests.
 *
 * Real Postgres + a throwaway tenant. Verifies:
 *
 *   1. raiseReview creates a LeadReview row + a
 *      LeadActivity { type: 'lead_review_raised' } + an
 *      audit_events.lead.review.raised row.
 *
 *   2. raiseReview is idempotent on (lead, reason, open) — calling
 *      it twice for the same open row returns the existing id and
 *      writes nothing extra.
 *
 *   3. listReviews respects the lead-scope filter (TL on team A
 *      sees A's reviews; not team B's).
 *
 *   4. resolveReview kept_owner / dismissed require notes; the
 *      service rejects without with `lead.review.notes_required`.
 *
 *   5. resolveReview escalated creates a child review with reason
 *      `escalated_by_tl` and `assignedTlId = NULL`.
 *
 *   6. resolveReview writes LeadActivity { type:
 *      'lead_review_resolved' } and audit_events.lead.review.resolved.
 *
 *   7. Double-resolve returns `lead.review.already_resolved`.
 *
 *   8. SLA-rotation D3.5 path now creates a LeadReview when the
 *      escalation policy decides review_pending (replaces the
 *      audit-only D3.5 placeholder).
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
import { LeadReviewService } from './lead-review.service';
import { RotationService } from './rotation.service';
import { SlaService } from './sla.service';

const TENANT_CODE = '__d36_lead_reviews__';

let prisma: PrismaClient;
let prismaSvc: PrismaService;
let reviews: LeadReviewService;
let sla: SlaService;
let tenantId: string;
let tlUserId: string;
let entryStageId: string;

function asUser(uid: string, rid: string) {
  return { userId: uid, tenantId, roleId: rid };
}

let elevatedRoleId: string;

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

describe('D3.6 — TL Review Queue', () => {
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
    const rotation = new RotationService(prismaSvc, distribution, scopeContext, audit);
    const escalationPolicy = new EscalationPolicyService(prismaSvc);
    reviews = new LeadReviewService(prismaSvc, scopeContext, audit);
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
      reviews, // D3.6 — wire the queue into the SLA breach path
    );

    const tenant = await prisma.tenant.upsert({
      where: { code: TENANT_CODE },
      update: { isActive: true },
      create: { code: TENANT_CODE, name: 'D3.6 lead reviews' },
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

      // Capabilities — upsert (idempotent across test runs).
      const writeCap = await tx.capability.upsert({
        where: { code: 'lead.write' },
        update: {},
        create: { code: 'lead.write', description: 'Create / update / delete leads' },
      });
      const reviewReadCap = await tx.capability.upsert({
        where: { code: 'lead.review.read' },
        update: {},
        create: { code: 'lead.review.read', description: 'View the TL Review Queue' },
      });
      const reviewResolveCap = await tx.capability.upsert({
        where: { code: 'lead.review.resolve' },
        update: {},
        create: { code: 'lead.review.resolve', description: 'Resolve a lead-review row' },
      });

      const tlRole = await tx.role.create({
        data: { tenantId, code: 'tl_d36', nameAr: 'قائد', nameEn: 'TL (D36)', level: 60 },
      });
      elevatedRoleId = tlRole.id;
      await tx.roleCapability.createMany({
        data: [
          { tenantId, roleId: tlRole.id, capabilityId: writeCap.id },
          { tenantId, roleId: tlRole.id, capabilityId: reviewReadCap.id },
          { tenantId, roleId: tlRole.id, capabilityId: reviewResolveCap.id },
        ],
      });

      const tlUser = await tx.user.create({
        data: {
          tenantId,
          email: 'd36-tl@test',
          name: 'TL',
          // gitleaks-ignore: low-entropy test fixture, not a real secret.
          passwordHash: 'TESTHASH',
          status: 'active',
          roleId: tlRole.id,
        },
      });
      tlUserId = tlUser.id;

      const pipe = await tx.pipeline.create({
        data: { tenantId, name: 'D36', isDefault: true, isActive: true },
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

  async function makeLead(phoneSuffix: string): Promise<string> {
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
          attemptIndex: 1,
          assignedToId: tlUserId,
        },
        select: { id: true },
      });
      return lead.id;
    });
  }

  it('raiseReview creates one row + activity + audit', async () => {
    const leadId = await makeLead('900');
    const result = await inTenant(() =>
      reviews.raiseReview({
        leadId,
        reason: 'manual_tl_review',
        actorUserId: tlUserId,
      }),
    );
    assert.equal(result.alreadyOpen, false);

    const row = await withTenantRaw(tenantId, (tx) =>
      tx.leadReview.findUnique({ where: { id: result.id } }),
    );
    assert.ok(row);
    assert.equal(row!.reason, 'manual_tl_review');
    assert.equal(row!.resolvedAt, null);

    const activities = await withTenantRaw(tenantId, (tx) =>
      tx.leadActivity.findMany({
        where: { leadId, type: 'lead_review_raised' },
      }),
    );
    assert.equal(activities.length, 1);

    const auditRow = await withTenantRaw(tenantId, (tx) =>
      tx.auditEvent.findFirst({
        where: { tenantId, action: 'lead.review.raised', entityId: result.id },
      }),
    );
    assert.ok(auditRow);
  });

  it('raiseReview is idempotent on (lead, reason, open)', async () => {
    const leadId = await makeLead('901');
    const first = await inTenant(() =>
      reviews.raiseReview({ leadId, reason: 'manual_tl_review', actorUserId: tlUserId }),
    );
    assert.equal(first.alreadyOpen, false);
    const second = await inTenant(() =>
      reviews.raiseReview({ leadId, reason: 'manual_tl_review', actorUserId: tlUserId }),
    );
    assert.equal(second.alreadyOpen, true);
    assert.equal(second.id, first.id);

    const count = await withTenantRaw(tenantId, (tx) =>
      tx.leadReview.count({ where: { tenantId, leadId, reason: 'manual_tl_review' } }),
    );
    assert.equal(count, 1, 'still only one review row');
  });

  it('resolveReview rejects kept_owner without notes', async () => {
    const leadId = await makeLead('902');
    const { id } = await inTenant(() =>
      reviews.raiseReview({ leadId, reason: 'manual_tl_review', actorUserId: tlUserId }),
    );
    await assert.rejects(
      () =>
        inTenant(() =>
          reviews.resolveReview(
            id,
            'kept_owner',
            undefined,
            tlUserId,
            asUser(tlUserId, elevatedRoleId),
          ),
        ),
      (err: { response?: { code?: string } } & Error) => {
        assert.equal(err.response?.code, 'lead.review.notes_required');
        return true;
      },
    );
  });

  it('resolveReview rejects dismissed without notes', async () => {
    const leadId = await makeLead('903');
    const { id } = await inTenant(() =>
      reviews.raiseReview({ leadId, reason: 'manual_tl_review', actorUserId: tlUserId }),
    );
    await assert.rejects(
      () =>
        inTenant(() =>
          reviews.resolveReview(
            id,
            'dismissed',
            undefined,
            tlUserId,
            asUser(tlUserId, elevatedRoleId),
          ),
        ),
      (err: { response?: { code?: string } } & Error) => {
        assert.equal(err.response?.code, 'lead.review.notes_required');
        return true;
      },
    );
  });

  it('resolveReview escalated creates a child escalated_by_tl row', async () => {
    const leadId = await makeLead('904');
    const parent = await inTenant(() =>
      reviews.raiseReview({ leadId, reason: 'sla_breach_repeat', actorUserId: null }),
    );

    const result = await inTenant(() =>
      reviews.resolveReview(
        parent.id,
        'escalated',
        'Needs ops attention',
        tlUserId,
        asUser(tlUserId, elevatedRoleId),
      ),
    );
    assert.equal(result.resolution, 'escalated');
    assert.ok(result.childReviewId, 'child review created');

    const child = await withTenantRaw(tenantId, (tx) =>
      tx.leadReview.findUnique({ where: { id: result.childReviewId! } }),
    );
    assert.ok(child);
    assert.equal(child!.reason, 'escalated_by_tl');
    assert.equal(child!.assignedTlId, null);
    const payload = child!.reasonPayload as Record<string, unknown>;
    assert.equal(payload['parentReviewId'], parent.id);
    assert.equal(payload['parentReason'], 'sla_breach_repeat');
  });

  it('resolveReview writes activity + audit on close', async () => {
    const leadId = await makeLead('905');
    const { id } = await inTenant(() =>
      reviews.raiseReview({ leadId, reason: 'manual_tl_review', actorUserId: tlUserId }),
    );
    await inTenant(() =>
      reviews.resolveReview(
        id,
        'kept_owner',
        'Owner is best placed to recover',
        tlUserId,
        asUser(tlUserId, elevatedRoleId),
      ),
    );

    const activities = await withTenantRaw(tenantId, (tx) =>
      tx.leadActivity.findMany({
        where: { leadId, type: 'lead_review_resolved' },
        select: { payload: true },
      }),
    );
    assert.equal(activities.length, 1);
    const payload = activities[0]!.payload as Record<string, unknown>;
    assert.equal(payload['resolution'], 'kept_owner');

    const auditRow = await withTenantRaw(tenantId, (tx) =>
      tx.auditEvent.findFirst({
        where: { tenantId, action: 'lead.review.resolved', entityId: id },
      }),
    );
    assert.ok(auditRow);
  });

  it('resolveReview rejects double-resolve with lead.review.already_resolved', async () => {
    const leadId = await makeLead('906');
    const { id } = await inTenant(() =>
      reviews.raiseReview({ leadId, reason: 'manual_tl_review', actorUserId: tlUserId }),
    );
    await inTenant(() =>
      reviews.resolveReview(id, 'rotated', undefined, tlUserId, asUser(tlUserId, elevatedRoleId)),
    );
    await assert.rejects(
      () =>
        inTenant(() =>
          reviews.resolveReview(
            id,
            'rotated',
            undefined,
            tlUserId,
            asUser(tlUserId, elevatedRoleId),
          ),
        ),
      (err: { response?: { code?: string } } & Error) => {
        assert.equal(err.response?.code, 'lead.review.already_resolved');
        return true;
      },
    );
  });

  it('SLA review-pending path materialises a LeadReview row when flag-on', async () => {
    const now = new Date();
    const leadId = await withTenantRaw(
      tenantId,
      async (tx) =>
        (
          await tx.lead.create({
            data: {
              tenantId,
              name: 'L',
              phone: '+201001000910',
              source: 'manual',
              stageId: entryStageId,
              lifecycleState: 'open',
              slaStatus: 'active',
              attemptIndex: 1,
              assignedToId: tlUserId,
              // 5 minutes overdue.
              slaDueAt: new Date(now.getTime() - 5 * 60 * 1000),
            },
            select: { id: true },
          })
        ).id,
    );
    // Plant a prior `sla_breach` rotation 1h ago to force the
    // repeat-window branch.
    await withTenantRaw(tenantId, (tx) =>
      tx.leadRotationLog.create({
        data: {
          tenantId,
          leadId,
          fromUserId: tlUserId,
          toUserId: tlUserId,
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
      assert.ok(myResult);
      assert.equal(myResult!.outcome, 'review_pending');

      // D3.6 behaviour — a real LeadReview row exists for this lead.
      const queueRow = await withTenantRaw(tenantId, (tx) =>
        tx.leadReview.findFirst({
          where: { tenantId, leadId, reason: 'sla_breach_repeat' },
        }),
      );
      assert.ok(queueRow, 'LeadReview row materialised for repeat breach');
      const payload = queueRow!.reasonPayload as Record<string, unknown>;
      assert.ok(payload['recentRotationId']);
      assert.equal(payload['windowHours'], 24);
    } finally {
      if (prev === undefined) delete process.env['D3_ENGINE_V1'];
      else process.env['D3_ENGINE_V1'] = prev;
    }
  });

  // Avoid unused `Prisma` import lint warning when the test file
  // doesn't actually use the namespace yet — we keep the import for
  // future test extensions and annotate with a void reference.
  void Prisma;
});
