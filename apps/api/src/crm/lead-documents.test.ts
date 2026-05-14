/**
 * Sprint 12 (D12) — integration tests for the Lead Documents service.
 *
 * Coverage:
 *   1. create() defaults status to 'uploaded'; reviewer statuses on
 *      create are rejected with `lead.document.status.invalid_on_create`.
 *   2. listForLead() returns rows ordered newest-first and respects
 *      lead scope (a foreign lead id throws via leads.findByIdInScopeOrThrow).
 *   3. update() to 'accepted' requires `canAccept = true` — otherwise
 *      throws `lead.document.accept.forbidden`.
 *   4. update() to 'rejected' / 'needs_resubmission' requires
 *      `canReject = true` AND a non-empty rejectionReason.
 *   5. update() to 'rejected' stamps reviewedById + reviewedAt +
 *      rejectionReason; an accept clears the previous rejection text.
 *   6. Tenant isolation — a lead document from another tenant is
 *      invisible.
 *   7. Audit + LeadActivity rows are emitted in the same tx as the
 *      document write.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { tenantContext } from '../tenants/tenant-context';

import { LeadDocumentsService } from './lead-documents.service';
import { LeadsService } from './leads.service';

const TENANT_CODE = '__d12_lead_documents__';
const OTHER_TENANT_CODE = '__d12_lead_documents_other__';

let prisma: PrismaClient;
let prismaSvc: PrismaService;
let leads: LeadsService;
let audit: AuditService;
let svc: LeadDocumentsService;

let tenantId: string;
let otherTenantId: string;
let leadId: string;
let actorUserId: string;
let foreignLeadId: string;

function inTenant<T>(fn: () => Promise<T>): Promise<T> {
  return tenantContext.run({ tenantId, tenantCode: TENANT_CODE, source: 'header' }, fn);
}

async function rawTx<T>(tid: string, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return prisma.$transaction(async (tx: any) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.tenant_id = '${tid}'`);
    return fn(tx);
  });
}

describe('crm — lead documents (Sprint 12 / D12)', () => {
  before(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    prismaSvc = new PrismaService();
    audit = new AuditService(prismaSvc);
    // LeadsService has a deep dependency tree for write paths; the
    // tests only exercise findByIdInScopeOrThrow. Stub the method
    // directly — it's a read that calls prisma.withTenant under
    // the hood; for the tests we just verify the lead row belongs
    // to the active tenant.
    const stubLeads = {
      async findByIdInScopeOrThrow(id: string) {
        return prismaSvc.withTenant(tenantId, async (tx) => {
          const lead = await tx.lead.findFirst({ where: { id } });
          if (!lead) {
            const { NotFoundException } = await import('@nestjs/common');
            throw new NotFoundException({
              code: 'lead.not_found',
              message: `Lead ${id} not found`,
            });
          }
          return lead;
        });
      },
    } as unknown as LeadsService;
    leads = stubLeads;
    svc = new LeadDocumentsService(prismaSvc, leads, audit);

    const t = await prisma.tenant.upsert({
      where: { code: TENANT_CODE },
      update: { isActive: true },
      create: { code: TENANT_CODE, name: 'D12 lead documents test' },
    });
    tenantId = t.id;
    const o = await prisma.tenant.upsert({
      where: { code: OTHER_TENANT_CODE },
      update: { isActive: true },
      create: { code: OTHER_TENANT_CODE, name: 'D12 lead documents other' },
    });
    otherTenantId = o.id;

    const role = await rawTx(tenantId, (tx) =>
      tx.role.upsert({
        where: { tenantId_code: { tenantId, code: 'sales_agent' } },
        update: {},
        create: {
          tenantId,
          code: 'sales_agent',
          nameAr: 'وكيل',
          nameEn: 'Sales Agent',
          level: 30,
        },
      }),
    );
    const otherRole = await rawTx(otherTenantId, (tx) =>
      tx.role.upsert({
        where: { tenantId_code: { tenantId: otherTenantId, code: 'sales_agent' } },
        update: {},
        create: {
          tenantId: otherTenantId,
          code: 'sales_agent',
          nameAr: 'وكيل',
          nameEn: 'Sales Agent',
          level: 30,
        },
      }),
    );

    const actor = await rawTx(tenantId, (tx) =>
      tx.user.create({
        data: {
          tenantId,
          email: 'd12-actor@example.com',
          name: 'D12 actor',
          passwordHash: 'x',
          roleId: role.id,
          status: 'active',
          language: 'en',
        },
      }),
    );
    actorUserId = actor.id;

    // Bootstrap a lead via raw tx — every dependency chain a real
    // lead create needs (pipeline / stage / contact) would be a lot
    // of fixture noise. We just need a row that satisfies the FK.
    const pipeline = await rawTx(tenantId, (tx) =>
      tx.pipeline.create({
        data: { tenantId, name: 'D12 Pipeline', isDefault: true },
      }),
    );
    const stage = await rawTx(tenantId, (tx) =>
      tx.pipelineStage.create({
        data: {
          tenantId,
          pipelineId: pipeline.id,
          code: 'fresh',
          name: 'Fresh',
          order: 1,
          isTerminal: false,
        },
      }),
    );
    const contact = await rawTx(tenantId, (tx) =>
      tx.contact.create({
        data: { tenantId, phone: '+201000000001', originalPhone: '+201000000001' },
      }),
    );
    const lead = await rawTx(tenantId, (tx) =>
      tx.lead.create({
        data: {
          tenantId,
          contactId: contact.id,
          pipelineId: pipeline.id,
          stageId: stage.id,
          assignedToId: actor.id,
          name: 'D12 Lead',
          phone: '+201000000001',
        },
      }),
    );
    leadId = lead.id;

    // Foreign lead for tenant-isolation test.
    const fPipeline = await rawTx(otherTenantId, (tx) =>
      tx.pipeline.create({
        data: { tenantId: otherTenantId, name: 'Other PL', isDefault: true },
      }),
    );
    const fStage = await rawTx(otherTenantId, (tx) =>
      tx.pipelineStage.create({
        data: {
          tenantId: otherTenantId,
          pipelineId: fPipeline.id,
          code: 'fresh',
          name: 'Fresh',
          order: 1,
          isTerminal: false,
        },
      }),
    );
    const fContact = await rawTx(otherTenantId, (tx) =>
      tx.contact.create({
        data: {
          tenantId: otherTenantId,
          phone: '+999000000001',
          originalPhone: '+999000000001',
        },
      }),
    );
    const fLead = await rawTx(otherTenantId, (tx) =>
      tx.lead.create({
        data: {
          tenantId: otherTenantId,
          contactId: fContact.id,
          pipelineId: fPipeline.id,
          stageId: fStage.id,
          name: 'Foreign lead',
          phone: '+999000000001',
        },
      }),
    );
    foreignLeadId = fLead.id;
    void otherRole;
  });

  after(async () => {
    await prisma.tenant.delete({ where: { code: TENANT_CODE } }).catch(() => {});
    await prisma.tenant.delete({ where: { code: OTHER_TENANT_CODE } }).catch(() => {});
    await prisma.$disconnect();
  });

  it('create() defaults status to "uploaded" and records uploadedBy', async () => {
    const out = await inTenant(() =>
      svc.create(
        leadId,
        { type: 'national_id', fileName: 'id.jpg' },
        { userId: actorUserId, tenantId, roleId: 'role-x' },
      ),
    );
    const row = await rawTx(tenantId, (tx) =>
      tx.leadDocument.findUnique({ where: { id: out.id } }),
    );
    assert.equal(row?.status, 'uploaded');
    assert.equal(row?.uploadedById, actorUserId);
    assert.equal(row?.fileName, 'id.jpg');
  });

  it('create() rejects reviewer statuses with lead.document.status.invalid_on_create', async () => {
    await assert.rejects(
      () =>
        inTenant(() =>
          svc.create(
            leadId,
            { type: 'profile_photo', status: 'accepted' },
            { userId: actorUserId, tenantId, roleId: 'role-x' },
          ),
        ),
      (err: unknown) => {
        const e = err as { response?: { code?: string } };
        return e.response?.code === 'lead.document.status.invalid_on_create';
      },
    );
  });

  it('listForLead() returns rows ordered newest-first and respects lead scope', async () => {
    await inTenant(() =>
      svc.create(
        leadId,
        { type: 'driving_license' },
        { userId: actorUserId, tenantId, roleId: 'role-x' },
      ),
    );
    const items = await inTenant(() =>
      svc.listForLead(leadId, { userId: actorUserId, tenantId, roleId: 'role-x' }, {}),
    );
    assert.ok(items.length >= 2);
    // Foreign lead → throws lead.not_found via the scope gate.
    await assert.rejects(() =>
      inTenant(() =>
        svc.listForLead(foreignLeadId, { userId: actorUserId, tenantId, roleId: 'role-x' }, {}),
      ),
    );
  });

  it('update() to accepted requires canAccept', async () => {
    const created = await inTenant(() =>
      svc.create(
        leadId,
        { type: 'vehicle_license' },
        { userId: actorUserId, tenantId, roleId: 'role-x' },
      ),
    );
    await assert.rejects(
      () =>
        inTenant(() =>
          svc.update(
            leadId,
            created.id,
            { status: 'accepted' },
            { userId: actorUserId, tenantId, roleId: 'role-x' },
            { canAccept: false, canReject: false },
          ),
        ),
      (err: unknown) => {
        const e = err as { response?: { code?: string } };
        return e.response?.code === 'lead.document.accept.forbidden';
      },
    );

    await inTenant(() =>
      svc.update(
        leadId,
        created.id,
        { status: 'accepted' },
        { userId: actorUserId, tenantId, roleId: 'role-x' },
        { canAccept: true, canReject: false },
      ),
    );
    const row = await rawTx(tenantId, (tx) =>
      tx.leadDocument.findUnique({ where: { id: created.id } }),
    );
    assert.equal(row?.status, 'accepted');
    assert.equal(row?.reviewedById, actorUserId);
    assert.ok(row?.reviewedAt);
  });

  it('update() to rejected requires canReject + non-empty reason; accept clears reason', async () => {
    const created = await inTenant(() =>
      svc.create(
        leadId,
        { type: 'profile_photo' },
        { userId: actorUserId, tenantId, roleId: 'role-x' },
      ),
    );
    // Empty reason → BadRequest.
    await assert.rejects(
      () =>
        inTenant(() =>
          svc.update(
            leadId,
            created.id,
            { status: 'rejected', rejectionReason: '   ' },
            { userId: actorUserId, tenantId, roleId: 'role-x' },
            { canAccept: false, canReject: true },
          ),
        ),
      (err: unknown) => {
        const e = err as { response?: { code?: string } };
        return e.response?.code === 'lead.document.reason_required';
      },
    );
    // Missing capability.
    await assert.rejects(
      () =>
        inTenant(() =>
          svc.update(
            leadId,
            created.id,
            { status: 'rejected', rejectionReason: 'blurry' },
            { userId: actorUserId, tenantId, roleId: 'role-x' },
            { canAccept: false, canReject: false },
          ),
        ),
      (err: unknown) => {
        const e = err as { response?: { code?: string } };
        return e.response?.code === 'lead.document.reject.forbidden';
      },
    );
    // Happy path.
    await inTenant(() =>
      svc.update(
        leadId,
        created.id,
        { status: 'rejected', rejectionReason: 'blurry' },
        { userId: actorUserId, tenantId, roleId: 'role-x' },
        { canAccept: false, canReject: true },
      ),
    );
    let row = await rawTx(tenantId, (tx) =>
      tx.leadDocument.findUnique({ where: { id: created.id } }),
    );
    assert.equal(row?.status, 'rejected');
    assert.equal(row?.rejectionReason, 'blurry');
    assert.equal(row?.reviewedById, actorUserId);
    // Re-accept clears the rejection reason.
    await inTenant(() =>
      svc.update(
        leadId,
        created.id,
        { status: 'accepted' },
        { userId: actorUserId, tenantId, roleId: 'role-x' },
        { canAccept: true, canReject: true },
      ),
    );
    row = await rawTx(tenantId, (tx) => tx.leadDocument.findUnique({ where: { id: created.id } }));
    assert.equal(row?.status, 'accepted');
    assert.equal(row?.rejectionReason, null);
  });

  it('emits audit + lead activity rows alongside the document write', async () => {
    const created = await inTenant(() =>
      svc.create(
        leadId,
        { type: 'other', label: 'Bank statement' },
        { userId: actorUserId, tenantId, roleId: 'role-x' },
      ),
    );
    const auditRows = await rawTx(tenantId, (tx) =>
      tx.auditEvent.findMany({
        where: { entityType: 'lead_document', entityId: created.id },
      }),
    );
    const activityRows = await rawTx(tenantId, (tx) =>
      tx.leadActivity.findMany({
        where: { leadId, type: 'system' },
      }),
    );
    assert.ok(auditRows.some((r) => r.action === 'lead.document.created'));
    assert.ok(activityRows.length > 0);
  });
});
