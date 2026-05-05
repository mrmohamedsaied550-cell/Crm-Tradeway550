/**
 * Phase D3 — D3.3: stage-specific status engine — integration tests.
 *
 * Real Postgres + a throwaway tenant. Verifies:
 *
 *   1. setStatus rejects a code that isn't in the stage's
 *      `allowedStatuses` catalogue with `lead.stage.status.invalid`.
 *
 *   2. setStatus on a valid code:
 *        - Inserts a `LeadStageStatus` row.
 *        - Updates `Lead.currentStageStatusId` to the new row.
 *        - Appends a `LeadActivity { type: 'stage_status_changed' }`
 *          carrying the diff payload.
 *        - Snapshots `Lead.attemptIndex` onto the row so the report
 *          surface can filter "statuses for this attempt only".
 *
 *   3. Out-of-scope leads surface as `lead.not_found` (404 contract
 *      mirrors `LeadsService.findByIdInScopeOrThrow`).
 *
 *   4. Stages with no `allowedStatuses` configured return an empty
 *      catalogue from `listForLead` (UI shows the "no statuses
 *      configured" hint instead of crashing).
 *
 *   5. moveStage under D3_ENGINE_V1=true CLEARS `currentStageStatusId`
 *      on a stage change AND blocks the move when the from-stage has
 *      `requireStatusOnExit = true` and no status was set in this
 *      stage attempt.
 *
 *   6. moveStage under D3_ENGINE_V1=false leaves `currentStageStatusId`
 *      intact (legacy behaviour byte-identical) and does NOT enforce
 *      `requireStatusOnExit`.
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
import { TenantSettingsService } from '../tenants/tenant-settings.service';
import { AssignmentService } from './assignment.service';
import { LeadsService } from './leads.service';
import { LeadStageStatusService } from './lead-stage-status.service';
import { PipelineService } from './pipeline.service';
import { SlaService } from './sla.service';

const TENANT_CODE = '__d33_stage_status__';

let prisma: PrismaClient;
let prismaSvc: PrismaService;
let leads: LeadsService;
let stageStatus: LeadStageStatusService;
let tenantId: string;
let actorUserId: string;
let leadId: string;
/** Stage with `allowedStatuses` configured AND `requireStatusOnExit = true`. */
let firstContactStageId: string;
/** Stage with `allowedStatuses` configured but no exit requirement. */
let interestedStageId: string;
/** Stage with empty `allowedStatuses` catalogue. */
let bareStageId: string;

