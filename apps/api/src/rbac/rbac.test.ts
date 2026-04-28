/**
 * Integration test — verifies the C7 seed produced the expected RBAC data
 * for the default tenant. Requires Postgres to be reachable via DATABASE_URL.
 *
 * Re-run-safe: the test is read-only.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { ALL_CAPABILITY_CODES, CAPABILITY_DEFINITIONS } from './capabilities.registry';
import { ALL_ROLE_CODES, ROLE_DEFINITIONS } from './roles.registry';

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
        include: { capabilities: true },
      }),
    );
    for (const r of rows) {
      assert.equal(r.capabilities.length, 0, `role ${r.code} should have 0 caps in Sprint 1`);
    }
  });
});
