/**
 * Phase D3 — D3.4: lead rotation engine — integration tests.
 *
 * Real Postgres + a throwaway tenant. Verifies:
 *
 *   1. Same-owner rotation rejected with `lead.rotate.same_owner`.
 *
 *   2. Invalid target user rejected with `lead.rotate.invalid_target`
 *      (cross-tenant or disabled).
 *
 *   3. Successful rotation (Full Transfer):
 *        - Lead.assignedToId flipped to target.
 *        - Lead.lastRotatedAt stamped.
 *        - LeadRotationLog row written with from/to/trigger/mode +
 *          attemptIndex snapshot.
 *        - LeadActivity { type: 'rotation' } appended.
 *        - audit_events.lead.rotated row written.
 *
 *   4. Clean Transfer cancels pending follow-ups owned by the prior
 *      agent (marks completedAt, leaves activity rows untouched).
 *      Lead.nextActionDueAt recomputed.
 *
 *   5. Visibility gate on `listRotationsForLead`:
 *        - Sales-agent-shaped role (lead.assign without lead.write,
 *          mirroring AGENT_ACTIONS): canSeeOwners=false; fromUser /
 *          toUser / actor / notes all NULL on every row.
 *        - Elevated role with lead.write: canSeeOwners=true; full
 *          owner data returned.
 *
 *   6. Out-of-scope leads surface as `lead.not_found`.
 *
 * Local: same DB-unreachable hook-failure pattern as every other
 * integration test in this repo.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { tenantContext } from '../tenants/tenant-context';
import { ScopeContextService } from '../rbac/scope-context.service';
import { RotationService } from './rotation.service';

const TENANT_CODE = '__d34_rotation__';

let prisma: PrismaClient;
let prismaSvc: PrismaService;
let rotation: RotationService;
let tenantId: string;
let actorUserId: string;
let priorOwnerId: string;
let nextOwnerId: string;
/** Sales-agent-shaped role: holds `lead.assign` only (mirrors the
 *  seeded AGENT_ACTIONS bundle). MUST NOT see owner names in
 *  `listRotationsForLead`. */
let salesAgentRoleId: string;
/** Elevated role: holds `lead.write`. SEES owner names. */
let elevatedRoleId: string;
let entryStageId: string;
let leadId: string;

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

