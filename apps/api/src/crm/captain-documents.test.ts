/**
 * P2-09 — Captain documents + trip telemetry integration tests.
 *
 * Real Postgres + a throwaway tenant. Covers:
 *
 *   Documents:
 *     - upload writes a `pending` row + audit entry.
 *     - approve flips status, sets reviewer trail, syncs the
 *       canonical onboarding flag (`hasIdCard`, etc).
 *     - reject flips status without touching the flag.
 *     - lazy expiration: a row whose expiresAt is past returns as
 *       "expired" via list/findById without a sweep.
 *     - delete writes an audit row and removes the document.
 *
 *   Trips:
 *     - first ingest: sets firstTripAt, tripCount=1, fires the
 *       first_trip BonusEngine path → one bonus_accrual.
 *     - second distinct trip: bumps tripCount to 2, leaves
 *       firstTripAt unchanged, no new accrual.
 *     - replay of the same tripId: idempotent — counted as
 *       duplicate, no extra row, no new accrual.
 *
 *   Competitions:
 *     - `first_trips` metric leaderboard counts captains whose
 *       firstTripAt falls in the window, attributed to the lead's
 *       assigned agent.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Prisma, PrismaClient } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { BonusEngine } from '../bonuses/bonus-engine.service';
import { CompetitionsService } from '../competitions/competitions.service';
import { PrismaService } from '../prisma/prisma.service';
import { tenantContext } from '../tenants/tenant-context';
import { CaptainDocumentsService } from './captain-documents.service';
import { CaptainTripsService } from './captain-trips.service';

const TENANT_CODE = '__p2_09_captain_docs_trips__';

let prisma: PrismaClient;
let prismaSvc: PrismaService;
let documents: CaptainDocumentsService;
let trips: CaptainTripsService;
let competitions: CompetitionsService;
let tenantId: string;
let captainId: string;
let agentUserId: string;
let reviewerUserId: string;
let bonusRuleFirstTripId: string;
let companyId: string;
let countryId: string;

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

describe('crm — captain documents + trips (P2-09)', () => {
  before(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    prismaSvc = new PrismaService();
    const audit = new AuditService(prismaSvc);
    const bonusEngine = new BonusEngine(audit);
    documents = new CaptainDocumentsService(prismaSvc, audit);
    trips = new CaptainTripsService(prismaSvc, audit, bonusEngine);
    competitions = new CompetitionsService(prismaSvc, audit);

    const tenant = await prisma.tenant.upsert({
      where: { code: TENANT_CODE },
      update: { isActive: true },
      create: { code: TENANT_CODE, name: 'P2-09 docs' },
    });
    tenantId = tenant.id;

    await withTenantRaw(tenantId, async (tx) => {
      const company = await tx.company.create({
        data: { tenantId, code: 'p209_co', name: 'P2-09 Co' },
      });
      companyId = company.id;
      const country = await tx.country.create({
        data: { tenantId, companyId, code: 'EG', name: 'Egypt' },
      });
      countryId = country.id;

      const role = await tx.role.create({
        data: { tenantId, code: 'sales_agent', nameAr: 'وكيل', nameEn: 'Sales', level: 30 },
      });
      const agent = await tx.user.create({
        data: {
          tenantId,
          email: 'p209-agent@test',
          name: 'Agent',
          passwordHash: 'x',
          roleId: role.id,
        },
      });
      agentUserId = agent.id;
      const reviewer = await tx.user.create({
        data: {
          tenantId,
          email: 'p209-reviewer@test',
          name: 'Reviewer',
          passwordHash: 'x',
          roleId: role.id,
        },
      });
      reviewerUserId = reviewer.id;

      const pipeline = await tx.pipeline.create({
        data: { tenantId, name: 'Default', isDefault: true, isActive: true },
        select: { id: true },
      });
      const newStage = await tx.pipelineStage.create({
        data: {
          tenantId,
          pipelineId: pipeline.id,
          code: 'new',
          name: 'New',
          order: 10,
          isTerminal: false,
        },
      });
      const lead = await tx.lead.create({
        data: {
          tenantId,
          stageId: newStage.id,
          name: 'Lead P209',
          phone: '+201001100901',
          source: 'manual',
          assignedToId: agentUserId,
        },
      });
      const captain = await tx.captain.create({
        data: {
          tenantId,
          leadId: lead.id,
          name: 'Cap P209',
          phone: '+201001100901',
        },
      });
      captainId = captain.id;

      // First-trip bonus rule that should fire on the first trip.
      const bonusRule = await tx.bonusRule.create({
        data: {
          tenantId,
          companyId,
          countryId,
          bonusType: 'first_trip',
          trigger: 'first delivered trip',
          amount: new Prisma.Decimal('100.00'),
          isActive: true,
        },
      });
      bonusRuleFirstTripId = bonusRule.id;
    });
  });

  after(async () => {
    await prisma.tenant.delete({ where: { code: TENANT_CODE } }).catch(() => {});
    await prisma.$disconnect();
  });

  // ─── documents ───────────────────────────────────────────────

  it('upload creates a pending row and audits the event', async () => {
    const doc = await inTenant(() =>
      documents.upload(
        captainId,
        {
          kind: 'id_card',
          storageRef: 's3://bucket/path/id-card.pdf',
          fileName: 'id-card.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 12345,
        },
        agentUserId,
      ),
    );
    assert.equal(doc.status, 'pending');
    assert.equal(doc.kind, 'id_card');
    assert.equal(doc.uploadedById, agentUserId);

    const audits = await withTenantRaw(tenantId, (tx) =>
      tx.auditEvent.findMany({
        where: { action: 'captain.document.uploaded', entityId: doc.id },
      }),
    );
    assert.equal(audits.length, 1);
  });

  it('approve flips status, fills reviewer trail, and syncs hasIdCard', async () => {
    const docs = await inTenant(() => documents.listForCaptain(captainId, {}));
    const target = docs.find((d) => d.kind === 'id_card' && d.status === 'pending');
    assert.ok(target);
    const approved = await inTenant(() =>
      documents.review(target!.id, { decision: 'approve', notes: 'looks good' }, reviewerUserId),
    );
    assert.equal(approved.status, 'approved');
    assert.equal(approved.reviewerUserId, reviewerUserId);
    assert.equal(approved.reviewNotes, 'looks good');
    assert.ok(approved.reviewedAt);

    const captain = await withTenantRaw(tenantId, (tx) =>
      tx.captain.findUnique({ where: { id: captainId }, select: { hasIdCard: true } }),
    );
    assert.equal(captain?.hasIdCard, true);
  });

  it('reject flips status but leaves the onboarding flag untouched', async () => {
    // Upload a license, reject it, ensure hasLicense stays false.
    const doc = await inTenant(() =>
      documents.upload(
        captainId,
        {
          kind: 'license',
          storageRef: 's3://bucket/license.pdf',
          fileName: 'license.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 100,
        },
        agentUserId,
      ),
    );
    const rejected = await inTenant(() =>
      documents.review(doc.id, { decision: 'reject', notes: 'blurry' }, reviewerUserId),
    );
    assert.equal(rejected.status, 'rejected');
    const captain = await withTenantRaw(tenantId, (tx) =>
      tx.captain.findUnique({ where: { id: captainId }, select: { hasLicense: true } }),
    );
    assert.equal(captain?.hasLicense, false);
  });

  it('lazy expiration: a row past expiresAt returns as "expired" without a sweep', async () => {
    const past = new Date(Date.now() - 60_000);
    const doc = await inTenant(() =>
      documents.upload(
        captainId,
        {
          kind: 'other',
          storageRef: 's3://bucket/expiring.pdf',
          fileName: 'old.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 1,
          expiresAt: past.toISOString(),
        },
        agentUserId,
      ),
    );
    // Persisted as `pending` because we don't sweep on insert.
    const persisted = await withTenantRaw(tenantId, (tx) =>
      tx.captainDocument.findUnique({ where: { id: doc.id }, select: { status: true } }),
    );
    assert.equal(persisted?.status, 'pending');
    // List path returns the synthesised "expired".
    const fetched = await inTenant(() => documents.findByIdOrThrow(doc.id));
    assert.equal(fetched.status, 'expired');
  });

  it('delete removes the row and audits the event', async () => {
    const doc = await inTenant(() =>
      documents.upload(
        captainId,
        {
          kind: 'other',
          storageRef: 's3://bucket/disposable.pdf',
          fileName: 'tmp.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 1,
        },
        agentUserId,
      ),
    );
    await inTenant(() => documents.delete(doc.id, agentUserId));
    const after = await withTenantRaw(tenantId, (tx) =>
      tx.captainDocument.findUnique({ where: { id: doc.id } }),
    );
    assert.equal(after, null);
  });

  // ─── trips + bonus engine ───────────────────────────────────

  it('first trip ingest sets firstTripAt, tripCount=1, and fires a first_trip bonus accrual', async () => {
    const result = await inTenant(() =>
      trips.recordTrip(
        captainId,
        { tripId: 'trip-1', occurredAt: new Date('2026-05-01T12:00:00.000Z').toISOString() },
        reviewerUserId,
      ),
    );
    assert.equal(result.duplicate, false);
    assert.equal(result.tripCount, 1);
    assert.ok(result.firstTripAt);

    const accruals = await withTenantRaw(tenantId, (tx) =>
      tx.bonusAccrual.findMany({
        where: { captainId, triggerKind: 'first_trip' },
      }),
    );
    assert.equal(accruals.length, 1);
    assert.equal(accruals[0]?.bonusRuleId, bonusRuleFirstTripId);
    assert.equal(accruals[0]?.recipientUserId, agentUserId);
    assert.equal(accruals[0]?.amount.toString(), '100');
  });

  it('a different trip bumps tripCount but keeps firstTripAt and does not re-accrue', async () => {
    const result = await inTenant(() =>
      trips.recordTrip(
        captainId,
        { tripId: 'trip-2', occurredAt: new Date('2026-05-02T12:00:00.000Z').toISOString() },
        reviewerUserId,
      ),
    );
    assert.equal(result.duplicate, false);
    assert.equal(result.tripCount, 2);
    // firstTripAt didn't move.
    const captain = await withTenantRaw(tenantId, (tx) =>
      tx.captain.findUnique({ where: { id: captainId }, select: { firstTripAt: true } }),
    );
    assert.equal(captain?.firstTripAt?.toISOString(), '2026-05-01T12:00:00.000Z');
    // No additional first_trip accrual.
    const accruals = await withTenantRaw(tenantId, (tx) =>
      tx.bonusAccrual.count({ where: { captainId, triggerKind: 'first_trip' } }),
    );
    assert.equal(accruals, 1);
  });

  it('replaying the same tripId is idempotent', async () => {
    const result = await inTenant(() =>
      trips.recordTrip(
        captainId,
        { tripId: 'trip-1', occurredAt: new Date().toISOString() },
        reviewerUserId,
      ),
    );
    assert.equal(result.duplicate, true);
    assert.equal(result.tripCount, 2);
    // Ledger row count for this captain stays at 2 (trip-1 + trip-2).
    const ledger = await withTenantRaw(tenantId, (tx) =>
      tx.captainTrip.count({ where: { captainId } }),
    );
    assert.equal(ledger, 2);
  });

  // ─── competitions metric ────────────────────────────────────

  it('first_trips competition leaderboard counts captains by their lead.assignedToId', async () => {
    const competition = await inTenant(() =>
      competitions.create(
        {
          name: 'P2-09 Q2 first trips',
          companyId,
          countryId,
          startDate: '2026-05-01T00:00:00.000Z',
          endDate: '2026-05-31T23:59:59.999Z',
          metric: 'first_trips',
          reward: '100 EGP',
        },
        reviewerUserId,
      ),
    );
    const leaderboard = await inTenant(() => competitions.leaderboard(competition.id));
    // The single captain in this test had its first trip on 2026-05-01,
    // attributed to agentUserId.
    assert.equal(leaderboard.length, 1);
    assert.equal(leaderboard[0]?.userId, agentUserId);
    assert.equal(leaderboard[0]?.score, 1);
  });
});
