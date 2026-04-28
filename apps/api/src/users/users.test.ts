/**
 * Integration tests — verifies the seed produces the expected user roster
 * for the default tenant (C8 baseline plus the C12 team-assigned additions),
 * that each is bound to the correct role, that bcrypt verification succeeds
 * with the seed password (and only that password), and that the users table
 * honours RLS.
 *
 * Requires Postgres reachable via DATABASE_URL.
 * Re-run-safe.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { hashPassword, verifyPassword } from '../identity/password.util';

const DEFAULT_TENANT_CODE = 'trade_way_default';
const TEST_TENANT_CODE = '__rls_users_test__';
const SEED_PASSWORD = process.env['SEED_DEFAULT_PASSWORD'] ?? 'Password@123';
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SEEDED = [
  { email: 'super@tradeway.com', role: 'super_admin' },
  { email: 'ops@tradeway.com', role: 'ops_manager' },
  { email: 'eg.manager@tradeway.com', role: 'account_manager' },
  { email: 'eg.uber.tl.sales@tradeway.com', role: 'tl_sales' },
  { email: 'eg.uber.sales1@tradeway.com', role: 'sales_agent' },
  // C12 — team-assigned additions.
  { email: 'eg.uber.activation1@tradeway.com', role: 'activation_agent' },
  { email: 'sa.uber.sales1@tradeway.com', role: 'sales_agent' },
] as const;

let prisma: PrismaClient;
let defaultTenantId: string;
let testTenantId: string;

async function withTenant<T>(tenantId: string, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
  if (!UUID_REGEX.test(tenantId)) throw new Error(`invalid tenantId: ${tenantId}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return prisma.$transaction(async (tx: any) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.tenant_id = '${tenantId}'`);
    return fn(tx);
  });
}

describe('users — seeded data + role mapping + password verification', () => {
  before(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    const t = await prisma.tenant.findUnique({ where: { code: DEFAULT_TENANT_CODE } });
    assert.ok(t, 'precondition: default tenant exists');
    defaultTenantId = t.id;
  });

  after(async () => {
    await prisma.$disconnect();
  });

  it('seeds the expected users for trade_way_default', async () => {
    const rows = await withTenant(defaultTenantId, (tx) =>
      tx.user.findMany({ where: { email: { in: SEEDED.map((s) => s.email) } } }),
    );
    assert.equal(rows.length, SEEDED.length);
  });

  it('every seeded user is bound to the expected role', async () => {
    const rows = await withTenant(defaultTenantId, (tx) =>
      tx.user.findMany({
        where: { email: { in: SEEDED.map((s) => s.email) } },
        include: { role: { select: { code: true } } },
      }),
    );
    const got = new Map(rows.map((u) => [u.email, u.role.code]));
    for (const s of SEEDED) {
      assert.equal(got.get(s.email), s.role, `${s.email} → ${s.role}`);
    }
  });

  it('every seeded user has a non-empty bcrypt hash and active status', async () => {
    const rows = await withTenant(defaultTenantId, (tx) =>
      tx.user.findMany({
        where: { email: { in: SEEDED.map((s) => s.email) } },
        select: { email: true, status: true, passwordHash: true },
      }),
    );
    for (const u of rows) {
      assert.equal(u.status, 'active');
      assert.match(u.passwordHash, /^\$2[aby]\$/, `${u.email} hash format`);
      assert.equal(u.passwordHash.length, 60, `${u.email} hash length`);
    }
  });

  it('verifyPassword accepts the seed password for super_admin and rejects everything else', async () => {
    const row = await withTenant(defaultTenantId, (tx) =>
      tx.user.findUnique({
        where: { tenantId_email: { tenantId: defaultTenantId, email: 'super@tradeway.com' } },
        select: { passwordHash: true },
      }),
    );
    assert.ok(row);
    assert.equal(await verifyPassword(SEED_PASSWORD, row.passwordHash), true);
    assert.equal(await verifyPassword('not-the-password', row.passwordHash), false);
    assert.equal(await verifyPassword('', row.passwordHash), false);
  });
});

describe('users — RLS isolation', () => {
  let testRoleId: string;
  let defaultRoleId: string;

  before(async () => {
    // Ephemeral test tenant with its own throwaway role.
    const t = await prisma.tenant.upsert({
      where: { code: TEST_TENANT_CODE },
      update: { isActive: true },
      create: { code: TEST_TENANT_CODE, name: 'RLS users test tenant' },
    });
    testTenantId = t.id;

    const role = await withTenant(testTenantId, (tx) =>
      tx.role.upsert({
        where: { tenantId_code: { tenantId: testTenantId, code: '__rls_user_role__' } },
        update: {},
        create: {
          tenantId: testTenantId,
          code: '__rls_user_role__',
          nameAr: 'rls',
          nameEn: 'rls',
          level: 0,
        },
      }),
    );
    testRoleId = role.id;

    // Need an existing role id for default tenant for the negative-insert test.
    const def = await withTenant(defaultTenantId, (tx) =>
      tx.role.findFirstOrThrow({ where: { code: 'sales_agent' } }),
    );
    defaultRoleId = def.id;

    const hash = await hashPassword('rls-probe-pw', 4);
    await withTenant(testTenantId, (tx) =>
      tx.user.upsert({
        where: { tenantId_email: { tenantId: testTenantId, email: '__probe__@rls.test' } },
        update: {},
        create: {
          tenantId: testTenantId,
          email: '__probe__@rls.test',
          passwordHash: hash,
          name: 'RLS probe',
          roleId: testRoleId,
        },
      }),
    );
  });

  after(async () => {
    // Cascading delete of the test tenant takes its users + roles with it.
    await prisma.tenant.delete({ where: { code: TEST_TENANT_CODE } }).catch(() => {});
  });

  it('reading users without a GUC returns 0 rows', async () => {
    const rows = await prisma.user.findMany({ where: { email: '__probe__@rls.test' } });
    assert.equal(rows.length, 0, 'no GUC must yield 0 rows');
  });

  it('default tenant cannot see the test tenant probe user', async () => {
    const rows = await withTenant(defaultTenantId, (tx) =>
      tx.user.findMany({ where: { email: '__probe__@rls.test' } }),
    );
    assert.equal(rows.length, 0);
  });

  it('test tenant sees only its own probe user', async () => {
    const rows = await withTenant(testTenantId, (tx) =>
      tx.user.findMany({ where: { email: '__probe__@rls.test' } }),
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.tenantId, testTenantId);
  });

  it('inserting a user with a foreign tenant_id is rejected by WITH CHECK', async () => {
    const hash = await hashPassword('attack', 4);
    let threw = false;
    try {
      await withTenant(testTenantId, (tx) =>
        tx.user.create({
          data: {
            // GUC is testTenantId, but we attempt to write a row for defaultTenantId.
            tenantId: defaultTenantId,
            email: '__rls_attack__@example.com',
            passwordHash: hash,
            name: 'attack',
            roleId: defaultRoleId,
          },
        }),
      );
    } catch (err) {
      threw = true;
      assert.match(
        String((err as Error).message),
        /row-level security|row level security|violates/i,
      );
    }
    assert.equal(threw, true, 'cross-tenant insert must be rejected');
  });
});
