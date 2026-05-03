/**
 * Phase 1A — A2: backfill verification.
 *
 * Migration `0027_distribution_backfill` walks every tenant's legacy
 * `tenant_settings.distribution_rules` JSONB column and writes one
 * `distribution_rules` row per entry as a `specific_user` strategy
 * rule. The migration is idempotent — re-running inserts nothing
 * because of a NOT EXISTS guard on
 * (tenant_id, strategy, source, target_user_id).
 *
 * This test exercises the SAME backfill SQL on a throwaway tenant so
 * we have a regression check that survives any future schema move.
 * The SQL is duplicated here verbatim from the migration; if the
 * migration changes shape, this test (and `BACKFILL_INSERT_SQL` /
 * `runBackfill` below) must be updated together.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';

import { hashPassword } from '../identity/password.util';

const TENANT_CODE = '__a2_backfill_test__';

/**
 * Verbatim copy of the body of
 * prisma/migrations/20260507100000_0027_distribution_backfill/migration.sql,
 * minus the surrounding ALTER TABLE NO FORCE / FORCE toggles
 * (which the test reproduces in raw $executeRawUnsafe calls so the
 * test isn't tied to migration-application transactional semantics).
 *
 * Running this against the same DB the migration already touched is
 * the regression check: the second pass MUST be a no-op because of
 * the NOT EXISTS guard.
 */
const BACKFILL_INSERT_SQL = `
INSERT INTO "distribution_rules" (
  "tenant_id", "name", "is_active", "priority",
  "source", "company_id", "country_id", "target_team_id",
  "strategy", "target_user_id",
  "created_at", "updated_at", "created_by_id"
)
SELECT
  ts.tenant_id,
  'Legacy (PL-3): source=' || (elem->>'source'),
  TRUE, 100,
  elem->>'source',
  NULL, NULL, NULL,
  'specific_user',
  (elem->>'assigneeUserId')::uuid,
  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL
FROM "tenant_settings" ts,
     jsonb_array_elements(ts."distribution_rules") elem
WHERE jsonb_typeof(ts."distribution_rules") = 'array'
  AND elem ? 'source'
  AND elem ? 'assigneeUserId'
  AND elem->>'source'         IS NOT NULL
  AND elem->>'assigneeUserId' IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "distribution_rules" dr
    WHERE dr."tenant_id"      = ts.tenant_id
      AND dr."strategy"       = 'specific_user'
      AND dr."source"         = (elem->>'source')
      AND dr."target_user_id" = (elem->>'assigneeUserId')::uuid
  );
`;

/** Wraps the INSERT in the same NO-FORCE / FORCE toggle the migration uses. */
async function runBackfill(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(`ALTER TABLE "tenant_settings"   NO FORCE ROW LEVEL SECURITY`);
  await prisma.$executeRawUnsafe(`ALTER TABLE "distribution_rules" NO FORCE ROW LEVEL SECURITY`);
  try {
    await prisma.$executeRawUnsafe(BACKFILL_INSERT_SQL);
  } finally {
    // Always restore — even if the INSERT throws, we don't want to
    // leave the dev DB unprotected.
    await prisma.$executeRawUnsafe(`ALTER TABLE "distribution_rules" FORCE ROW LEVEL SECURITY`);
    await prisma.$executeRawUnsafe(`ALTER TABLE "tenant_settings"    FORCE ROW LEVEL SECURITY`);
  }
}

let prisma: PrismaClient;
let tenantId: string;
let aliceId: string;
let bobId: string;
let carolId: string;

/**
 * Wrap a fn in `set_config('app.tenant_id', ...)` so RLS-protected
 * reads/writes succeed. Mirrors the application's
 * `prisma.withTenant` pattern.
 */
