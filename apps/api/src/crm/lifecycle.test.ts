/**
 * Phase A — A3: lifecycle + lost-reason on stage move; unconvert.
 *
 * Real Postgres + a throwaway tenant. Verifies:
 *
 *   moveStage → lost stage:
 *     - rejects without lostReasonId  (lead.lost_reason_required)
 *     - rejects with unknown lostReasonId (lead.lost_reason_not_in_tenant)
 *     - rejects with INACTIVE lostReasonId (same code path)
 *     - succeeds + writes lifecycleState='lost' + reason + note
 *     - activity payload carries toLifecycleState + lostReasonId
 *
 *   moveStage → non-lost stage:
 *     - rejects when lostReasonId is provided
 *       (lead.lost_reason_only_on_lost_stage)
 *     - returning a lost lead to non-terminal clears reason+note
 *     - lifecycleState flips back to 'open'
 *
 *   moveStage → won stage:
 *     - lifecycleState flips to 'won'
 *
 *   unconvert:
 *     - rejects on a never-converted lead
 *     - succeeds when captain has zero trips: deletes captain,
 *       reopens lead at first non-terminal stage, lifecycle='open'
 *     - rejects when captain has trips (captain.unconvert_has_trips)
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
import { CaptainsService } from './captains.service';
import { LeadsService } from './leads.service';
import { LostReasonsService } from './lost-reasons.service';
import { PipelineService } from './pipeline.service';
import { AssignmentService } from './assignment.service';
import { SlaService } from './sla.service';

const TENANT_CODE = '__a3_lifecycle__';

let prisma: PrismaClient;
let prismaSvc: PrismaService;
let leads: LeadsService;
let captains: CaptainsService;
let tenantId: string;
let actorUserId: string;
let newStageId: string;
let contactedStageId: string;
let lostStageId: string;
let reasonNoVehicleId: string;
let reasonInactiveId: string;

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

async function freshLead(name: string, phone: string): Promise<string> {
  return inTenant(async () => {
    const lead = await leads.create({ name, phone, source: 'manual' }, actorUserId);
    return lead.id;
  });
}

describe('crm — lifecycle + lost-reason + unconvert (A3)', () => {
  before(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    prismaSvc = new PrismaService();
    const pipeline = new PipelineService(prismaSvc);
    const lostReasons = new LostReasonsService(prismaSvc);
    const assignment = new AssignmentService(prismaSvc);
    const audit = new AuditService(prismaSvc);
    const tenantSettings = new TenantSettingsService(prismaSvc, audit);
    const sla = new SlaService(prismaSvc, assignment, undefined, tenantSettings);
    const rules = new DistributionRulesService(prismaSvc);
    const capacities = new AgentCapacitiesService(prismaSvc);
    const routingLog = new LeadRoutingLogService(prismaSvc);
    const distribution = new DistributionService(prismaSvc, rules, capacities, routingLog);
    leads = new LeadsService(
      prismaSvc,
      pipeline,
      sla,
      tenantSettings,
      distribution,
      undefined,
      lostReasons,
    );
    captains = new CaptainsService(prismaSvc, pipeline, leads);

    const tenant = await prisma.tenant.upsert({
      where: { code: TENANT_CODE },
      update: { isActive: true },
      create: { code: TENANT_CODE, name: 'A3 lifecycle' },
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
          email: 'a3-actor@test',
          name: 'Actor',
          passwordHash: 'x',
          status: 'active',
          roleId: role.id,
        },
      });
      actorUserId = actor.id;

      // Default pipeline + 4 stages incl. 'won' and 'lost' terminals.
      const pipe = await tx.pipeline.create({
        data: { tenantId, name: 'Default', isDefault: true, isActive: true },
        select: { id: true },
      });
      const sNew = await tx.pipelineStage.create({
        data: { tenantId, pipelineId: pipe.id, code: 'new', name: 'New', order: 10 },
      });
      newStageId = sNew.id;
      const sCont = await tx.pipelineStage.create({
        data: { tenantId, pipelineId: pipe.id, code: 'contacted', name: 'Contacted', order: 20 },
      });
      contactedStageId = sCont.id;
      await tx.pipelineStage.create({
        data: {
          tenantId,
          pipelineId: pipe.id,
          code: 'converted',
          name: 'Converted',
          order: 40,
          isTerminal: true,
          terminalKind: 'won',
        },
      });
      const sLost = await tx.pipelineStage.create({
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
      lostStageId = sLost.id;

      // Lost reasons: one active (no_vehicle), one inactive
      // (deactivated_reason) so we can test the inactive-rejection.
      const noVehicle = await tx.lostReason.create({
        data: {
          tenantId,
          code: 'no_vehicle',
          labelEn: 'No vehicle',
          labelAr: 'لا توجد مركبة',
          displayOrder: 10,
        },
      });
      reasonNoVehicleId = noVehicle.id;
      const inactive = await tx.lostReason.create({
        data: {
          tenantId,
          code: 'deactivated_reason',
          labelEn: 'Deactivated',
          labelAr: 'معطّل',
          displayOrder: 20,
          isActive: false,
        },
      });
      reasonInactiveId = inactive.id;
    });
  });

  after(async () => {
    await prisma.tenant.delete({ where: { code: TENANT_CODE } }).catch(() => {});
    await prisma.$disconnect();
  });

  // ─── moveStage → lost ────────────────────────────────────────────

  it('moving to lost without a reason is rejected', async () => {
    const id = await freshLead('R1', '+201001000101');
    await assert.rejects(
      () => inTenant(() => leads.moveStage(id, { stageCode: 'lost' }, actorUserId)),
      (err: { response?: { code?: string } } & Error) => {
        assert.equal(err.response?.code, 'lead.lost_reason_required');
        return true;
      },
    );
  });

  it('moving to lost with an unknown reasonId is rejected', async () => {
    const id = await freshLead('R2', '+201001000102');
    await assert.rejects(
      () =>
        inTenant(() =>
          leads.moveStage(
            id,
            { stageCode: 'lost', lostReasonId: '00000000-0000-0000-0000-000000000000' },
            actorUserId,
          ),
        ),
      (err: { response?: { code?: string } } & Error) => {
        assert.equal(err.response?.code, 'lead.lost_reason_not_in_tenant');
        return true;
      },
    );
  });

  it('moving to lost with an INACTIVE reasonId is rejected', async () => {
    const id = await freshLead('R3', '+201001000103');
    await assert.rejects(
      () =>
        inTenant(() =>
          leads.moveStage(id, { stageCode: 'lost', lostReasonId: reasonInactiveId }, actorUserId),
        ),
      (err: { response?: { code?: string } } & Error) => {
        assert.equal(err.response?.code, 'lead.lost_reason_not_in_tenant');
        return true;
      },
    );
  });

  it('moving to lost with a valid active reason succeeds', async () => {
    const id = await freshLead('R4', '+201001000104');
    const moved = await inTenant(() =>
      leads.moveStage(
        id,
        { stageCode: 'lost', lostReasonId: reasonNoVehicleId, lostNote: 'spouse owns car' },
        actorUserId,
      ),
    );
    assert.equal(moved.lifecycleState, 'lost');
    assert.equal(moved.lostReasonId, reasonNoVehicleId);
    assert.equal(moved.lostNote, 'spouse owns car');
    assert.equal(moved.stageId, lostStageId);

    // Activity payload contains the lifecycle + reason hints.
    const acts = await inTenant(() => leads.listActivities(id));
    const stageChange = acts.find((a) => a.type === 'stage_change');
    const p = stageChange?.payload as Record<string, unknown>;
    assert.equal(p?.toLifecycleState, 'lost');
    assert.equal(p?.lostReasonId, reasonNoVehicleId);
  });

  // ─── moveStage → non-lost rejects lostReasonId ───────────────────

  it('passing lostReasonId on a non-lost stage move is rejected', async () => {
    const id = await freshLead('R5', '+201001000105');
    await assert.rejects(
      () =>
        inTenant(() =>
          leads.moveStage(
            id,
            { stageCode: 'contacted', lostReasonId: reasonNoVehicleId },
            actorUserId,
          ),
        ),
      (err: { response?: { code?: string } } & Error) => {
        assert.equal(err.response?.code, 'lead.lost_reason_only_on_lost_stage');
        return true;
      },
    );
  });

  // ─── lifecycle round-trip ────────────────────────────────────────

  it('moving to contacted produces lifecycleState=open', async () => {
    const id = await freshLead('R6', '+201001000106');
    const moved = await inTenant(() =>
      leads.moveStage(id, { stageCode: 'contacted' }, actorUserId),
    );
    assert.equal(moved.lifecycleState, 'open');
    assert.equal(moved.stageId, contactedStageId);
  });

  it('moving to converted produces lifecycleState=won', async () => {
    const id = await freshLead('R7', '+201001000107');
    const moved = await inTenant(() =>
      leads.moveStage(id, { stageCode: 'converted' }, actorUserId),
    );
    assert.equal(moved.lifecycleState, 'won');
  });

  it('un-losing a lost lead clears reason+note and flips lifecycle to open', async () => {
    const id = await freshLead('R8', '+201001000108');
    // Lose it first.
    await inTenant(() =>
      leads.moveStage(id, { stageCode: 'lost', lostReasonId: reasonNoVehicleId }, actorUserId),
    );
    // Then move it back.
    const reopened = await inTenant(() => leads.moveStage(id, { stageCode: 'new' }, actorUserId));
    assert.equal(reopened.lifecycleState, 'open');
    assert.equal(reopened.lostReasonId, null);
    assert.equal(reopened.lostNote, null);
    assert.equal(reopened.stageId, newStageId);
  });

  // ─── unconvert ───────────────────────────────────────────────────

  it('unconvert on a never-converted lead is rejected', async () => {
    const id = await freshLead('U1', '+201001000201');
    await assert.rejects(
      () => inTenant(() => captains.unconvertFromLead(id, actorUserId)),
      (err: { response?: { code?: string } } & Error) => {
        assert.equal(err.response?.code, 'captain.not_converted');
        return true;
      },
    );
  });

  it('unconvert reopens the lead and deletes the captain (no trips)', async () => {
    const leadId = await freshLead('U2', '+201001000202');
    const captain = await inTenant(() => captains.convertFromLead(leadId, {}, actorUserId));
    assert.ok(captain.id);

    const reopened = await inTenant(() => captains.unconvertFromLead(leadId, actorUserId));
    assert.equal(reopened.lifecycleState, 'open');
    assert.equal(reopened.stageId, newStageId);
    assert.equal(reopened.captain, null);

    // Captain row is gone.
    const stillThere = await inTenant(() =>
      prismaSvc.withTenant(tenantId, (tx) => tx.captain.findUnique({ where: { id: captain.id } })),
    );
    assert.equal(stillThere, null);

    // Activity timeline records both directions.
    const acts = await inTenant(() => leads.listActivities(leadId));
    const events = acts.map((a) => (a.payload as Record<string, unknown> | null)?.event);
    assert.ok(events.includes('converted'));
    assert.ok(events.includes('unconverted'));
  });

  it('unconvert refuses when captain has trips', async () => {
    const leadId = await freshLead('U3', '+201001000203');
    const captain = await inTenant(() => captains.convertFromLead(leadId, {}, actorUserId));
    // Bypass services and bump the tripCount directly to simulate
    // operational telemetry that has already arrived.
    await withTenantRaw(tenantId, async (tx) => {
      await tx.captain.update({
        where: { id: captain.id },
        data: { tripCount: 3, firstTripAt: new Date() },
      });
    });
    await assert.rejects(
      () => inTenant(() => captains.unconvertFromLead(leadId, actorUserId)),
      (err: { response?: { code?: string } } & Error) => {
        assert.equal(err.response?.code, 'captain.unconvert_has_trips');
        return true;
      },
    );
  });
});
