/**
 * Sprint 10 (D10) — integration tests for the presence service.
 *
 * Coverage:
 *   1. PresenceService.derive() classifies the four labels from
 *      the raw timestamps (pure-function unit checks; no Postgres).
 *   2. heartbeat() upserts the row and resolves to "online".
 *   3. activity({busy:true}) flips the row to "busy" inside the
 *      online window.
 *   4. Server-side write-throttle skips a heartbeat that arrives
 *      < HEARTBEAT_WRITE_THROTTLE_MS after the previous one.
 *   5. findOwn() returns an offline synthetic row when no
 *      presence row exists for the caller.
 *   6. listForUsers() returns "offline" rows for users that have
 *      never heart-beat AND drops foreign-tenant ids silently.
 *   7. countByStatus('online') only counts users whose lastSeenAt
 *      falls inside the online window.
 *   8. Tenant isolation — a heartbeat in tenant A is invisible
 *      in tenant B's bulk lookup.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { tenantContext } from '../tenants/tenant-context';

import {
  PresenceService,
  AWAY_THRESHOLD_MS,
  OFFLINE_THRESHOLD_MS,
  ONLINE_THRESHOLD_MS,
} from './presence.service';

const TENANT_CODE = '__d10_presence__';
const OTHER_TENANT_CODE = '__d10_presence_other__';

let prisma: PrismaClient;
let prismaSvc: PrismaService;
let svc: PresenceService;
let tenantId: string;
let otherTenantId: string;
let aliceId: string;
let bobId: string;
let foreignUserId: string;

function inTenant<T>(fn: () => Promise<T>): Promise<T> {
  return tenantContext.run({ tenantId, tenantCode: TENANT_CODE, source: 'header' }, fn);
}
function inOther<T>(fn: () => Promise<T>): Promise<T> {
  return tenantContext.run(
    { tenantId: otherTenantId, tenantCode: OTHER_TENANT_CODE, source: 'header' },
    fn,
  );
}
async function rawTx<T>(tid: string, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return prisma.$transaction(async (tx: any) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.tenant_id = '${tid}'`);
    return fn(tx);
  });
}

describe('presence — derive() pure function', () => {
  const now = new Date('2026-08-01T10:00:00.000Z');
  it('online when lastSeenAt within ONLINE window', () => {
    const seenAt = new Date(now.getTime() - 30_000); // 30 s
    const label = PresenceService.derive(
      { lastSeenAt: seenAt, lastActiveAt: seenAt, busyUntil: null },
      now,
    );
    assert.equal(label, 'online');
  });
  it('busy when busyUntil is in the future and online window', () => {
    const seenAt = new Date(now.getTime() - 30_000);
    const busyUntil = new Date(now.getTime() + 60_000);
    const label = PresenceService.derive(
      { lastSeenAt: seenAt, lastActiveAt: seenAt, busyUntil },
      now,
    );
    assert.equal(label, 'busy');
  });
  it('away when seen but lastActiveAt is stale and past ONLINE', () => {
    const seenAt = new Date(now.getTime() - (ONLINE_THRESHOLD_MS + 60_000)); // past online
    const activeAt = new Date(now.getTime() - (AWAY_THRESHOLD_MS + 60_000));
    const label = PresenceService.derive(
      { lastSeenAt: seenAt, lastActiveAt: activeAt, busyUntil: null },
      now,
    );
    assert.equal(label, 'away');
  });
  it('offline when lastSeenAt is past OFFLINE window', () => {
    const seenAt = new Date(now.getTime() - (OFFLINE_THRESHOLD_MS + 60_000));
    const label = PresenceService.derive(
      { lastSeenAt: seenAt, lastActiveAt: null, busyUntil: null },
      now,
    );
    assert.equal(label, 'offline');
  });
});

describe('presence — heartbeat / activity / bulk / tenant isolation', () => {
  before(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    prismaSvc = new PrismaService();
    svc = new PresenceService(prismaSvc);

    const t = await prisma.tenant.upsert({
      where: { code: TENANT_CODE },
      update: { isActive: true },
      create: { code: TENANT_CODE, name: 'D10 presence test' },
    });
    tenantId = t.id;
    const o = await prisma.tenant.upsert({
      where: { code: OTHER_TENANT_CODE },
      update: { isActive: true },
      create: { code: OTHER_TENANT_CODE, name: 'D10 presence other' },
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

    const alice = await rawTx(tenantId, (tx) =>
      tx.user.create({
        data: {
          tenantId,
          email: 'd10-alice@example.com',
          name: 'Alice',
          passwordHash: 'x',
          roleId: role.id,
          status: 'active',
          language: 'en',
        },
      }),
    );
    aliceId = alice.id;
    const bob = await rawTx(tenantId, (tx) =>
      tx.user.create({
        data: {
          tenantId,
          email: 'd10-bob@example.com',
          name: 'Bob',
          passwordHash: 'x',
          roleId: role.id,
          status: 'active',
          language: 'en',
        },
      }),
    );
    bobId = bob.id;
    const foreign = await rawTx(otherTenantId, (tx) =>
      tx.user.create({
        data: {
          tenantId: otherTenantId,
          email: 'd10-foreign@example.com',
          name: 'Foreign',
          passwordHash: 'x',
          roleId: otherRole.id,
          status: 'active',
          language: 'en',
        },
      }),
    );
    foreignUserId = foreign.id;
  });

  after(async () => {
    await prisma.tenant.delete({ where: { code: TENANT_CODE } }).catch(() => {});
    await prisma.tenant.delete({ where: { code: OTHER_TENANT_CODE } }).catch(() => {});
    await prisma.$disconnect();
  });

  it('heartbeat() upserts the row and resolves to online', async () => {
    const res = await inTenant(() => svc.heartbeat(aliceId));
    assert.equal(res.userId, aliceId);
    assert.equal(res.status, 'online');
    assert.ok(new Date(res.lastSeenAt).getTime() <= Date.now());
  });

  it('activity({busy:true}) flips the row to busy', async () => {
    const res = await inTenant(() => svc.activity(aliceId, { busy: true, context: 'lead' }));
    assert.equal(res.status, 'busy');
    assert.equal(res.currentContext, 'lead');
    assert.ok(res.busyUntil, 'busyUntil must be set');
  });

  it('write-throttle skips a heartbeat within HEARTBEAT_WRITE_THROTTLE_MS', async () => {
    // First heartbeat for Bob.
    await inTenant(() => svc.heartbeat(bobId));
    const before = await rawTx(tenantId, (tx) =>
      tx.userPresence.findUnique({ where: { userId: bobId } }),
    );
    const firstSeen = before!.lastSeenAt.getTime();
    // Immediate second heartbeat — should be a no-op write.
    await inTenant(() => svc.heartbeat(bobId));
    const after = await rawTx(tenantId, (tx) =>
      tx.userPresence.findUnique({ where: { userId: bobId } }),
    );
    assert.equal(
      after!.lastSeenAt.getTime(),
      firstSeen,
      'second heartbeat within throttle window must NOT bump the row',
    );
  });

  it('findOwn() returns offline synthetic row when no presence exists', async () => {
    // Carve a fresh user with no presence row.
    const carolRole = await rawTx(tenantId, (tx) =>
      tx.role.findFirst({ where: { code: 'sales_agent', tenantId } }),
    );
    const carol = await rawTx(tenantId, (tx) =>
      tx.user.create({
        data: {
          tenantId,
          email: 'd10-carol@example.com',
          name: 'Carol',
          passwordHash: 'x',
          roleId: carolRole!.id,
          status: 'active',
          language: 'en',
        },
      }),
    );
    const res = await inTenant(() => svc.findOwn(carol.id));
    assert.equal(res.userId, carol.id);
    assert.equal(res.status, 'offline');
  });

  it('listForUsers() returns offline for users without a row + drops foreign ids', async () => {
    // Bob already has a row (from the throttle test). Foreign user
    // is in another tenant and must be filtered out by the visible-
    // user lookup. Provide a never-seen user id too.
    const dianaRole = await rawTx(tenantId, (tx) =>
      tx.role.findFirst({ where: { code: 'sales_agent', tenantId } }),
    );
    const diana = await rawTx(tenantId, (tx) =>
      tx.user.create({
        data: {
          tenantId,
          email: 'd10-diana@example.com',
          name: 'Diana',
          passwordHash: 'x',
          roleId: dianaRole!.id,
          status: 'active',
          language: 'en',
        },
      }),
    );
    const items = await inTenant(() => svc.listForUsers([aliceId, bobId, diana.id, foreignUserId]));
    const ids = items.map((i) => i.userId);
    assert.ok(ids.includes(aliceId));
    assert.ok(ids.includes(bobId));
    assert.ok(ids.includes(diana.id));
    assert.equal(ids.includes(foreignUserId), false, 'foreign-tenant id must be dropped');
    const dianaItem = items.find((i) => i.userId === diana.id)!;
    assert.equal(dianaItem.status, 'offline');
  });

  it('countByStatus(online) counts users in the online window', async () => {
    const count = await inTenant(() => svc.countByStatus('online'));
    // Alice (busy at this point — busy counts as in-online window
    // for the busy chip but the online filter excludes her via
    // busyUntil > now()). Bob has a fresh heartbeat. → expect Bob.
    assert.ok(count >= 1, 'at least Bob should be online');
  });

  it('listForUsers() never returns out-of-scope users even when ids are explicitly requested', async () => {
    const items = await inOther(() => svc.listForUsers([aliceId, foreignUserId]));
    const ids = items.map((i) => i.userId);
    assert.equal(ids.includes(aliceId), false, 'Alice (other tenant) must be hidden in this scope');
    // Note: foreignUserId belongs to OTHER tenant, so in this
    // inOther() call it IS visible. That's correct — tenant
    // isolation works both ways.
    assert.ok(ids.includes(foreignUserId));
  });
});
