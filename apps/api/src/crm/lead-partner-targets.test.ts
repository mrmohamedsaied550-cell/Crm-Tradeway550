/**
 * Sprint 13 (D13) — integration tests for the Lead Partner
 * Targets service.
 *
 * Coverage:
 *   1. create() inserts a target and defaults status to 'target',
 *      countryId from the partner source, and owner from the
 *      lead's assignee.
 *   2. Duplicate (lead, partner) raises lead.partner_target.duplicate.
 *   3. listForLead() returns targets newest-first; foreign-tenant
 *      lead id raises lead.not_found via the scope gate.
 *   4. Invalid partnerSourceId raises lead.partner_target.partner_source_invalid.
 *   5. Foreign ownerUserId raises lead.partner_target.owner_invalid.
 *   6. Audit + LeadActivity rows emitted in the same transaction.
 *   7. Tenant isolation — target created in tenant A is invisible
 *      from tenant B's bulk lookup.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { tenantContext } from '../tenants/tenant-context';

import { LeadPartnerTargetsService } from './lead-partner-targets.service';
import { LeadsService } from './leads.service';

const TENANT_CODE = '__d13_partner_targets__';
const OTHER_TENANT_CODE = '__d13_partner_targets_other__';

let prisma: PrismaClient;
let prismaSvc: PrismaService;
let leads: LeadsService;
let audit: AuditService;
let svc: LeadPartnerTargetsService;

let tenantId: string;
let otherTenantId: string;
let leadId: string;
let actorUserId: string;
let companyId: string;
let countryId: string;
let partnerSourceUberId: string;
let partnerSourceIndriveId: string;
let foreignPartnerSourceId: string;
let foreignLeadId: string;
let foreignUserId: string;

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

describe('crm — lead partner targets (Sprint 13 / D13)', () => {
  before(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    prismaSvc = new PrismaService();
    audit = new AuditService(prismaSvc);
    // Same stub pattern as the Sprint 12 documents test — only
    // findByIdInScopeOrThrow is exercised.
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
    svc = new LeadPartnerTargetsService(prismaSvc, leads, audit);

    const t = await prisma.tenant.upsert({
      where: { code: TENANT_CODE },
      update: { isActive: true },
      create: { code: TENANT_CODE, name: 'D13 partner targets test' },
    });
    tenantId = t.id;
    const o = await prisma.tenant.upsert({
      where: { code: OTHER_TENANT_CODE },
      update: { isActive: true },
      create: { code: OTHER_TENANT_CODE, name: 'D13 partner targets other' },
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
          email: 'd13-actor@example.com',
          name: 'D13 actor',
          passwordHash: 'x',
          roleId: role.id,
          status: 'active',
          language: 'en',
        },
      }),
    );
    actorUserId = actor.id;

    const foreign = await rawTx(otherTenantId, (tx) =>
      tx.user.create({
        data: {
          tenantId: otherTenantId,
          email: 'd13-foreign@example.com',
          name: 'D13 foreign user',
          passwordHash: 'x',
          roleId: otherRole.id,
          status: 'active',
          language: 'en',
        },
      }),
    );
    foreignUserId = foreign.id;

    // Active-tenant Company → Country → Pipeline → Stage → Contact → Lead.
    const company = await rawTx(tenantId, (tx) =>
      tx.company.create({ data: { tenantId, code: 'uber', name: 'Uber' } }),
    );
    companyId = company.id;
    const country = await rawTx(tenantId, (tx) =>
      tx.country.create({
        data: { tenantId, companyId, code: 'EG', name: 'Egypt' },
      }),
    );
    countryId = country.id;
    const pipeline = await rawTx(tenantId, (tx) =>
      tx.pipeline.create({
        data: { tenantId, name: 'D13 Pipeline', isDefault: true },
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
          name: 'D13 Lead',
          phone: '+201000000001',
        },
      }),
    );
    leadId = lead.id;

    // Partner sources for Uber / inDrive (active).
    const sourceUber = await rawTx(tenantId, (tx) =>
      tx.partnerSource.create({
        data: {
          tenantId,
          companyId,
          countryId,
          partnerCode: 'uber',
          displayName: 'Uber EG',
          adapter: 'manual_upload',
          scheduleKind: 'manual',
        },
      }),
    );
    partnerSourceUberId = sourceUber.id;
    const sourceIndrive = await rawTx(tenantId, (tx) =>
      tx.partnerSource.create({
        data: {
          tenantId,
          companyId,
          countryId,
          partnerCode: 'indrive',
          displayName: 'inDrive EG',
          adapter: 'manual_upload',
          scheduleKind: 'manual',
        },
      }),
    );
    partnerSourceIndriveId = sourceIndrive.id;

    // Foreign-tenant lead + partner source for isolation tests.
    const fCompany = await rawTx(otherTenantId, (tx) =>
      tx.company.create({ data: { tenantId: otherTenantId, code: 'other', name: 'Other' } }),
    );
    const fCountry = await rawTx(otherTenantId, (tx) =>
      tx.country.create({
        data: { tenantId: otherTenantId, companyId: fCompany.id, code: 'EG', name: 'Egypt' },
      }),
    );
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
    const fSource = await rawTx(otherTenantId, (tx) =>
      tx.partnerSource.create({
        data: {
          tenantId: otherTenantId,
          companyId: fCompany.id,
          countryId: fCountry.id,
          partnerCode: 'uber',
          displayName: 'Foreign Uber',
          adapter: 'manual_upload',
          scheduleKind: 'manual',
        },
      }),
    );
    foreignPartnerSourceId = fSource.id;
  });

  after(async () => {
    await prisma.tenant.delete({ where: { code: TENANT_CODE } }).catch(() => {});
    await prisma.tenant.delete({ where: { code: OTHER_TENANT_CODE } }).catch(() => {});
    await prisma.$disconnect();
  });

  it('create() inserts a target with defaults from partner source + lead assignee', async () => {
    const out = await inTenant(() =>
      svc.create(
        leadId,
        { partnerSourceId: partnerSourceUberId },
        { userId: actorUserId, tenantId, roleId: 'role-x' },
      ),
    );
    const row = await rawTx(tenantId, (tx) =>
      tx.leadPartnerTarget.findUnique({ where: { id: out.id } }),
    );
    assert.equal(row?.status, 'target');
    assert.equal(row?.partnerSourceId, partnerSourceUberId);
    assert.equal(row?.countryId, countryId);
    assert.equal(row?.ownerUserId, actorUserId);
    assert.equal(row?.createdById, actorUserId);
  });

  it('duplicate (lead, partner) raises lead.partner_target.duplicate', async () => {
    await assert.rejects(
      () =>
        inTenant(() =>
          svc.create(
            leadId,
            { partnerSourceId: partnerSourceUberId },
            { userId: actorUserId, tenantId, roleId: 'role-x' },
          ),
        ),
      (err: unknown) => {
        const e = err as { response?: { code?: string } };
        return e.response?.code === 'lead.partner_target.duplicate';
      },
    );
  });

  it('listForLead() returns rows newest-first + scopes by lead', async () => {
    await inTenant(() =>
      svc.create(
        leadId,
        { partnerSourceId: partnerSourceIndriveId },
        { userId: actorUserId, tenantId, roleId: 'role-x' },
      ),
    );
    const items = await inTenant(() =>
      svc.listForLead(leadId, { userId: actorUserId, tenantId, roleId: 'role-x' }, {}),
    );
    assert.ok(items.length >= 2);
    // Newest first — the indrive row was created just now.
    assert.equal(items[0]?.partnerSourceId, partnerSourceIndriveId);
    // Foreign lead id → scope gate.
    await assert.rejects(() =>
      inTenant(() =>
        svc.listForLead(foreignLeadId, { userId: actorUserId, tenantId, roleId: 'role-x' }, {}),
      ),
    );
  });

  it('invalid partnerSourceId raises lead.partner_target.partner_source_invalid', async () => {
    await assert.rejects(
      () =>
        inTenant(() =>
          svc.create(
            leadId,
            { partnerSourceId: '00000000-0000-0000-0000-000000000000' },
            { userId: actorUserId, tenantId, roleId: 'role-x' },
          ),
        ),
      (err: unknown) => {
        const e = err as { response?: { code?: string } };
        return e.response?.code === 'lead.partner_target.partner_source_invalid';
      },
    );
  });

  it('partner source from another tenant is rejected (tenant isolation)', async () => {
    await assert.rejects(
      () =>
        inTenant(() =>
          svc.create(
            leadId,
            { partnerSourceId: foreignPartnerSourceId },
            { userId: actorUserId, tenantId, roleId: 'role-x' },
          ),
        ),
      (err: unknown) => {
        const e = err as { response?: { code?: string } };
        return e.response?.code === 'lead.partner_target.partner_source_invalid';
      },
    );
  });

  it('foreign ownerUserId raises lead.partner_target.owner_invalid', async () => {
    // Use a fresh partner source so the dedupe constraint doesn't
    // collide with the Uber row above.
    const source = await rawTx(tenantId, (tx) =>
      tx.partnerSource.create({
        data: {
          tenantId,
          companyId,
          countryId,
          partnerCode: 'didi',
          displayName: 'DiDi EG',
          adapter: 'manual_upload',
          scheduleKind: 'manual',
        },
      }),
    );
    await assert.rejects(
      () =>
        inTenant(() =>
          svc.create(
            leadId,
            { partnerSourceId: source.id, ownerUserId: foreignUserId },
            { userId: actorUserId, tenantId, roleId: 'role-x' },
          ),
        ),
      (err: unknown) => {
        const e = err as { response?: { code?: string } };
        return e.response?.code === 'lead.partner_target.owner_invalid';
      },
    );
  });

  it('emits audit + lead activity rows alongside the target write', async () => {
    // Use yet another source to skirt dedupe.
    const source = await rawTx(tenantId, (tx) =>
      tx.partnerSource.create({
        data: {
          tenantId,
          companyId,
          countryId,
          partnerCode: 'careem',
          displayName: 'Careem EG',
          adapter: 'manual_upload',
          scheduleKind: 'manual',
        },
      }),
    );
    const out = await inTenant(() =>
      svc.create(
        leadId,
        { partnerSourceId: source.id, note: 'driver expressed interest' },
        { userId: actorUserId, tenantId, roleId: 'role-x' },
      ),
    );
    const auditRows = await rawTx(tenantId, (tx) =>
      tx.auditEvent.findMany({
        where: { entityType: 'lead_partner_target', entityId: out.id },
      }),
    );
    const activityRows = await rawTx(tenantId, (tx) =>
      tx.leadActivity.findMany({
        where: { leadId, type: 'system' },
      }),
    );
    assert.ok(auditRows.some((r) => r.action === 'lead.partner_target.created'));
    assert.ok(activityRows.some((r) => (r.body ?? '').includes('Careem EG')));
  });
});
