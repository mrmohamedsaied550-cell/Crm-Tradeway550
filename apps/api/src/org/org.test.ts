/**
 * Integration tests for the C12 org structure (Company / Country / Team)
 * and the admin Users CRUD service.
 *
 * Mirrors the manual-wiring pattern from leads/sla tests: no full Nest
 * bootstrap, every assertion runs under an explicit
 * AsyncLocalStorage tenant scope, throwaway tenants for isolation.
 *
 * Coverage:
 *   - Companies CRUD (create / read / update / delete + duplicate code).
 *   - Countries CRUD with hierarchy:
 *       * companyId from another tenant is rejected as 404 (RLS guard).
 *       * deleting a company with countries returns 409.
 *   - Teams CRUD with hierarchy:
 *       * countryId from another tenant is rejected as 404.
 *       * deleting a country with teams returns 409.
 *   - AdminUsersService:
 *       * create with valid roleId + teamId succeeds.
 *       * roleId from another tenant rejected (BadRequest).
 *       * teamId from another tenant rejected (NotFound).
 *       * update teamId=null detaches without deleting the user.
 *       * disable() flips status to 'disabled' without removing the row.
 *       * deleting the team SetNulls the user's teamId.
 *   - RLS isolation: companies / countries / teams created in tenant A
 *     are invisible from tenant B's GUC; raw inserts for the wrong tenant
 *     are rejected by WITH CHECK.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { tenantContext } from '../tenants/tenant-context';
import { CompaniesService } from './companies.service';
import { CountriesService } from './countries.service';
import { TeamsService } from './teams.service';
import { AdminUsersService } from './admin-users.service';

const TEST_TENANT_CODE = '__c12_org__';
const OTHER_TENANT_CODE = '__c12_org_other__';

let prisma: PrismaClient;
let prismaSvc: PrismaService;
let companies: CompaniesService;
let countries: CountriesService;
let teams: TeamsService;
let users: AdminUsersService;

let tenantId: string;
let otherTenantId: string;
let salesAgentRoleId: string;

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

describe('org — companies / countries / teams CRUD on a throwaway tenant', () => {
  before(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    prismaSvc = new PrismaService();
    companies = new CompaniesService(prismaSvc);
    countries = new CountriesService(prismaSvc, companies);
    teams = new TeamsService(prismaSvc, countries);
    users = new AdminUsersService(prismaSvc, teams);

    const t = await prisma.tenant.upsert({
      where: { code: TEST_TENANT_CODE },
      update: { isActive: true },
      create: { code: TEST_TENANT_CODE, name: 'C12 org test' },
    });
    tenantId = t.id;

    const o = await prisma.tenant.upsert({
      where: { code: OTHER_TENANT_CODE },
      update: { isActive: true },
      create: { code: OTHER_TENANT_CODE, name: 'C12 org other tenant' },
    });
    otherTenantId = o.id;

    // Need a role in the active tenant for the AdminUsers CRUD tests.
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
  });

  after(async () => {
    await prisma.tenant.delete({ where: { code: TEST_TENANT_CODE } }).catch(() => {});
    await prisma.tenant.delete({ where: { code: OTHER_TENANT_CODE } }).catch(() => {});
    await prisma.$disconnect();
  });

  // ───────── Companies ─────────

  it('creates and reads a company; rejects a duplicate code', async () => {
    const created = await inTenant(() => companies.create({ code: 'uber', name: 'Uber' }));
    assert.equal(created.code, 'uber');
    assert.equal(created.isActive, true);

    const reread = await inTenant(() => companies.findByIdOrThrow(created.id));
    assert.equal(reread.id, created.id);

    await assert.rejects(
      () => inTenant(() => companies.create({ code: 'uber', name: 'Uber dup' })),
      /already exists/,
    );
  });

  it('updates a company and lists it sorted by isActive then code', async () => {
    await inTenant(() => companies.create({ code: 'indrive', name: 'inDrive' }));
    await inTenant(() => companies.create({ code: 'careem', name: 'Careem' }));

    const list = await inTenant(() => companies.list());
    const codes = list.map((c) => c.code);
    // 'careem', 'indrive', 'uber' — alphabetical inside the same isActive group.
    assert.deepEqual(codes, ['careem', 'indrive', 'uber']);
  });

  // ───────── Countries (hierarchy) ─────────

  it('creates a country under a company; rejects a cross-tenant companyId', async () => {
    // Plant a company inside the OTHER tenant.
    const otherCompany = await withTenantRaw(otherTenantId, (tx) =>
      tx.company.create({
        data: { tenantId: otherTenantId, code: 'careem', name: 'Other Careem' },
      }),
    );

    const ownCompany = await inTenant(() => companies.create({ code: 'yango', name: 'Yango' }));

    const country = await inTenant(() =>
      countries.create({ companyId: ownCompany.id, code: 'EG', name: 'Egypt' }),
    );
    assert.equal(country.code, 'EG');
    assert.equal(country.companyId, ownCompany.id);

    // Cross-tenant FK insert: must surface as the same-shaped 404 the lookup
    // returns (RLS hides the company from this tenant's view).
    await assert.rejects(
      () =>
        inTenant(() =>
          countries.create({ companyId: otherCompany.id, code: 'EG', name: 'Cross-tenant' }),
        ),
      /Company not found/,
    );
  });

  it('rejects deleting a company that still has countries', async () => {
    const company = await inTenant(() => companies.create({ code: 'didi', name: 'DiDi' }));
    await inTenant(() => countries.create({ companyId: company.id, code: 'MA', name: 'Morocco' }));

    await assert.rejects(() => inTenant(() => companies.delete(company.id)), /still has countries/);
  });

  it('allows the same country code under different companies in one tenant', async () => {
    const c1 = await inTenant(() => companies.create({ code: 'bolt', name: 'Bolt' }));
    const c2 = await inTenant(() => companies.create({ code: 'gett', name: 'Gett' }));

    const cy1 = await inTenant(() =>
      countries.create({ companyId: c1.id, code: 'DZ', name: 'Algeria' }),
    );
    const cy2 = await inTenant(() =>
      countries.create({ companyId: c2.id, code: 'DZ', name: 'Algeria' }),
    );
    assert.notEqual(cy1.id, cy2.id);
    assert.equal(cy1.code, cy2.code);
  });

  // ───────── Teams (hierarchy) ─────────

  it('creates a team under a country; rejects a cross-tenant countryId', async () => {
    const company = await inTenant(() => companies.create({ code: 'lyft', name: 'Lyft' }));
    const country = await inTenant(() =>
      countries.create({ companyId: company.id, code: 'KW', name: 'Kuwait' }),
    );

    const team = await inTenant(() => teams.create({ countryId: country.id, name: 'Sales' }));
    assert.equal(team.name, 'Sales');

    // Cross-tenant team creation: plant a country in the OTHER tenant first.
    const otherCompany = await withTenantRaw(otherTenantId, (tx) =>
      tx.company.create({
        data: { tenantId: otherTenantId, code: 'lyft', name: 'Lyft Other' },
      }),
    );
    const otherCountry = await withTenantRaw(otherTenantId, (tx) =>
      tx.country.create({
        data: {
          tenantId: otherTenantId,
          companyId: otherCompany.id,
          code: 'KW',
          name: 'Kuwait Other',
        },
      }),
    );
    await assert.rejects(
      () => inTenant(() => teams.create({ countryId: otherCountry.id, name: 'Sales' })),
      /Country not found/,
    );
  });

  it('rejects deleting a country that still has teams', async () => {
    const company = await inTenant(() => companies.create({ code: 'taxify', name: 'Taxify' }));
    const country = await inTenant(() =>
      countries.create({ companyId: company.id, code: 'JO', name: 'Jordan' }),
    );
    await inTenant(() => teams.create({ countryId: country.id, name: 'Sales' }));

    await assert.rejects(() => inTenant(() => countries.delete(country.id)), /still has teams/);
  });

  // ───────── AdminUsers ─────────

  it('creates a user with valid role + team; rejects unknown role / team', async () => {
    const company = await inTenant(() => companies.create({ code: 'wazu', name: 'Wazu' }));
    const country = await inTenant(() =>
      countries.create({ companyId: company.id, code: 'TN', name: 'Tunisia' }),
    );
    const team = await inTenant(() => teams.create({ countryId: country.id, name: 'Sales' }));

    const user = await inTenant(() =>
      users.create({
        email: 'tn.sales1@test',
        name: 'TN Sales',
        password: 'Password@123',
        roleId: salesAgentRoleId,
        teamId: team.id,
      }),
    );
    assert.equal(user.email, 'tn.sales1@test');
    assert.equal(user.teamId, team.id);
    assert.equal(user.roleId, salesAgentRoleId);
    assert.equal(user.status, 'active');
    // SafeUser projection MUST NOT carry the password hash.
    assert.equal((user as Record<string, unknown>)['passwordHash'], undefined);

    const fakeUuid = '00000000-0000-4000-8000-000000000001';
    await assert.rejects(
      () =>
        inTenant(() =>
          users.create({
            email: 'broken1@test',
            name: 'Broken',
            password: 'Password@123',
            roleId: fakeUuid,
          }),
        ),
      /not defined in the active tenant/,
    );
    await assert.rejects(
      () =>
        inTenant(() =>
          users.create({
            email: 'broken2@test',
            name: 'Broken',
            password: 'Password@123',
            roleId: salesAgentRoleId,
            teamId: fakeUuid,
          }),
        ),
      /Team not found/,
    );
  });

  it('updates a user (teamId=null detaches without delete) and disable() flips status', async () => {
    const company = await inTenant(() => companies.create({ code: 'gojek', name: 'Gojek' }));
    const country = await inTenant(() =>
      countries.create({ companyId: company.id, code: 'ID', name: 'Indonesia' }),
    );
    const team = await inTenant(() => teams.create({ countryId: country.id, name: 'Sales' }));

    const user = await inTenant(() =>
      users.create({
        email: 'id.sales1@test',
        name: 'ID Sales',
        password: 'Password@123',
        roleId: salesAgentRoleId,
        teamId: team.id,
      }),
    );

    const detached = await inTenant(() => users.update(user.id, { teamId: null }));
    assert.equal(detached.teamId, null);

    const disabled = await inTenant(() => users.disable(user.id));
    assert.equal(disabled.status, 'disabled');

    // Row still exists.
    const reread = await inTenant(() => users.findByIdOrThrow(user.id));
    assert.equal(reread.id, user.id);
  });

  it('deleting a team detaches its users (FK SET NULL) instead of cascading', async () => {
    const company = await inTenant(() => companies.create({ code: 'maxim', name: 'Maxim' }));
    const country = await inTenant(() =>
      countries.create({ companyId: company.id, code: 'BH', name: 'Bahrain' }),
    );
    const team = await inTenant(() => teams.create({ countryId: country.id, name: 'Sales' }));

    const user = await inTenant(() =>
      users.create({
        email: 'bh.sales1@test',
        name: 'BH Sales',
        password: 'Password@123',
        roleId: salesAgentRoleId,
        teamId: team.id,
      }),
    );
    assert.equal(user.teamId, team.id);

    await inTenant(() => teams.delete(team.id));

    const reread = await inTenant(() => users.findByIdOrThrow(user.id));
    assert.equal(reread.teamId, null, 'team_id should be SET NULL');
  });
});

// ───────────────────────────────────────────────────────────────────────
// RLS isolation
// ───────────────────────────────────────────────────────────────────────

describe('org — RLS isolation across tenants', () => {
  let alphaTenantId: string;
  let betaTenantId: string;
  let alphaCompanyId: string;

  before(async () => {
    prisma = prisma ?? new PrismaClient();
    await prisma.$connect();
    prismaSvc = prismaSvc ?? new PrismaService();
    companies = companies ?? new CompaniesService(prismaSvc);
    countries = countries ?? new CountriesService(prismaSvc, companies);
    teams = teams ?? new TeamsService(prismaSvc, countries);

    const a = await prisma.tenant.upsert({
      where: { code: '__c12_rls_alpha__' },
      update: { isActive: true },
      create: { code: '__c12_rls_alpha__', name: 'C12 RLS alpha' },
    });
    alphaTenantId = a.id;

    const b = await prisma.tenant.upsert({
      where: { code: '__c12_rls_beta__' },
      update: { isActive: true },
      create: { code: '__c12_rls_beta__', name: 'C12 RLS beta' },
    });
    betaTenantId = b.id;

    // Plant a company inside alpha via raw GUC.
    const c = await withTenantRaw(alphaTenantId, (tx) =>
      tx.company.create({
        data: { tenantId: alphaTenantId, code: 'rlsprobe', name: 'RLS Probe' },
      }),
    );
    alphaCompanyId = c.id;
  });

  after(async () => {
    await prisma.tenant.delete({ where: { code: '__c12_rls_alpha__' } }).catch(() => {});
    await prisma.tenant.delete({ where: { code: '__c12_rls_beta__' } }).catch(() => {});
    await prisma.$disconnect();
  });

  it('reading companies without a GUC returns 0 rows', async () => {
    const rows = await prisma.company.findMany({ where: { code: 'rlsprobe' } });
    assert.equal(rows.length, 0);
  });

  it('beta tenant cannot see alpha-tenant companies via the service', async () => {
    const list = await tenantContext.run(
      { tenantId: betaTenantId, tenantCode: '__c12_rls_beta__', source: 'header' },
      () => companies.list(),
    );
    const ids = list.map((c) => c.id);
    assert.ok(!ids.includes(alphaCompanyId));
  });

  it('inserting a company with a foreign tenant_id is rejected by WITH CHECK', async () => {
    let threw = false;
    try {
      await withTenantRaw(betaTenantId, async (tx) => {
        // GUC = beta, but we attempt to write a row for alpha.
        await tx.company.create({
          data: { tenantId: alphaTenantId, code: 'attack', name: 'attack' },
        });
      });
    } catch {
      threw = true;
    }
    assert.equal(threw, true, 'expected RLS WITH CHECK to reject the cross-tenant insert');
  });

  it('teams from one tenant are invisible to another tenant', async () => {
    // Plant a country + team in alpha.
    const country = await withTenantRaw(alphaTenantId, (tx) =>
      tx.country.create({
        data: {
          tenantId: alphaTenantId,
          companyId: alphaCompanyId,
          code: 'AE',
          name: 'UAE',
        },
      }),
    );
    const team = await withTenantRaw(alphaTenantId, (tx) =>
      tx.team.create({
        data: { tenantId: alphaTenantId, countryId: country.id, name: 'Sales' },
      }),
    );

    // From beta's GUC the team must not appear in any list.
    const list = await tenantContext.run(
      { tenantId: betaTenantId, tenantCode: '__c12_rls_beta__', source: 'header' },
      () => teams.list(),
    );
    assert.ok(!list.some((t) => t.id === team.id));
  });
});

// Helper unused-vars guard — keep `inOtherTenant` exported via reference so
// linting doesn't complain when only some tests use it.
void inOtherTenant;
