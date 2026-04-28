/**
 * Integration test — verifies that Row-Level Security on tenant-scoped tables
 * actually denies cross-tenant access. Requires Postgres to be reachable.
 *
 * The test creates an ephemeral second tenant `__rls_test__`, inserts one
 * role into the default tenant and one into the test tenant, then asserts:
 *   - reads with GUC = default see only the default's row
 *   - reads with GUC = test see only the test's row
 *   - reads without any GUC see zero rows (FORCE RLS denies even the owner)
 *   - INSERTs with the wrong tenant_id are rejected by the WITH CHECK policy
 *
 * Cleans up after itself.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';

const DEFAULT_TENANT_CODE = 'trade_way_default';
const TEST_TENANT_CODE = '__rls_test__';

const ROLE_CODE_DEFAULT = '__rls_probe_default__';
const ROLE_CODE_TEST = '__rls_probe_test__';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

describe('rls — tenant isolation on roles + role_capabilities', () => {
  before(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();

    const def = await prisma.tenant.findUnique({ where: { code: DEFAULT_TENANT_CODE } });
    assert.ok(def, `precondition: tenant '${DEFAULT_TENANT_CODE}' must exist`);
    defaultTenantId = def.id;

    // Create (or recover) the ephemeral test tenant.
    const test = await prisma.tenant.upsert({
      where: { code: TEST_TENANT_CODE },
      update: { isActive: true },
      create: { code: TEST_TENANT_CODE, name: 'RLS test tenant' },
    });
    testTenantId = test.id;

    // Insert one probe role per tenant via the correct GUC.
    await withTenant(defaultTenantId, (tx) =>
      tx.role.upsert({
        where: { tenantId_code: { tenantId: defaultTenantId, code: ROLE_CODE_DEFAULT } },
        update: {},
        create: {
          tenantId: defaultTenantId,
          code: ROLE_CODE_DEFAULT,
          nameAr: 'rls-default',
          nameEn: 'rls-default',
          level: 1,
        },
      }),
    );
    await withTenant(testTenantId, (tx) =>
      tx.role.upsert({
        where: { tenantId_code: { tenantId: testTenantId, code: ROLE_CODE_TEST } },
        update: {},
        create: {
          tenantId: testTenantId,
          code: ROLE_CODE_TEST,
          nameAr: 'rls-test',
          nameEn: 'rls-test',
          level: 1,
        },
      }),
    );
  });

  after(async () => {
    // Tear down test tenant; cascading FKs delete its roles + mappings.
    await prisma.tenant.delete({ where: { code: TEST_TENANT_CODE } }).catch(() => {});
    // Clean up the default-tenant probe role.
    await withTenant(defaultTenantId, (tx) =>
      tx.role.deleteMany({ where: { code: ROLE_CODE_DEFAULT } }),
    ).catch(() => {});
    await prisma.$disconnect();
  });

  it('reading roles without an app.tenant_id GUC returns 0 rows (FORCE RLS denies)', async () => {
    // No transaction wrapper, no SET LOCAL — simulates a misbehaving query.
    const rows = await prisma.role.findMany({
      where: { code: { in: [ROLE_CODE_DEFAULT, ROLE_CODE_TEST] } },
    });
    assert.equal(rows.length, 0, 'queries without tenant context must see no rows');
  });

  it('reading roles under default tenant only returns the default probe', async () => {
    const rows = await withTenant(defaultTenantId, (tx) =>
      tx.role.findMany({
        where: { code: { in: [ROLE_CODE_DEFAULT, ROLE_CODE_TEST] } },
      }),
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.code, ROLE_CODE_DEFAULT);
  });

  it('reading roles under test tenant only returns the test probe', async () => {
    const rows = await withTenant(testTenantId, (tx) =>
      tx.role.findMany({
        where: { code: { in: [ROLE_CODE_DEFAULT, ROLE_CODE_TEST] } },
      }),
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.code, ROLE_CODE_TEST);
  });

  it('inserting with a foreign tenant_id is rejected by the WITH CHECK policy', async () => {
    let threw = false;
    try {
      await withTenant(testTenantId, async (tx) => {
        // GUC is testTenantId but we attempt to write a row for defaultTenantId.
        await tx.role.create({
          data: {
            tenantId: defaultTenantId,
            code: '__rls_attack__',
            nameAr: 'attack',
            nameEn: 'attack',
            level: 0,
          },
        });
      });
    } catch (err) {
      threw = true;
      // Expected: Postgres "new row violates row-level security policy"
      assert.match(
        String((err as Error).message),
        /row-level security|row level security|violates/i,
      );
    }
    assert.equal(threw, true, 'cross-tenant insert must throw');
  });
});
