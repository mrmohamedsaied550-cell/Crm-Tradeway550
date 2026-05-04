/**
 * Phase C — C9: integration tests for `UserScopeAssignmentsService`.
 *
 * Throwaway tenant, manual wiring (mirrors org.test.ts). Coverage:
 *   - listForUser empty when no rows.
 *   - replaceForUser inserts new rows (companies + countries) and the
 *     read-back response matches.
 *   - replaceForUser is replace-the-set: removed ids are deleted,
 *     added ids are created, untouched ids stay.
 *   - Cross-tenant company / country ids are rejected with typed
 *     errors before any write happens.
 *   - Audit emission: user.scope.update always; user.scope.assign on
 *     additions; user.scope.revoke on removals; payloads carry the
 *     before/after lists, never lookup-only fields like names.
 *   - C3's ScopeContextService consumes the rows immediately (this is
 *     covered by leads-scope.test.ts; here we only sanity-check the
 *     row count is what the resolver expects).
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { tenantContext } from '../tenants/tenant-context';

import { CompaniesService } from './companies.service';
import { CountriesService } from './countries.service';
import { UserScopeAssignmentsService } from './user-scope-assignments.service';

const TEST_TENANT_CODE = '__c9_user_scope__';
const OTHER_TENANT_CODE = '__c9_user_scope_other__';

let prisma: PrismaClient;
let prismaSvc: PrismaService;
let companies: CompaniesService;
let countries: CountriesService;
let audit: AuditService;
let svc: UserScopeAssignmentsService;

let tenantId: string;
let otherTenantId: string;
let userId: string;
let actorUserId: string;
let companyAId: string;
let companyBId: string;
let countryEgId: string;
let countryMaId: string;
let foreignCompanyId: string;
let foreignCountryId: string;

function inTenant<T>(fn: () => Promise<T>): Promise<T> {
  return tenantContext.run({ tenantId, tenantCode: TEST_TENANT_CODE, source: 'header' }, fn);
}
function inOther<T>(fn: () => Promise<T>): Promise<T> {
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

describe('user scope assignments — read + replace + audit (C9)', () => {
  before(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    prismaSvc = new PrismaService();
    companies = new CompaniesService(prismaSvc);
    countries = new CountriesService(prismaSvc, companies);
    audit = new AuditService(prismaSvc);
    svc = new UserScopeAssignmentsService(prismaSvc, audit);

    const t = await prisma.tenant.upsert({
      where: { code: TEST_TENANT_CODE },
      update: { isActive: true },
      create: { code: TEST_TENANT_CODE, name: 'C9 user scope test' },
    });
    tenantId = t.id;

    const o = await prisma.tenant.upsert({
      where: { code: OTHER_TENANT_CODE },
      update: { isActive: true },
      create: { code: OTHER_TENANT_CODE, name: 'C9 user scope other tenant' },
    });
    otherTenantId = o.id;

    // Active-tenant role + user.
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

    const user = await withTenantRaw(tenantId, (tx) =>
      tx.user.create({
        data: {
          tenantId,
          email: 'c9-target@example.com',
          name: 'C9 target',
          passwordHash: 'x',
          roleId: role.id,
          status: 'active',
          language: 'en',
        },
      }),
    );
    userId = user.id;

    const actor = await withTenantRaw(tenantId, (tx) =>
      tx.user.create({
        data: {
          tenantId,
          email: 'c9-actor@example.com',
          name: 'C9 actor',
          passwordHash: 'x',
          roleId: role.id,
          status: 'active',
          language: 'en',
        },
      }),
    );
    actorUserId = actor.id;

    // Two companies and two countries in this tenant; one of each in
    // the other tenant for the cross-tenant rejection tests.
    const a = await inTenant(() => companies.create({ code: 'uber', name: 'Uber' }));
    const b = await inTenant(() => companies.create({ code: 'indrive', name: 'inDrive' }));
    companyAId = a.id;
    companyBId = b.id;

    const eg = await inTenant(() =>
      countries.create({ companyId: companyAId, code: 'EG', name: 'Egypt' }),
    );
    countryEgId = eg.id;
    const ma = await inTenant(() =>
      countries.create({ companyId: companyBId, code: 'MA', name: 'Morocco' }),
    );
    countryMaId = ma.id;

    const foreignCo = await inOther(() =>
      companies.create({ code: 'foreign', name: 'Foreign Co' }),
    );
    foreignCompanyId = foreignCo.id;
    const foreignCountry = await inOther(() =>
      countries.create({ companyId: foreignCompanyId, code: 'SA', name: 'Foreign Saudi' }),
    );
    foreignCountryId = foreignCountry.id;
  });

  after(async () => {
    await prisma.tenant.delete({ where: { code: TEST_TENANT_CODE } }).catch(() => {});
    await prisma.tenant.delete({ where: { code: OTHER_TENANT_CODE } }).catch(() => {});
    await prisma.$disconnect();
  });

  it('listForUser is empty when the user has no assignments', async () => {
    const result = await inTenant(() => svc.listForUser(userId));
    assert.deepEqual(result, { companies: [], countries: [] });
  });

  it('replaceForUser inserts companies + countries and returns the joined rows', async () => {
    const result = await inTenant(() =>
      svc.replaceForUser(
        userId,
        { companyIds: [companyAId, companyBId], countryIds: [countryEgId] },
        actorUserId,
      ),
    );
    assert.equal(result.companies.length, 2);
    assert.equal(result.countries.length, 1);
    assert.deepEqual(result.companies.map((c) => c.code).sort(), ['indrive', 'uber']);
    assert.equal(result.countries[0]?.code, 'EG');

    // C3's resolver consumes the table directly — sanity-check row
    // counts are what it expects.
    const rows = await withTenantRaw(tenantId, (tx) =>
      tx.userScopeAssignment.findMany({ where: { userId } }),
    );
    assert.equal(rows.length, 3);
  });

  it('replaceForUser is replace-the-set: removes drops, keeps overlap, adds new', async () => {
    // Currently: companies = [uber, indrive], countries = [EG]
    // Desired:   companies = [uber],          countries = [EG, MA]
    // Expect:    companyB removed, MA added, uber + EG untouched.
    const result = await inTenant(() =>
      svc.replaceForUser(
        userId,
        { companyIds: [companyAId], countryIds: [countryEgId, countryMaId] },
        actorUserId,
      ),
    );
    assert.deepEqual(
      result.companies.map((c) => c.code),
      ['uber'],
    );
    assert.deepEqual(result.countries.map((c) => c.code).sort(), ['EG', 'MA']);
  });

  it('emits user.scope.update + user.scope.assign + user.scope.revoke audit events', async () => {
    // Reset to a known state, then execute one operation that
    // both ADDS and REMOVES so all three events fire.
    await inTenant(() =>
      svc.replaceForUser(userId, { companyIds: [companyAId], countryIds: [] }, actorUserId),
    );

    const before = await withTenantRaw(tenantId, (tx) =>
      tx.auditEvent.findMany({
        where: { entityType: 'user', entityId: userId },
        select: { id: true },
      }),
    );
    const beforeIds = new Set(before.map((r) => r.id));

    await inTenant(() =>
      svc.replaceForUser(
        userId,
        { companyIds: [companyBId], countryIds: [countryEgId] },
        actorUserId,
      ),
    );

    const after = await withTenantRaw(tenantId, (tx) =>
      tx.auditEvent.findMany({
        where: { entityType: 'user', entityId: userId },
        orderBy: { createdAt: 'asc' },
      }),
    );
    const newRows = after.filter((r) => !beforeIds.has(r.id));
    const actions = newRows.map((r) => r.action).sort();
    assert.deepEqual(actions, ['user.scope.assign', 'user.scope.revoke', 'user.scope.update']);

    const update = newRows.find((r) => r.action === 'user.scope.update');
    const updatePayload = update?.payload as {
      targetUserId: string;
      before: { companyIds: string[]; countryIds: string[] };
      after: { companyIds: string[]; countryIds: string[] };
    };
    assert.equal(updatePayload.targetUserId, userId);
    assert.deepEqual(updatePayload.before.companyIds, [companyAId]);
    assert.deepEqual(updatePayload.after.companyIds, [companyBId]);
    assert.deepEqual(updatePayload.after.countryIds, [countryEgId]);

    const assign = newRows.find((r) => r.action === 'user.scope.assign');
    const assignPayload = assign?.payload as {
      companyIds: string[];
      countryIds: string[];
    };
    assert.deepEqual(assignPayload.companyIds, [companyBId]);
    assert.deepEqual(assignPayload.countryIds, [countryEgId]);

    const revoke = newRows.find((r) => r.action === 'user.scope.revoke');
    const revokePayload = revoke?.payload as { companyIds: string[] };
    assert.deepEqual(revokePayload.companyIds, [companyAId]);

    // No-op replace MUST still emit user.scope.update (provenance) but
    // NOT assign / revoke (no diff).
    const beforeNoop = await withTenantRaw(tenantId, (tx) =>
      tx.auditEvent.findMany({
        where: { entityType: 'user', entityId: userId },
        select: { id: true },
      }),
    );
    const beforeNoopIds = new Set(beforeNoop.map((r) => r.id));

    await inTenant(() =>
      svc.replaceForUser(
        userId,
        { companyIds: [companyBId], countryIds: [countryEgId] },
        actorUserId,
      ),
    );

    const afterNoop = await withTenantRaw(tenantId, (tx) =>
      tx.auditEvent.findMany({
        where: { entityType: 'user', entityId: userId },
        orderBy: { createdAt: 'asc' },
      }),
    );
    const noopNew = afterNoop.filter((r) => !beforeNoopIds.has(r.id)).map((r) => r.action);
    assert.deepEqual(noopNew, ['user.scope.update']);
  });

  it('rejects a foreign company id with company.not_in_tenant before any write', async () => {
    const before = await withTenantRaw(tenantId, (tx) =>
      tx.userScopeAssignment.count({ where: { userId } }),
    );
    await assert.rejects(
      () =>
        inTenant(() =>
          svc.replaceForUser(
            userId,
            { companyIds: [foreignCompanyId], countryIds: [] },
            actorUserId,
          ),
        ),
      /not defined in the active tenant/,
    );
    const after = await withTenantRaw(tenantId, (tx) =>
      tx.userScopeAssignment.count({ where: { userId } }),
    );
    assert.equal(after, before, 'no rows should have been written');
  });

  it('rejects a foreign country id with country.not_in_tenant before any write', async () => {
    await assert.rejects(
      () =>
        inTenant(() =>
          svc.replaceForUser(
            userId,
            { companyIds: [], countryIds: [foreignCountryId] },
            actorUserId,
          ),
        ),
      /not defined in the active tenant/,
    );
  });

  it('rejects when the target user does not belong to the active tenant', async () => {
    // Create a user in the other tenant and try to assign from this tenant.
    const otherUser = await withTenantRaw(otherTenantId, async (tx) => {
      const role = await tx.role.upsert({
        where: { tenantId_code: { tenantId: otherTenantId, code: 'sales_agent' } },
        update: {},
        create: {
          tenantId: otherTenantId,
          code: 'sales_agent',
          nameAr: 'وكيل',
          nameEn: 'Sales Agent',
          level: 30,
        },
      });
      return tx.user.create({
        data: {
          tenantId: otherTenantId,
          email: 'foreign@example.com',
          name: 'Foreign user',
          passwordHash: 'x',
          roleId: role.id,
          status: 'active',
          language: 'en',
        },
      });
    });
    await assert.rejects(
      () =>
        inTenant(() =>
          svc.replaceForUser(otherUser.id, { companyIds: [], countryIds: [] }, actorUserId),
        ),
      /not defined in the active tenant/,
    );
  });

  it('empty arrays revoke every assignment for the dimension', async () => {
    // Seed with both kinds.
    await inTenant(() =>
      svc.replaceForUser(
        userId,
        { companyIds: [companyAId, companyBId], countryIds: [countryEgId] },
        actorUserId,
      ),
    );
    // Now clear everything.
    const result = await inTenant(() =>
      svc.replaceForUser(userId, { companyIds: [], countryIds: [] }, actorUserId),
    );
    assert.deepEqual(result, { companies: [], countries: [] });
    const rows = await withTenantRaw(tenantId, (tx) =>
      tx.userScopeAssignment.count({ where: { userId } }),
    );
    assert.equal(rows, 0);
  });
});