async function inTenant<T>(tid: string, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return prisma.$transaction(async (tx: any) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.tenant_id = '${tid}'`);
    return fn(tx);
  });
}

describe('A2 — distribution_rules backfill from legacy JSONB', () => {
  before(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();

    // Throwaway tenant + role + 3 users.
    const tenant = await prisma.tenant.upsert({
      where: { code: TENANT_CODE },
      update: { isActive: true },
      create: { code: TENANT_CODE, name: 'A2 backfill test tenant' },
    });
    tenantId = tenant.id;

    const hash = await hashPassword('Password@123', 4);

    await inTenant(tenantId, async (tx) => {
      const role = await tx.role.upsert({
        where: { tenantId_code: { tenantId, code: 'sales_agent' } },
        update: {},
        create: {
          tenantId,
          code: 'sales_agent',
          nameAr: 'وكيل',
          nameEn: 'Sales Agent',
          level: 30,
        },
      });
      const alice = await tx.user.upsert({
        where: { tenantId_email: { tenantId, email: '__a2_alice@test' } },
        update: {},
        create: {
          tenantId,
          email: '__a2_alice@test',
          name: 'Alice',
          passwordHash: hash,
          roleId: role.id,
        },
      });
      const bob = await tx.user.upsert({
        where: { tenantId_email: { tenantId, email: '__a2_bob@test' } },
        update: {},
        create: {
          tenantId,
          email: '__a2_bob@test',
          name: 'Bob',
          passwordHash: hash,
          roleId: role.id,
        },
      });
      const carol = await tx.user.upsert({
        where: { tenantId_email: { tenantId, email: '__a2_carol@test' } },
        update: {},
        create: {
          tenantId,
          email: '__a2_carol@test',
          name: 'Carol',
          passwordHash: hash,
          roleId: role.id,
        },
      });
      aliceId = alice.id;
      bobId = bob.id;
      carolId = carol.id;
    });
  });

  after(async () => {
    // Cascading delete via tenant.
    await prisma.tenant.delete({ where: { code: TENANT_CODE } }).catch(() => {});
    await prisma.$disconnect();
  });

  it('first pass: inserts one specific_user rule per legacy JSONB entry', async () => {
    // Plant 3 legacy JSONB rules into the test tenant's settings.
    await inTenant(tenantId, async (tx) => {
      await tx.tenantSettings.upsert({
        where: { tenantId },
        update: {
          distributionRules: [
            { source: 'meta', assigneeUserId: aliceId },
            { source: 'tiktok', assigneeUserId: bobId },
            { source: 'whatsapp', assigneeUserId: carolId },
          ] as unknown as object,
        },
        create: {
          tenantId,
          distributionRules: [
            { source: 'meta', assigneeUserId: aliceId },
            { source: 'tiktok', assigneeUserId: bobId },
            { source: 'whatsapp', assigneeUserId: carolId },
          ] as unknown as object,
        },
      });
    });

    // Run the backfill SQL (it walks every tenant; our test tenant is
    // the only one with non-empty legacy rules in the test DB lifecycle).
    await runBackfill(prisma);

    const rules = await inTenant(tenantId, (tx) =>
      tx.distributionRule.findMany({
        where: { tenantId, strategy: 'specific_user' },
        orderBy: { source: 'asc' },
      }),
    );

    assert.equal(rules.length, 3, 'expected 3 backfilled rules');

    const expected = [
      { source: 'meta', target: aliceId },
      { source: 'tiktok', target: bobId },
      { source: 'whatsapp', target: carolId },
    ];
    for (const want of expected) {
      const got = rules.find((r) => r.source === want.source);
      assert.ok(got, `missing rule for source=${want.source}`);
      assert.equal(got!.targetUserId, want.target, `wrong target for source=${want.source}`);
      assert.equal(got!.strategy, 'specific_user');
      assert.equal(got!.priority, 100);
      assert.equal(got!.isActive, true);
      assert.equal(got!.companyId, null);
      assert.equal(got!.countryId, null);
      assert.equal(got!.targetTeamId, null);
      assert.equal(got!.name, `Legacy (PL-3): source=${want.source}`);
    }
  });

  it('second pass: idempotent — re-running inserts no duplicates', async () => {
    const before = await inTenant(tenantId, (tx) =>
      tx.distributionRule.count({ where: { tenantId, strategy: 'specific_user' } }),
    );

    await runBackfill(prisma);

    const after = await inTenant(tenantId, (tx) =>
      tx.distributionRule.count({ where: { tenantId, strategy: 'specific_user' } }),
    );

    assert.equal(after, before, 'second pass must NOT insert duplicates');
  });

  it('third pass: tolerates an admin-created equivalent rule', async () => {
    // Simulate an admin manually adding the same source+user via the
    // (future) admin UI before the migration runs again. The NOT EXISTS
    // guard must skip the JSONB entry rather than dupe it.
    await inTenant(tenantId, async (tx) => {
      await tx.distributionRule.create({
        data: {
          tenantId,
          name: 'Manually added duplicate of Meta rule',
          strategy: 'specific_user',
          source: 'meta',
          targetUserId: aliceId,
          priority: 50, // higher precedence than the legacy 100
        },
      });
    });

    await runBackfill(prisma);

    const metaRules = await inTenant(tenantId, (tx) =>
      tx.distributionRule.findMany({
        where: { tenantId, strategy: 'specific_user', source: 'meta' },
        orderBy: { priority: 'asc' },
      }),
    );

    // Exactly 2: the admin-created (priority=50) + the original legacy
    // (priority=100). NOT EXISTS prevented a third copy of the legacy.
    assert.equal(metaRules.length, 2);
    assert.equal(metaRules[0]?.priority, 50);
    assert.equal(metaRules[1]?.priority, 100);
  });

  it('fourth pass: ignores malformed JSONB entries (missing required keys)', async () => {
    // Update the JSONB to include a malformed entry. The backfill
    // should skip it instead of erroring out.
    await inTenant(tenantId, async (tx) => {
      await tx.tenantSettings.update({
        where: { tenantId },
        data: {
          distributionRules: [
            { source: 'meta', assigneeUserId: aliceId },
            { source: 'manual' }, // missing assigneeUserId
            { assigneeUserId: bobId }, // missing source
          ] as unknown as object,
        },
      });
    });

    const before = await inTenant(tenantId, (tx) =>
      tx.distributionRule.count({ where: { tenantId, strategy: 'specific_user' } }),
    );

    await runBackfill(prisma);

    const after = await inTenant(tenantId, (tx) =>
      tx.distributionRule.count({ where: { tenantId, strategy: 'specific_user' } }),
    );

    // No new rows: the meta entry already exists (idempotence), and
    // both malformed entries are skipped by `WHERE elem ? 'source'
    // AND elem ? 'assigneeUserId'`.
    assert.equal(after, before, 'malformed entries must be skipped without errors');
  });
});
