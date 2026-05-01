/**
 * Integration test — verifies the C7 seed produced the expected RBAC data
 * for the default tenant, plus the C14 `listRoleSummaries` shape +
 * tenant-scoping. Requires Postgres reachable via DATABASE_URL.
 *
 * Re-run-safe: read-only against the default tenant; the C14 isolation
 * test provisions and tears down a throwaway tenant.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { ALL_CAPABILITY_CODES, CAPABILITY_DEFINITIONS } from './capabilities.registry';
import { ALL_ROLE_CODES, ROLE_DEFINITIONS } from './roles.registry';
import { PrismaService } from '../prisma/prisma.service';
import { tenantContext } from '../tenants/tenant-context';
import { RbacService } from './rbac.service';

const DEFAULT_TENANT_CODE = 'trade_way_default';
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let prisma: PrismaClient;
let tenantId: string;

async function withTenant<T>(fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return prisma.$transaction(async (tx: any) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.tenant_id = '${tenantId}'`);
    return fn(tx);
  });
}

describe('rbac seed', () => {
  before(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    const tenant = await prisma.tenant.findUnique({ where: { code: DEFAULT_TENANT_CODE } });
    assert.ok(tenant, `seed precondition: tenant '${DEFAULT_TENANT_CODE}' must exist`);
    assert.ok(UUID_REGEX.test(tenant.id), 'tenant id is a uuid');
    tenantId = tenant.id;
  });

  after(async () => {
    await prisma.$disconnect();
  });

  it('seeds every capability defined in the registry', async () => {
    const rows = await prisma.capability.findMany({ select: { code: true } });
    const codes = new Set(rows.map((r) => r.code));
    assert.equal(codes.size, CAPABILITY_DEFINITIONS.length);
    for (const code of ALL_CAPABILITY_CODES) {
      assert.ok(codes.has(code), `capability missing: ${code}`);
    }
  });

  it('seeds every role defined in the registry for the default tenant', async () => {
    const rows = await withTenant((tx) =>
      tx.role.findMany({ select: { code: true, level: true, isActive: true } }),
    );
    const codes = new Set(rows.map((r) => r.code));
    assert.equal(codes.size, ROLE_DEFINITIONS.length);
    for (const code of ALL_ROLE_CODES) {
      assert.ok(codes.has(code), `role missing: ${code}`);
    }
    for (const r of rows) {
      assert.equal(r.isActive, true, `role ${r.code} should be active`);
    }
  });

  it('grants exactly the registry-declared capability set per role', async () => {
    const rows = await withTenant((tx) =>
      tx.role.findMany({
        include: {
          capabilities: { include: { capability: { select: { code: true } } } },
        },
      }),
    );
    const got = new Map(
      rows.map((r) => [r.code, new Set(r.capabilities.map((rc) => rc.capability.code))]),
    );

    for (const def of ROLE_DEFINITIONS) {
      const actual = got.get(def.code);
      assert.ok(actual, `no row for role ${def.code}`);
      assert.equal(
        actual.size,
        def.capabilities.length,
        `role ${def.code}: expected ${def.capabilities.length} caps, got ${actual.size}`,
      );
      for (const expected of def.capabilities) {
        assert.ok(actual.has(expected), `role ${def.code} missing capability ${expected}`);
      }
    }
  });

  it('super_admin has every capability', async () => {
    const role = await withTenant((tx) =>
      tx.role.findFirst({
        where: { code: 'super_admin' },
        include: {
          capabilities: { include: { capability: { select: { code: true } } } },
        },
      }),
    );
    assert.ok(role);
    const codes = new Set(role.capabilities.map((rc) => rc.capability.code));
    assert.equal(codes.size, ALL_CAPABILITY_CODES.length);
    for (const code of ALL_CAPABILITY_CODES) {
      assert.ok(codes.has(code), `super_admin missing capability ${code}`);
    }
  });

  it('agents and qa_specialist have no admin capabilities in Sprint 1', async () => {
    const rows = await withTenant((tx) =>
      tx.role.findMany({
        where: {
          code: { in: ['sales_agent', 'activation_agent', 'driving_agent', 'qa_specialist'] },
        },
        include: { capabilities: { include: { capability: { select: { code: true } } } } },
      }),
    );
    // P2-01 — agents now hold read + execute capabilities (lead /
    // pipeline / followup / whatsapp.*.read), but they MUST NOT hold
    // any admin / write capability that isn't part of their day job.
    // QA specialist additionally gets `audit.read` so they can review
    // actor activity; that's not an "admin" capability.
    const ADMIN_ONLY: ReadonlySet<string> = new Set([
      'org.company.write',
      'org.country.write',
      'org.country.holidays.write',
      'org.team.write',
      'users.write',
      'users.disable',
      'users.reset',
      'whatsapp.account.write',
      'bonus.write',
      'competition.write',
    ]);
    for (const r of rows) {
      const codes = r.capabilities.map((rc) => rc.capability.code);
      const violations = codes.filter((c) => ADMIN_ONLY.has(c));
      assert.deepEqual(
        violations,
        [],
        `role ${r.code} must not hold admin capabilities; saw ${violations.join(',')}`,
      );
    }
  });
});

// ───────────────────────────────────────────────────────────────────────
// C14 — RbacService.listRoleSummaries (powers GET /rbac/roles)
// ───────────────────────────────────────────────────────────────────────

const TEST_TENANT_CODE = '__c14_rbac__';

describe('rbac — listRoleSummaries (C14)', () => {
  let svc: RbacService;
  let isolatedTenantId: string;

  before(async () => {
    prisma = prisma ?? new PrismaClient();
    await prisma.$connect();
    const tenant = await prisma.tenant.findUnique({ where: { code: DEFAULT_TENANT_CODE } });
    assert.ok(tenant);
    tenantId = tenant.id;
    svc = new RbacService(new PrismaService());

    const isolated = await prisma.tenant.upsert({
      where: { code: TEST_TENANT_CODE },
      update: { isActive: true },
      create: { code: TEST_TENANT_CODE, name: 'C14 RBAC isolation tenant' },
    });
    isolatedTenantId = isolated.id;
  });

  after(async () => {
    await prisma.tenant.delete({ where: { code: TEST_TENANT_CODE } }).catch(() => {});
    await prisma.$disconnect();
  });

  function inDefaultTenant<T>(fn: () => Promise<T>): Promise<T> {
    return tenantContext.run({ tenantId, tenantCode: DEFAULT_TENANT_CODE, source: 'header' }, fn);
  }

  function inIsolatedTenant<T>(fn: () => Promise<T>): Promise<T> {
    return tenantContext.run(
      { tenantId: isolatedTenantId, tenantCode: TEST_TENANT_CODE, source: 'header' },
      fn,
    );
  }

  it('returns all 11 active seeded roles with the expected summary shape', async () => {
    const summaries = await inDefaultTenant(() => svc.listRoleSummaries());
    assert.equal(summaries.length, ROLE_DEFINITIONS.length);

    for (const s of summaries) {
      assert.match(s.id, UUID_REGEX, `role ${s.code} has UUID id`);
      assert.equal(typeof s.code, 'string');
      assert.equal(typeof s.nameEn, 'string');
      assert.equal(typeof s.nameAr, 'string');
      assert.equal(typeof s.level, 'number');
      assert.equal(typeof s.capabilitiesCount, 'number');
      assert.ok(s.capabilitiesCount >= 0);
    }

    // Spot-check a few specific roles map to the right counts from the registry.
    const byCode = new Map(summaries.map((s) => [s.code, s]));
    for (const def of ROLE_DEFINITIONS) {
      const got = byCode.get(def.code);
      assert.ok(got, `summary missing role ${def.code}`);
      assert.equal(
        got.capabilitiesCount,
        def.capabilities.length,
        `role ${def.code}: expected count ${def.capabilities.length}, got ${got.capabilitiesCount}`,
      );
    }
  });

  it('orders results by level DESC then code ASC', async () => {
    const summaries = await inDefaultTenant(() => svc.listRoleSummaries());
    for (let i = 1; i < summaries.length; i++) {
      const prev = summaries[i - 1]!;
      const curr = summaries[i]!;
      if (prev.level === curr.level) {
        assert.ok(
          prev.code <= curr.code,
          `tie-breaker violated at index ${i}: ${prev.code} > ${curr.code}`,
        );
      } else {
        assert.ok(
          prev.level > curr.level,
          `level order violated at index ${i}: ${prev.level} <= ${curr.level}`,
        );
      }
    }
  });

  it('filters out inactive roles', async () => {
    // Pick one role, disable it, expect listRoleSummaries to omit it.
    const target = 'qa_specialist';
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL app.tenant_id = '${tenantId}'`);
      await tx.role.update({
        where: { tenantId_code: { tenantId, code: target } },
        data: { isActive: false },
      });
    });
    try {
      const summaries = await inDefaultTenant(() => svc.listRoleSummaries());
      assert.equal(
        summaries.find((s) => s.code === target),
        undefined,
        'inactive role must be omitted',
      );
    } finally {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL app.tenant_id = '${tenantId}'`);
        await tx.role.update({
          where: { tenantId_code: { tenantId, code: target } },
          data: { isActive: true },
        });
      });
    }
  });

  it('isolates tenants — a tenant with no roles seeded returns []', async () => {
    const summaries = await inIsolatedTenant(() => svc.listRoleSummaries());
    assert.deepEqual(summaries, []);
  });

  it('does not leak default-tenant roles into the isolated tenant', async () => {
    // Plant a single role in the isolated tenant via raw GUC.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL app.tenant_id = '${isolatedTenantId}'`);
      await tx.role.upsert({
        where: { tenantId_code: { tenantId: isolatedTenantId, code: 'sales_agent' } },
        update: {},
        create: {
          tenantId: isolatedTenantId,
          code: 'sales_agent',
          nameAr: 'وكيل',
          nameEn: 'Sales Agent (probe)',
          level: 30,
        },
      });
    });

    const summaries = await inIsolatedTenant(() => svc.listRoleSummaries());
    assert.equal(summaries.length, 1, 'isolated tenant sees only its own role');
    assert.equal(summaries[0]?.code, 'sales_agent');
    assert.equal(summaries[0]?.nameEn, 'Sales Agent (probe)');
    assert.equal(summaries[0]?.capabilitiesCount, 0);
  });
});
