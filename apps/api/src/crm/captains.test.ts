/**
 * C18 — captain entity tests.
 *
 * Same harness as leads.test.ts: manual service wiring, explicit
 * AsyncLocalStorage tenant scope, throwaway tenants for isolation.
 *
 * Coverage:
 *   - convertFromLead copies name + phone from the lead.
 *   - Default status is 'active'.
 *   - Optional teamId is stored when valid.
 *   - teamId from another tenant is rejected (team.not_in_tenant).
 *   - Double-conversion still blocked (regression check).
 *   - list() returns a tenant-scoped paginated result.
 *   - findByIdOrThrow throws 404 for cross-tenant ids.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { tenantContext } from '../tenants/tenant-context';
import { TenantSettingsService } from '../tenants/tenant-settings.service';
import { hashPassword } from '../identity/password.util';
import { AssignmentService } from './assignment.service';
import { CaptainsService } from './captains.service';
import { LeadsService } from './leads.service';
import { PipelineService } from './pipeline.service';
import { SlaService } from './sla.service';
import { PIPELINE_STAGE_DEFINITIONS } from './pipeline.registry';

const TEST_TENANT_CODE = '__c18_captains__';
const OTHER_TENANT_CODE = '__c18_captains_other__';

let prisma: PrismaClient;
let prismaSvc: PrismaService;
let leads: LeadsService;
let captains: CaptainsService;
let tenantId: string;
let otherTenantId: string;
let actorUserId: string;
let salesAgentRoleId: string;
let teamAId: string;
let otherTeamId: string;

function inTenant<T>(fn: () => Promise<T>): Promise<T> {
  return tenantContext.run({ tenantId, tenantCode: TEST_TENANT_CODE, source: 'header' }, fn);
}

function inOtherTenant<T>(fn: () => Promise<T>): Promise<T> {
  return tenantContext.run(
    { tenantId: otherTenantId, tenantCode: OTHER_TENANT_CODE, source: 'header' },
    fn,
  );
}

async function withTenantRaw<T>(tid: string, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return prisma.$transaction(async (tx: any) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.tenant_id = '${tid}'`);
    return fn(tx);
  });
}

async function seedPipeline(tid: string): Promise<void> {
  await withTenantRaw(tid, async (tx) => {
    const existing = await tx.pipeline.findFirst({
      where: { tenantId: tid, isDefault: true },
      select: { id: true },
    });
    const pipelineId =
      existing?.id ??
      (
        await tx.pipeline.create({
          data: { tenantId: tid, name: 'Default', isDefault: true, isActive: true },
          select: { id: true },
        })
      ).id;
    for (const def of PIPELINE_STAGE_DEFINITIONS) {
      await tx.pipelineStage.upsert({
        where: { pipelineId_code: { pipelineId, code: def.code } },
        update: { name: def.name, order: def.order, isTerminal: def.isTerminal },
        create: {
          tenantId: tid,
          pipelineId,
          code: def.code,
          name: def.name,
          order: def.order,
          isTerminal: def.isTerminal,
        },
      });
    }
  });
}

describe('crm — captain conversion + reads (C18)', () => {
  before(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    prismaSvc = new PrismaService();
    const pipeline = new PipelineService(prismaSvc);
    const assignment = new AssignmentService(prismaSvc);
    const audit = new AuditService(prismaSvc);
    const tenantSettings = new TenantSettingsService(prismaSvc, audit);
    const sla = new SlaService(prismaSvc, assignment, undefined, tenantSettings);
    leads = new LeadsService(prismaSvc, pipeline, assignment, sla, tenantSettings);
    captains = new CaptainsService(prismaSvc, pipeline, leads);

    const tenant = await prisma.tenant.upsert({
      where: { code: TEST_TENANT_CODE },
      update: { isActive: true },
      create: { code: TEST_TENANT_CODE, name: 'C18 captains test' },
    });
    tenantId = tenant.id;

    const other = await prisma.tenant.upsert({
      where: { code: OTHER_TENANT_CODE },
      update: { isActive: true },
      create: { code: OTHER_TENANT_CODE, name: 'C18 captains other tenant' },
    });
    otherTenantId = other.id;

    await seedPipeline(tenantId);
    await seedPipeline(otherTenantId);

    const hash = await hashPassword('Password@123', 4);

    const role = await withTenantRaw(tenantId, (tx) =>
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
    salesAgentRoleId = role.id;

    const actor = await withTenantRaw(tenantId, (tx) =>
      tx.user.upsert({
        where: { tenantId_email: { tenantId, email: '__c18_actor@test' } },
        update: {},
        create: {
          tenantId,
          email: '__c18_actor@test',
          name: 'Actor',
          passwordHash: hash,
          roleId: salesAgentRoleId,
        },
      }),
    );
    actorUserId = actor.id;

    // Provision a Company → Country → Team in the active tenant so the
    // teamId-on-convert path has something to assign.
    const company = await withTenantRaw(tenantId, (tx) =>
      tx.company.create({ data: { tenantId, code: 'uber', name: 'Uber' } }),
    );
    const country = await withTenantRaw(tenantId, (tx) =>
      tx.country.create({
        data: { tenantId, companyId: company.id, code: 'EG', name: 'Egypt' },
      }),
    );
    const teamA = await withTenantRaw(tenantId, (tx) =>
      tx.team.create({
        data: { tenantId, countryId: country.id, name: 'Activation' },
      }),
    );
    teamAId = teamA.id;

    // Plant a team in the OTHER tenant so cross-tenant rejection has a
    // valid foreign id to point at.
    const otherCompany = await withTenantRaw(otherTenantId, (tx) =>
      tx.company.create({ data: { tenantId: otherTenantId, code: 'uber', name: 'Uber' } }),
    );
    const otherCountry = await withTenantRaw(otherTenantId, (tx) =>
      tx.country.create({
        data: { tenantId: otherTenantId, companyId: otherCompany.id, code: 'EG', name: 'Egypt' },
      }),
    );
    const otherTeam = await withTenantRaw(otherTenantId, (tx) =>
      tx.team.create({
        data: { tenantId: otherTenantId, countryId: otherCountry.id, name: 'Activation' },
      }),
    );
    otherTeamId = otherTeam.id;
  });

  after(async () => {
    await prisma.tenant.delete({ where: { code: TEST_TENANT_CODE } }).catch(() => {});
    await prisma.tenant.delete({ where: { code: OTHER_TENANT_CODE } }).catch(() => {});
    await prisma.$disconnect();
  });

  it('convertFromLead copies name + phone from the lead and defaults status=active', async () => {
    const lead = await inTenant(() =>
      leads.create({ name: 'Captain A', phone: '+201111100001', source: 'manual' }, actorUserId),
    );
    const captain = await inTenant(() => captains.convertFromLead(lead.id, {}, actorUserId));
    assert.equal(captain.leadId, lead.id);
    assert.equal(captain.name, 'Captain A');
    assert.equal(captain.phone, '+201111100001');
    assert.equal(captain.status, 'active');
    assert.equal(captain.teamId, null);
    assert.equal(captain.onboardingStatus, 'in_progress');
  });

  it('convertFromLead with teamId stores the team', async () => {
    const lead = await inTenant(() =>
      leads.create({ name: 'Captain B', phone: '+201111100002', source: 'manual' }, actorUserId),
    );
    const captain = await inTenant(() =>
      captains.convertFromLead(lead.id, { teamId: teamAId, hasIdCard: true }, actorUserId),
    );
    assert.equal(captain.teamId, teamAId);
    assert.equal(captain.hasIdCard, true);
  });

  it('convertFromLead rejects a teamId from another tenant', async () => {
    const lead = await inTenant(() =>
      leads.create({ name: 'Captain C', phone: '+201111100003', source: 'manual' }, actorUserId),
    );
    await assert.rejects(
      () => inTenant(() => captains.convertFromLead(lead.id, { teamId: otherTeamId }, actorUserId)),
      /not defined in the active tenant/,
    );
    // Sanity: the conversion did NOT half-commit a captain row.
    const reread = await inTenant(() => leads.findByIdOrThrow(lead.id));
    assert.equal(reread.captain, null);
  });

  it('rejects double conversion with captain.already_exists', async () => {
    const lead = await inTenant(() =>
      leads.create({ name: 'Captain D', phone: '+201111100004', source: 'manual' }, actorUserId),
    );
    await inTenant(() => captains.convertFromLead(lead.id, {}, actorUserId));
    await assert.rejects(
      () => inTenant(() => captains.convertFromLead(lead.id, {}, actorUserId)),
      /already been converted/,
    );
  });

  it('list() returns a paginated tenant-scoped result; status default applies to every row', async () => {
    const page = await inTenant(() => captains.list({ limit: 50, offset: 0 }));
    assert.ok(page.items.length >= 3, `expected at least 3 captains, got ${page.items.length}`);
    assert.equal(typeof page.total, 'number');
    assert.equal(page.limit, 50);
    assert.equal(page.offset, 0);
    for (const c of page.items) {
      assert.equal(c.tenantId, tenantId);
      assert.equal(c.status, 'active');
    }
  });

  it('list() filters by status + teamId + q', async () => {
    const byTeam = await inTenant(() => captains.list({ teamId: teamAId, limit: 50, offset: 0 }));
    assert.ok(byTeam.items.every((c) => c.teamId === teamAId));

    const byStatus = await inTenant(() =>
      captains.list({ status: 'archived', limit: 50, offset: 0 }),
    );
    assert.equal(byStatus.items.length, 0, 'no archived captains in this tenant');

    const byQ = await inTenant(() => captains.list({ q: 'Captain A', limit: 50, offset: 0 }));
    assert.ok(byQ.items.some((c) => c.name === 'Captain A'));
  });

  it('list() does not leak captains across tenants', async () => {
    // Plant a captain inside the OTHER tenant via a full conversion path.
    const otherLead = await inOtherTenant(() =>
      leads.create(
        { name: 'Other Captain', phone: '+209998880001', source: 'manual' },
        actorUserId,
      ),
    );
    const otherCaptain = await inOtherTenant(() =>
      captains.convertFromLead(otherLead.id, {}, actorUserId),
    );

    const ours = await inTenant(() => captains.list({ limit: 200, offset: 0 }));
    assert.ok(
      !ours.items.some((c) => c.id === otherCaptain.id),
      'tenant A list must not include tenant B captain',
    );
  });

  it('findByIdOrThrow throws user-facing 404 for a cross-tenant id', async () => {
    const otherLead = await inOtherTenant(() =>
      leads.create(
        { name: 'Cross Captain', phone: '+209998880002', source: 'manual' },
        actorUserId,
      ),
    );
    const otherCaptain = await inOtherTenant(() =>
      captains.convertFromLead(otherLead.id, {}, actorUserId),
    );

    await assert.rejects(
      () => inTenant(() => captains.findByIdOrThrow(otherCaptain.id)),
      /Captain not found/,
    );
  });
});
