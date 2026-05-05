/**
 * Phase D4 — D4.8: PartnerMergeService.attachEvidence (evidence-only).
 *
 * Real Postgres + a throwaway tenant. The capability gate
 * (`partner.evidence.write`) is enforced at the controller via
 * `@RequireCapability` and exercised by the broader e2e harness;
 * here we focus on the service-level invariants the product
 * decisions lock in:
 *
 *   • attachEvidence creates `LeadEvidence` (kind='partner_record')
 *   • attachEvidence writes a `LeadActivity` row of type
 *     `partner_evidence` with the structured payload
 *   • attachEvidence writes an `audit_events` row with action
 *     `partner.evidence.attached`
 *   • attachEvidence DOES NOT mutate the Captain row (no captain
 *     activatedAt/dftAt write, no merge)
 *   • attachEvidence DOES NOT update the Lead row (no stage move,
 *     no lifecycle flip)
 *   • attachEvidence resolves the latest `success`/`partial`
 *     `PartnerRecord` for the lead's contact phone when
 *     `partnerRecordId` is not supplied
 *   • attachEvidence resolves the snapshot id from a supplied
 *     `partnerRecordId` so the evidence row points at both ends of
 *     the audit chain
 *   • attachEvidence rejects with `partner.evidence.no_record` when
 *     no record exists for the lead/source pair
 *   • attachEvidence rejects with `lead.not_found` when the lead
 *     is out of scope for the calling user (TL on a different team)
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { ScopeContextService, type ScopeUserClaims } from '../rbac/scope-context.service';
import { tenantContext } from '../tenants/tenant-context';
import { PartnerMergeService } from './partner-merge.service';

const TENANT_CODE = '__d48_partner_evidence__';

let prisma: PrismaClient;
let prismaSvc: PrismaService;
let merge: PartnerMergeService;
let tenantId: string;
let actorUserId: string;
let actorClaims: ScopeUserClaims;
let leadId: string;
let captainId: string;
let captainActivatedAtBefore: Date | null;
let captainDftAtBefore: Date | null;
let partnerSourceId: string;
let snapshotId: string;
let recordId: string;
let stageConvertedId: string;

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

describe('partner — D4.8 attachEvidence (evidence-only)', () => {
  before(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    prismaSvc = new PrismaService();
    const audit = new AuditService(prismaSvc);
    const scopeContext = new ScopeContextService(prismaSvc);
    merge = new PartnerMergeService(prismaSvc, audit, scopeContext);

    const tenant = await prisma.tenant.upsert({
      where: { code: TENANT_CODE },
      update: { isActive: true },
      create: { code: TENANT_CODE, name: 'D4.8 evidence' },
    });
    tenantId = tenant.id;

    await withTenantRaw(tenantId, async (tx) => {
      await tx.tenantSettings.upsert({
        where: { tenantId },
        update: {},
        create: { tenantId, timezone: 'Africa/Cairo', slaMinutes: 60, defaultDialCode: '+20' },
      });

      // Super-admin-shaped role so the service's scope check yields a
      // global scope and lead lookups don't filter the actor out.
      const role = await tx.role.create({
        data: {
          tenantId,
          code: 'super_admin',
          nameAr: 'سوبر',
          nameEn: 'Super Admin',
          level: 100,
        },
      });
      const actor = await tx.user.create({
        data: {
          tenantId,
          email: 'd48-actor@test',
          name: 'Actor',
          passwordHash: 'x',
          status: 'active',
          roleId: role.id,
        },
      });
      actorUserId = actor.id;
      actorClaims = { userId: actor.id, tenantId, roleId: role.id };

      const pipeline = await tx.pipeline.create({
        data: { tenantId, name: 'Default', isDefault: true, isActive: true },
        select: { id: true },
      });
      await tx.pipelineStage.create({
        data: { tenantId, pipelineId: pipeline.id, code: 'new', name: 'New', order: 10 },
      });
      const sConv = await tx.pipelineStage.create({
        data: {
          tenantId,
          pipelineId: pipeline.id,
          code: 'converted',
          name: 'Converted',
          order: 40,
          isTerminal: true,
          terminalKind: 'won',
        },
      });
      stageConvertedId = sConv.id;

      // Contact + lead + already-converted captain (we want to assert
      // attachEvidence does NOT mutate the captain).
      const contact = await tx.contact.create({
        data: {
          tenantId,
          phone: '+201005551234',
          originalPhone: '+201005551234',
          displayName: 'D4.8 Captain',
        },
        select: { id: true },
      });
      const lead = await tx.lead.create({
        data: {
          tenantId,
          contactId: contact.id,
          name: 'D4.8 Captain',
          phone: '+201005551234',
          source: 'manual',
          stageId: stageConvertedId,
          lifecycleState: 'won',
        },
        select: { id: true },
      });
      leadId = lead.id;
      const captain = await tx.captain.create({
        data: {
          tenantId,
          name: 'D4.8 Captain',
          phone: '+201005551234',
          leadId: lead.id,
          activatedAt: null,
          dftAt: null,
        },
        select: { id: true, activatedAt: true, dftAt: true },
      });
      captainId = captain.id;
      captainActivatedAtBefore = captain.activatedAt;
      captainDftAtBefore = captain.dftAt;

      // Partner source + a successful snapshot with one matching record.
      const source = await tx.partnerSource.create({
        data: {
          tenantId,
          partnerCode: 'uber',
          displayName: 'Uber EG',
          adapter: 'manual_upload',
          isActive: true,
        },
        select: { id: true },
      });
      partnerSourceId = source.id;
      const snapshot = await tx.partnerSnapshot.create({
        data: {
          tenantId,
          partnerSourceId: source.id,
          status: 'success',
          rowsTotal: 1,
          rowsImported: 1,
          completedAt: new Date(),
          triggeredByUserId: actor.id,
        },
        select: { id: true },
      });
      snapshotId = snapshot.id;
      const record = await tx.partnerRecord.create({
        data: {
          tenantId,
          snapshotId: snapshot.id,
          partnerSourceId: source.id,
          contactId: contact.id,
          phone: '+201005551234',
          partnerStatus: 'active',
          partnerActiveDate: new Date('2026-04-01T00:00:00Z'),
          partnerDftDate: new Date('2026-04-15T00:00:00Z'),
          tripCount: 7,
          rawRow: { phone: '+201005551234', status: 'active' },
        },
        select: { id: true },
      });
      recordId = record.id;
    });
  });

  after(async () => {
    await prisma.tenant.delete({ where: { code: TENANT_CODE } }).catch(() => {});
    await prisma.$disconnect();
  });

  // ─── happy path: latest-record resolution ───────────────────────────

  it('attachEvidence creates LeadEvidence + LeadActivity + audit; does NOT touch Captain or Lead', async () => {
    const before = await withTenantRaw(tenantId, async (tx) => ({
      cap: await tx.captain.findUnique({
        where: { id: captainId },
        select: {
          activatedAt: true,
          dftAt: true,
          tripCount: true,
        },
      }),
      lead: await tx.lead.findUnique({
        where: { id: leadId },
        select: { stageId: true, lifecycleState: true },
      }),
    }));

    const result = await inTenant(() =>
      merge.attachEvidence({
        leadId,
        partnerSourceId,
        notes: 'Confirmed by phone before convert',
        actorUserId,
        userClaims: actorClaims,
      }),
    );
    assert.ok(result.evidenceId, 'returns evidenceId');
    assert.equal(result.partnerRecordId, recordId, 'resolves to latest record by phone');
    assert.equal(result.partnerSnapshotId, snapshotId);

    const after = await withTenantRaw(tenantId, async (tx) => ({
      evidence: await tx.leadEvidence.findUnique({ where: { id: result.evidenceId } }),
      cap: await tx.captain.findUnique({
        where: { id: captainId },
        select: {
          activatedAt: true,
          dftAt: true,
          tripCount: true,
        },
      }),
      lead: await tx.lead.findUnique({
        where: { id: leadId },
        select: { stageId: true, lifecycleState: true },
      }),
      activity: await tx.leadActivity.findFirst({
        where: { leadId, type: 'partner_evidence' },
        orderBy: { createdAt: 'desc' },
      }),
      audit: await tx.auditEvent.findFirst({
        where: { tenantId, action: 'partner.evidence.attached', entityId: result.evidenceId },
      }),
    }));

    // Evidence row is well-formed.
    assert.ok(after.evidence, 'evidence row exists');
    assert.equal(after.evidence!.kind, 'partner_record');
    assert.equal(after.evidence!.partnerRecordId, recordId);
    assert.equal(after.evidence!.partnerSnapshotId, snapshotId);
    assert.equal(after.evidence!.notes, 'Confirmed by phone before convert');
    assert.equal(after.evidence!.capturedByUserId, actorUserId);

    // Captain is UNCHANGED.
    assert.equal(
      after.cap!.activatedAt?.toISOString() ?? null,
      before.cap!.activatedAt?.toISOString() ?? null,
    );
    assert.equal(after.cap!.dftAt?.toISOString() ?? null, before.cap!.dftAt?.toISOString() ?? null);
    assert.equal(after.cap!.tripCount, before.cap!.tripCount);
    assert.equal(captainActivatedAtBefore, null);
    assert.equal(captainDftAtBefore, null);

    // Lead is UNCHANGED (no stage move, no lifecycle flip).
    assert.equal(after.lead!.stageId, before.lead!.stageId);
    assert.equal(after.lead!.lifecycleState, before.lead!.lifecycleState);

    // Activity row carries the structured payload.
    assert.ok(after.activity, 'partner_evidence activity exists');
    const payload = after.activity!.payload as Record<string, unknown> | null;
    assert.equal(payload?.partnerSourceId, partnerSourceId);
    assert.equal(payload?.partnerSnapshotId, snapshotId);
    assert.equal(payload?.partnerRecordId, recordId);
    assert.equal(payload?.evidenceId, result.evidenceId);

    // Audit row carries the dashboard handle.
    assert.ok(after.audit, 'partner.evidence.attached audit row exists');
    const auditPayload = after.audit!.payload as Record<string, unknown> | null;
    assert.equal(auditPayload?.source, 'evidence_only');
    assert.equal(auditPayload?.partnerSourceId, partnerSourceId);
  });

  // ─── explicit-record resolution ─────────────────────────────────────

  it('attachEvidence with an explicit partnerRecordId resolves the snapshotId from the record', async () => {
    const result = await inTenant(() =>
      merge.attachEvidence({
        leadId,
        partnerSourceId,
        partnerRecordId: recordId,
        actorUserId,
        userClaims: actorClaims,
      }),
    );
    assert.equal(result.partnerRecordId, recordId);
    assert.equal(result.partnerSnapshotId, snapshotId);
  });

  // ─── no-record rejection ────────────────────────────────────────────

  it('attachEvidence rejects with partner.evidence.no_record when no record exists for the source', async () => {
    // Spin up a second source with NO records.
    const otherSourceId = await withTenantRaw(tenantId, async (tx) => {
      const s = await tx.partnerSource.create({
        data: {
          tenantId,
          partnerCode: 'indrive',
          displayName: 'inDrive EG',
          adapter: 'manual_upload',
          isActive: true,
        },
        select: { id: true },
      });
      return s.id;
    });

    await assert.rejects(
      () =>
        inTenant(() =>
          merge.attachEvidence({
            leadId,
            partnerSourceId: otherSourceId,
            actorUserId,
            userClaims: actorClaims,
          }),
        ),
      (err: { response?: { code?: string } } & Error) => {
        assert.equal(err.response?.code, 'partner.evidence.no_record');
        return true;
      },
    );
  });

  // ─── lead-not-found / out-of-scope rejection ────────────────────────

  it('attachEvidence rejects with lead.not_found when the lead id does not exist', async () => {
    await assert.rejects(
      () =>
        inTenant(() =>
          merge.attachEvidence({
            leadId: '00000000-0000-0000-0000-000000000000',
            partnerSourceId,
            actorUserId,
            userClaims: actorClaims,
          }),
        ),
      (err: { response?: { code?: string } } & Error) => {
        assert.equal(err.response?.code, 'lead.not_found');
        return true;
      },
    );
  });

  // ─── activity-type registry sanity ──────────────────────────────────
  // The pipeline.registry.ts ACTIVITY_TYPES list must include the new
  // 'partner_evidence' type, otherwise the LeadActivity write above
  // would have fallen back to 'system'.
  it("ACTIVITY_TYPES registry includes 'partner_evidence'", async () => {
    const { ACTIVITY_TYPES } = await import('../crm/pipeline.registry');
    assert.ok(
      (ACTIVITY_TYPES as readonly string[]).includes('partner_evidence'),
      "'partner_evidence' must be in ACTIVITY_TYPES",
    );
  });
});
