/**
 * Phase D2 — D2.4: tenant duplicate-rules service tests.
 *
 * Real Postgres + throwaway tenant. Exercises:
 *   - getDuplicateRules returns the locked product defaults when
 *     the JSON column is NULL (every existing tenant).
 *   - updateDuplicateRules persists a partial PATCH and merges with
 *     the current value (not the defaults), so subsequent partials
 *     don't silently revert previously-set fields.
 *   - audit row `tenant.duplicate_rules.update` written with
 *     before / after / changedFields payload.
 *   - Zod validation rejects negative day counts and unknown enums.
 *
 * Local: cancelled by the same DB-unreachable hook-failure pattern
 * as every other integration test in the repo when no Docker
 * daemon is available; CI runs against postgres:16-alpine.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { DEFAULT_DUPLICATE_RULES, DuplicateRulesSchema } from '../duplicates/duplicate-rules.dto';
import { PrismaService } from '../prisma/prisma.service';
import { tenantContext } from './tenant-context';
import { TenantSettingsService } from './tenant-settings.service';

const TENANT_CODE = '__d24_dup_rules__';

let prisma: PrismaClient;
let prismaSvc: PrismaService;
let settings: TenantSettingsService;
let tenantId: string;
let actorUserId: string;

function inTenant<T>(fn: () => Promise<T>): Promise<T> {
  return tenantContext.run({ tenantId, tenantCode: TENANT_CODE, source: 'header' }, fn);
}

async function withTenantRaw<T>(tid: string, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return prisma.$transaction(async (tx: any) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.tenant_id = '${tid}'`);
    return fn(tx);
  });
}

describe('D2.4 — TenantSettings.duplicateRules', () => {
  before(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    prismaSvc = new PrismaService();
    const audit = new AuditService(prismaSvc);
    settings = new TenantSettingsService(prismaSvc, audit);

    const tenant = await prisma.tenant.upsert({
      where: { code: TENANT_CODE },
      update: { isActive: true },
      create: { code: TENANT_CODE, name: 'D2.4 dup rules' },
    });
    tenantId = tenant.id;

    await withTenantRaw(tenantId, async (tx) => {
      const role = await tx.role.create({
        data: {
          tenantId,
          code: 'sales_agent',
          nameAr: 'مبيعات',
          nameEn: 'Sales',
          level: 30,
        },
      });
      const actor = await tx.user.create({
        data: {
          tenantId,
          email: 'd24-actor@test',
          name: 'D24 Actor',
          // gitleaks-ignore: low-entropy test fixture, not a real secret.
          passwordHash: 'TESTHASH',
          status: 'active',
          roleId: role.id,
        },
      });
      actorUserId = actor.id;
    });
  });

  after(async () => {
    await prisma.tenant.delete({ where: { code: TENANT_CODE } }).catch(() => {});
    await prisma.$disconnect();
  });

  it('GET returns defaults when duplicateRules is NULL', async () => {
    const config = await inTenant(() => settings.getDuplicateRules());
    assert.deepEqual(config, DEFAULT_DUPLICATE_RULES);
  });

  it('PATCH writes a partial change and persists the rest', async () => {
    await inTenant(() =>
      settings.updateDuplicateRules({ reactivateLostAfterDays: 60 }, actorUserId),
    );
    const cur = await inTenant(() => settings.getDuplicateRules());
    assert.equal(cur.reactivateLostAfterDays, 60);
    // Other fields keep the defaults.
    assert.equal(cur.reactivateNoAnswerAfterDays, 7);
    assert.equal(cur.captainBehavior, 'always_review');
    assert.equal(cur.ownershipOnReactivation, 'route_engine');
    assert.equal(cur.crossPipelineMatch, false);
  });

  it('PATCH merges over the previously-set value, not over defaults', async () => {
    // First PATCH set reactivateLostAfterDays=60. Now toggle a
    // different field; the previous value MUST persist.
    await inTenant(() =>
      settings.updateDuplicateRules({ ownershipOnReactivation: 'previous_owner' }, actorUserId),
    );
    const cur = await inTenant(() => settings.getDuplicateRules());
    assert.equal(cur.reactivateLostAfterDays, 60, 'previous value must not revert to default');
    assert.equal(cur.ownershipOnReactivation, 'previous_owner');
  });

  it('PATCH writes a tenant.duplicate_rules.update audit row with before/after/changedFields', async () => {
    const beforeCount = await withTenantRaw(tenantId, (tx) =>
      tx.auditEvent.count({
        where: { tenantId, action: 'tenant.duplicate_rules.update' },
      }),
    );

    await inTenant(() => settings.updateDuplicateRules({ crossPipelineMatch: true }, actorUserId));

    const afterCount = await withTenantRaw(tenantId, (tx) =>
      tx.auditEvent.count({
        where: { tenantId, action: 'tenant.duplicate_rules.update' },
      }),
    );
    assert.equal(afterCount, beforeCount + 1);

    const row = await withTenantRaw(tenantId, (tx) =>
      tx.auditEvent.findFirst({
        where: { tenantId, action: 'tenant.duplicate_rules.update' },
        orderBy: { createdAt: 'desc' },
      }),
    );
    assert.ok(row, 'audit row must exist');
    const payload = row!.payload as Record<string, unknown>;
    const changed = payload['changedFields'] as string[];
    assert.deepEqual(changed, ['crossPipelineMatch']);
    const after = payload['after'] as Record<string, unknown>;
    assert.equal(after['crossPipelineMatch'], true);
    const before = payload['before'] as Record<string, unknown>;
    assert.equal(before['crossPipelineMatch'], false);
  });

  it('Zod schema rejects negative day counts', () => {
    const result = DuplicateRulesSchema.safeParse({ reactivateLostAfterDays: -1 });
    assert.equal(result.success, false);
  });

  it('Zod schema rejects unknown enum values', () => {
    const result = DuplicateRulesSchema.safeParse({ ownershipOnReactivation: 'random_value' });
    assert.equal(result.success, false);
  });

  it('Zod schema accepts a valid full payload', () => {
    const result = DuplicateRulesSchema.safeParse({
      reactivateLostAfterDays: 14,
      reactivateNoAnswerAfterDays: 3,
      reactivateNoAnswerLostReasonCodes: ['no_answer'],
      captainBehavior: 'always_review',
      wonBehavior: 'always_review',
      ownershipOnReactivation: 'previous_owner',
      crossPipelineMatch: false,
    });
    assert.equal(result.success, true);
  });
});