describe('D3.4 — lead rotation engine integration', () => {
  before(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    prismaSvc = new PrismaService();
    const audit = new AuditService(prismaSvc);
    const scopeContext = new ScopeContextService(prismaSvc);
    rotation = new RotationService(prismaSvc, undefined, scopeContext, audit);

    const tenant = await prisma.tenant.upsert({
      where: { code: TENANT_CODE },
      update: { isActive: true },
      create: { code: TENANT_CODE, name: 'D3.4 rotation' },
    });
    tenantId = tenant.id;

    await withTenantRaw(tenantId, async (tx) => {
      await tx.tenantSettings.upsert({
        where: { tenantId },
        update: {},
        create: { tenantId, timezone: 'Africa/Cairo', slaMinutes: 60, defaultDialCode: '+20' },
      });

      // Capabilities — upsert so the test doesn't depend on the seed.
      const writeCap = await tx.capability.upsert({
        where: { code: 'lead.write' },
        update: {},
        create: { code: 'lead.write', description: 'Create / update / delete leads' },
      });
      const assignCap = await tx.capability.upsert({
        where: { code: 'lead.assign' },
        update: {},
        create: { code: 'lead.assign', description: 'Assign / auto-assign leads' },
      });

      // Sales-agent-shaped role: lead.assign only (mirrors AGENT_ACTIONS).
      const salesRole = await tx.role.create({
        data: { tenantId, code: 'sales_agent', nameAr: 'مبيعات', nameEn: 'Sales', level: 30 },
      });
      salesAgentRoleId = salesRole.id;
      await tx.roleCapability.create({
        data: { tenantId, roleId: salesRole.id, capabilityId: assignCap.id },
      });

      // Elevated role: lead.write + lead.assign.
      const elevatedRole = await tx.role.create({
        data: { tenantId, code: 'd34_ops', nameAr: 'عمليات', nameEn: 'Ops (D3.4)', level: 70 },
      });
      elevatedRoleId = elevatedRole.id;
      await tx.roleCapability.create({
        data: { tenantId, roleId: elevatedRole.id, capabilityId: writeCap.id },
      });
      await tx.roleCapability.create({
        data: { tenantId, roleId: elevatedRole.id, capabilityId: assignCap.id },
      });

      // Three users: actor (the TL who triggers), prior owner, next owner.
      const actor = await tx.user.create({
        data: {
          tenantId,
          email: 'd34-actor@test',
          name: 'Actor',
          // gitleaks-ignore: low-entropy test fixture, not a real secret.
          passwordHash: 'TESTHASH',
          status: 'active',
          roleId: elevatedRole.id,
        },
      });
      actorUserId = actor.id;
      const prior = await tx.user.create({
        data: {
          tenantId,
          email: 'd34-prior@test',
          name: 'Prior',
          passwordHash: 'TESTHASH',
          status: 'active',
          roleId: salesRole.id,
        },
      });
      priorOwnerId = prior.id;
      const next = await tx.user.create({
        data: {
          tenantId,
          email: 'd34-next@test',
          name: 'Next',
          passwordHash: 'TESTHASH',
          status: 'active',
          roleId: salesRole.id,
        },
      });
      nextOwnerId = next.id;

      const pipe = await tx.pipeline.create({
        data: { tenantId, name: 'D34', isDefault: true, isActive: true },
        select: { id: true },
      });
      const entry = await tx.pipelineStage.create({
        data: { tenantId, pipelineId: pipe.id, code: 'new', name: 'New', order: 10 },
      });
      entryStageId = entry.id;

      const lead = await tx.lead.create({
        data: {
          tenantId,
          name: 'L',
          phone: '+201001000800',
          source: 'manual',
          stageId: entryStageId,
          lifecycleState: 'open',
          slaStatus: 'active',
          attemptIndex: 1,
          assignedToId: priorOwnerId,
        },
        select: { id: true },
      });
      leadId = lead.id;
    });
  });

  after(async () => {
    await prisma.tenant.delete({ where: { code: TENANT_CODE } }).catch(() => {});
    await prisma.$disconnect();
  });

  it('rejects rotation to the same owner with lead.rotate.same_owner', async () => {
    await assert.rejects(
      () =>
        inTenant(() =>
          rotation.rotateLead({
            leadId,
            trigger: 'manual_tl',
            handoverMode: 'full',
            toUserId: priorOwnerId,
            actorUserId,
            userClaims: asUser(actorUserId, elevatedRoleId),
          }),
        ),
      (err: { response?: { code?: string } } & Error) => {
        assert.equal(err.response?.code, 'lead.rotate.same_owner');
        return true;
      },
    );
  });

  it('rejects an invalid target user with lead.rotate.invalid_target', async () => {
    await assert.rejects(
      () =>
        inTenant(() =>
          rotation.rotateLead({
            leadId,
            trigger: 'manual_tl',
            handoverMode: 'full',
            toUserId: '00000000-0000-0000-0000-000000000000',
            actorUserId,
            userClaims: asUser(actorUserId, elevatedRoleId),
          }),
        ),
      (err: { response?: { code?: string } } & Error) => {
        assert.equal(err.response?.code, 'lead.rotate.invalid_target');
        return true;
      },
    );
  });

  it('full transfer: writes log + activity + audit, flips assignedToId, stamps lastRotatedAt', async () => {
    const result = await inTenant(() =>
      rotation.rotateLead({
        leadId,
        trigger: 'manual_tl',
        handoverMode: 'full',
        toUserId: nextOwnerId,
        reasonCode: 'capacity_balance',
        notes: 'Reassigning to balance load',
        actorUserId,
        userClaims: asUser(actorUserId, elevatedRoleId),
      }),
    );
    assert.equal(result.fromUserId, priorOwnerId);
    assert.equal(result.toUserId, nextOwnerId);
    assert.equal(result.handoverMode, 'full');
    assert.equal(result.cancelledFollowUpCount, 0);

    // Lead row updates.
    const lead = await withTenantRaw(tenantId, (tx) =>
      tx.lead.findUnique({
        where: { id: leadId },
        select: { assignedToId: true, lastRotatedAt: true },
      }),
    );
    assert.equal(lead!.assignedToId, nextOwnerId);
    assert.ok(lead!.lastRotatedAt, 'lastRotatedAt stamped');

    // Rotation log row.
    const log = await withTenantRaw(tenantId, (tx) =>
      tx.leadRotationLog.findUnique({ where: { id: result.rotationId } }),
    );
    assert.ok(log);
    assert.equal(log!.fromUserId, priorOwnerId);
    assert.equal(log!.toUserId, nextOwnerId);
    assert.equal(log!.handoverMode, 'full');
    assert.equal(log!.trigger, 'manual_tl');
    assert.equal(log!.reasonCode, 'capacity_balance');
    assert.equal(log!.attemptIndex, 1);

    // LeadActivity row.
    const activities = await withTenantRaw(tenantId, (tx) =>
      tx.leadActivity.findMany({
        where: { leadId, type: 'rotation' },
        select: { type: true, payload: true, actionSource: true },
      }),
    );
    assert.equal(activities.length, 1);
    assert.equal(activities[0]!.actionSource, 'lead');
    const payload = activities[0]!.payload as Record<string, unknown>;
    assert.equal(payload['fromUserId'], priorOwnerId);
    assert.equal(payload['toUserId'], nextOwnerId);
    assert.equal(payload['handoverMode'], 'full');

    // Audit verb.
    const audit = await withTenantRaw(tenantId, (tx) =>
      tx.auditEvent.findFirst({
        where: { tenantId, action: 'lead.rotated', entityId: leadId },
      }),
    );
    assert.ok(audit, 'lead.rotated audit row exists');
    assert.equal(audit!.actorUserId, actorUserId);
  });

  it('clean transfer: cancels pending follow-ups owned by the prior agent', async () => {
    // Reset the lead back to priorOwnerId for this test.
    await withTenantRaw(tenantId, (tx) =>
      tx.lead.update({ where: { id: leadId }, data: { assignedToId: priorOwnerId } }),
    );
    // Add two pending follow-ups owned by priorOwnerId, plus one
    // already-completed (which must NOT be touched).
    await withTenantRaw(tenantId, async (tx) => {
      const dueAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await tx.leadFollowUp.create({
        data: {
          tenantId,
          leadId,
          actionType: 'call',
          dueAt,
          assignedToId: priorOwnerId,
          createdById: priorOwnerId,
        },
      });
      await tx.leadFollowUp.create({
        data: {
          tenantId,
          leadId,
          actionType: 'whatsapp',
          dueAt,
          assignedToId: priorOwnerId,
          createdById: priorOwnerId,
        },
      });
      await tx.leadFollowUp.create({
        data: {
          tenantId,
          leadId,
          actionType: 'visit',
          dueAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
          assignedToId: priorOwnerId,
          createdById: priorOwnerId,
          completedAt: new Date(),
        },
      });
    });

    const result = await inTenant(() =>
      rotation.rotateLead({
        leadId,
        trigger: 'manual_tl',
        handoverMode: 'clean',
        toUserId: nextOwnerId,
        actorUserId,
        userClaims: asUser(actorUserId, elevatedRoleId),
      }),
    );
    assert.equal(result.handoverMode, 'clean');
    assert.equal(result.cancelledFollowUpCount, 2, 'two pending follow-ups cancelled');

    // The two pending follow-ups now have completedAt set.
    const stillPending = await withTenantRaw(tenantId, (tx) =>
      tx.leadFollowUp.count({
        where: { leadId, completedAt: null },
      }),
    );
    assert.equal(stillPending, 0, 'no pending follow-ups remain for the lead');

    // Lead.nextActionDueAt recomputed (no pending → null).
    const lead = await withTenantRaw(tenantId, (tx) =>
      tx.lead.findUnique({ where: { id: leadId }, select: { nextActionDueAt: true } }),
    );
    assert.equal(lead!.nextActionDueAt, null);
  });

  it('listRotationsForLead redacts owner names for sales-agent-shaped role', async () => {
    const view = await inTenant(() =>
      rotation.listRotationsForLead(leadId, asUser(actorUserId, salesAgentRoleId)),
    );
    assert.equal(view.canSeeOwners, false);
    assert.ok(view.rotations.length >= 1, 'history has at least one row');
    for (const row of view.rotations) {
      assert.equal(row.fromUser, null);
      assert.equal(row.toUser, null);
      assert.equal(row.actor, null);
      assert.equal(row.notes, null);
      // reasonCode + handoverMode + trigger remain.
      assert.equal(typeof row.handoverMode, 'string');
      assert.equal(typeof row.trigger, 'string');
    }
  });

  it('listRotationsForLead returns full owner names for lead.write role', async () => {
    const view = await inTenant(() =>
      rotation.listRotationsForLead(leadId, asUser(actorUserId, elevatedRoleId)),
    );
    assert.equal(view.canSeeOwners, true);
    const withOwners = view.rotations.find((r) => r.fromUser !== null);
    assert.ok(withOwners, 'at least one rotation surfaces owner names for elevated role');
    assert.equal(typeof withOwners!.fromUser?.name, 'string');
    assert.equal(typeof withOwners!.toUser?.name, 'string');
  });

  it("rotateLead 404s when the lead is out of the caller's scope", async () => {
    await assert.rejects(
      () =>
        inTenant(() =>
          rotation.rotateLead({
            leadId: '00000000-0000-0000-0000-000000000000',
            trigger: 'manual_tl',
            handoverMode: 'full',
            toUserId: nextOwnerId,
            actorUserId,
            userClaims: asUser(actorUserId, elevatedRoleId),
          }),
        ),
      (err: { response?: { code?: string } } & Error) => {
        assert.equal(err.response?.code, 'lead.not_found');
        return true;
      },
    );
  });
});