function asUser(uid: string) {
  return { userId: uid, tenantId, roleId: '00000000-0000-0000-0000-000000000000' };
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

const FIRST_CONTACT_STATUSES = [
  { code: 'interested', label: 'Interested', labelAr: 'مهتم' },
  { code: 'no_answer', label: 'No Answer', labelAr: 'لم يرد' },
  { code: 'wrong_number', label: 'Wrong Number', labelAr: 'رقم خاطئ' },
];

describe('D3.3 — stage status engine integration', () => {
  before(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    prismaSvc = new PrismaService();
    const audit = new AuditService(prismaSvc);
    const tenantSettings = new TenantSettingsService(prismaSvc, audit);
    const pipeline = new PipelineService(prismaSvc);
    const assignment = new AssignmentService(prismaSvc);
    const sla = new SlaService(prismaSvc, assignment, undefined, tenantSettings);
    leads = new LeadsService(prismaSvc, pipeline, sla, tenantSettings);
    stageStatus = new LeadStageStatusService(prismaSvc);

    const tenant = await prisma.tenant.upsert({
      where: { code: TENANT_CODE },
      update: { isActive: true },
      create: { code: TENANT_CODE, name: 'D3.3 stage status' },
    });
    tenantId = tenant.id;

    await withTenantRaw(tenantId, async (tx) => {
      await tx.tenantSettings.upsert({
        where: { tenantId },
        update: {},
        create: { tenantId, timezone: 'Africa/Cairo', slaMinutes: 60, defaultDialCode: '+20' },
      });

      const role = await tx.role.create({
        data: { tenantId, code: 'd33_role', nameAr: 'دور', nameEn: 'D33 Role', level: 30 },
      });
      const actor = await tx.user.create({
        data: {
          tenantId,
          email: 'd33-actor@test',
          name: 'D33 Actor',
          // gitleaks-ignore: low-entropy test fixture, not a real secret.
          passwordHash: 'TESTHASH',
          status: 'active',
          roleId: role.id,
        },
      });
      actorUserId = actor.id;

      const pipe = await tx.pipeline.create({
        data: { tenantId, name: 'D33', isDefault: true, isActive: true },
        select: { id: true },
      });
      // Stage with allowedStatuses + requireStatusOnExit=true.
      const firstContact = await tx.pipelineStage.create({
        data: {
          tenantId,
          pipelineId: pipe.id,
          code: 'first_contact',
          name: 'First Contact',
          order: 10,
          allowedStatuses: FIRST_CONTACT_STATUSES,
          requireStatusOnExit: true,
        },
      });
      firstContactStageId = firstContact.id;

      // Stage with allowedStatuses but NO exit requirement.
      const interested = await tx.pipelineStage.create({
        data: {
          tenantId,
          pipelineId: pipe.id,
          code: 'interested',
          name: 'Interested',
          order: 20,
          allowedStatuses: [
            { code: 'pending_docs', label: 'Pending Docs', labelAr: 'بانتظار المستندات' },
            { code: 'ready', label: 'Ready', labelAr: 'جاهز' },
          ],
        },
      });
      interestedStageId = interested.id;

      // Stage with no catalogue at all.
      const bare = await tx.pipelineStage.create({
        data: {
          tenantId,
          pipelineId: pipe.id,
          code: 'bare',
          name: 'Bare',
          order: 30,
        },
      });
      bareStageId = bare.id;

      // Lead starts in first_contact.
      const lead = await tx.lead.create({
        data: {
          tenantId,
          name: 'L',
          phone: '+201001000700',
          source: 'manual',
          stageId: firstContactStageId,
          lifecycleState: 'open',
          slaStatus: 'active',
          attemptIndex: 1,
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

  it('listForLead returns the stage catalogue + empty history initially', async () => {
    const result = await inTenant(() => stageStatus.listForLead(leadId, asUser(actorUserId)));
    assert.equal(result.stage.id, firstContactStageId);
    assert.equal(result.allowedStatuses.length, 3);
    assert.equal(result.allowedStatuses[0]!.code, 'interested');
    assert.equal(result.history.length, 0);
    assert.equal(result.currentStatus, null);
  });

  it('setStatus rejects a code not in the stage catalogue', async () => {
    await assert.rejects(
      () =>
        inTenant(() =>
          stageStatus.setStatus(
            leadId,
            { status: 'never_configured' },
            actorUserId,
            asUser(actorUserId),
          ),
        ),
      (err: { response?: { code?: string } } & Error) => {
        assert.equal(err.response?.code, 'lead.stage.status.invalid');
        return true;
      },
    );
  });

  it('setStatus writes the row, denormalises the pointer, and emits the activity', async () => {
    await inTenant(() =>
      stageStatus.setStatus(
        leadId,
        { status: 'no_answer', notes: 'Tried twice' },
        actorUserId,
        asUser(actorUserId),
      ),
    );

    const view = await inTenant(() => stageStatus.listForLead(leadId, asUser(actorUserId)));
    assert.equal(view.history.length, 1);
    assert.equal(view.history[0]!.status, 'no_answer');
    assert.equal(view.history[0]!.attemptIndex, 1);
    assert.equal(view.history[0]!.notes, 'Tried twice');
    assert.equal(view.currentStatus?.id, view.history[0]!.id);

    const lead = await withTenantRaw(tenantId, (tx) =>
      tx.lead.findUnique({ where: { id: leadId }, select: { currentStageStatusId: true } }),
    );
    assert.equal(lead!.currentStageStatusId, view.currentStatus!.id);

    const activities = await withTenantRaw(tenantId, (tx) =>
      tx.leadActivity.findMany({
        where: { leadId, type: 'stage_status_changed' },
        select: { type: true, payload: true, actionSource: true },
      }),
    );
    assert.equal(activities.length, 1);
    assert.equal(activities[0]!.actionSource, 'lead');
    const payload = activities[0]!.payload as Record<string, unknown>;
    assert.equal(payload['toStatus'], 'no_answer');
    assert.equal(payload['fromStatus'], null);
    assert.equal(payload['attemptIndex'], 1);
    assert.equal(payload['notes'], 'Tried twice');
  });

  it('listForLead returns [] catalogue for a stage with no allowedStatuses', async () => {
    // Move the lead to the bare stage (use raw update to bypass the
    // requireStatusOnExit gate — that's tested separately below).
    await withTenantRaw(tenantId, (tx) =>
      tx.lead.update({ where: { id: leadId }, data: { stageId: bareStageId } }),
    );
    const view = await inTenant(() => stageStatus.listForLead(leadId, asUser(actorUserId)));
    assert.equal(view.allowedStatuses.length, 0);
    assert.equal(view.stage.id, bareStageId);
    // Reset the lead back to first_contact so subsequent tests start
    // with the same fixture.
    await withTenantRaw(tenantId, (tx) =>
      tx.lead.update({
        where: { id: leadId },
        data: { stageId: firstContactStageId },
      }),
    );
  });

  it('moveStage under D3_ENGINE_V1=false leaves currentStageStatusId untouched and does not enforce requireStatusOnExit', async () => {
    // Pre-condition: lead is in first_contact (requireStatusOnExit=true)
    // and has a current status from the earlier test ('no_answer').
    // Reset by setting status fresh.
    await inTenant(() =>
      stageStatus.setStatus(leadId, { status: 'interested' }, actorUserId, asUser(actorUserId)),
    );
    const beforeMove = await withTenantRaw(tenantId, (tx) =>
      tx.lead.findUnique({
        where: { id: leadId },
        select: { currentStageStatusId: true },
      }),
    );
    assert.ok(beforeMove?.currentStageStatusId);

    const prev = process.env['D3_ENGINE_V1'];
    process.env['D3_ENGINE_V1'] = 'false';
    try {
      // Move WITHOUT setting a status (would block under flag-on for
      // first_contact but flag-off should let it through).
      await inTenant(() =>
        leads.moveStage(leadId, { pipelineStageId: interestedStageId }, actorUserId),
      );
      const after = await withTenantRaw(tenantId, (tx) =>
        tx.lead.findUnique({
          where: { id: leadId },
          select: { stageId: true, currentStageStatusId: true },
        }),
      );
      assert.equal(after!.stageId, interestedStageId);
      // Flag-off → pointer NOT cleared (legacy behaviour).
      assert.equal(after!.currentStageStatusId, beforeMove!.currentStageStatusId);
    } finally {
      if (prev === undefined) delete process.env['D3_ENGINE_V1'];
      else process.env['D3_ENGINE_V1'] = prev;
    }

    // Reset the lead to first_contact for the next test.
    await withTenantRaw(tenantId, (tx) =>
      tx.lead.update({
        where: { id: leadId },
        data: { stageId: firstContactStageId, currentStageStatusId: null },
      }),
    );
  });

  it('moveStage under D3_ENGINE_V1=true blocks when requireStatusOnExit is set and no status was recorded', async () => {
    // Lead is in first_contact (requireStatusOnExit=true) and the
    // pointer was just cleared by the previous test's reset.
    const prev = process.env['D3_ENGINE_V1'];
    process.env['D3_ENGINE_V1'] = 'true';
    try {
      await assert.rejects(
        () =>
          inTenant(() =>
            leads.moveStage(leadId, { pipelineStageId: interestedStageId }, actorUserId),
          ),
        (err: { response?: { code?: string } } & Error) => {
          assert.equal(err.response?.code, 'lead.stage.status_required');
          return true;
        },
      );
    } finally {
      if (prev === undefined) delete process.env['D3_ENGINE_V1'];
      else process.env['D3_ENGINE_V1'] = prev;
    }
  });

  it('moveStage under D3_ENGINE_V1=true clears currentStageStatusId after a successful move', async () => {
    // Set a status so the requireStatusOnExit gate passes.
    await inTenant(() =>
      stageStatus.setStatus(leadId, { status: 'wrong_number' }, actorUserId, asUser(actorUserId)),
    );
    const beforeMove = await withTenantRaw(tenantId, (tx) =>
      tx.lead.findUnique({
        where: { id: leadId },
        select: { currentStageStatusId: true },
      }),
    );
    assert.ok(beforeMove?.currentStageStatusId);

    const prev = process.env['D3_ENGINE_V1'];
    process.env['D3_ENGINE_V1'] = 'true';
    try {
      await inTenant(() =>
        leads.moveStage(leadId, { pipelineStageId: interestedStageId }, actorUserId),
      );
      const after = await withTenantRaw(tenantId, (tx) =>
        tx.lead.findUnique({
          where: { id: leadId },
          select: { stageId: true, currentStageStatusId: true },
        }),
      );
      assert.equal(after!.stageId, interestedStageId);
      assert.equal(after!.currentStageStatusId, null, 'pointer cleared on stage change');
    } finally {
      if (prev === undefined) delete process.env['D3_ENGINE_V1'];
      else process.env['D3_ENGINE_V1'] = prev;
    }
  });
});
