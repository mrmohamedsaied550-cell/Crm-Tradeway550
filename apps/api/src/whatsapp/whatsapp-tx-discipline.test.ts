/**
 * C28 — transaction-discipline invariant for the WhatsApp service.
 *
 * The audit flagged "external HTTP calls inside DB transactions" as a
 * pool-starvation risk. The current `WhatsAppService.sendText` and
 * `WhatsAppAccountsService.runTest` already follow the right pattern:
 *
 *   READ tx (closes immediately)
 *     → external provider call (no DB tx)
 *     → WRITE tx (only for sendText, also short-lived)
 *
 * This file locks that property in. We instrument `PrismaService` with
 * a subclass that records `(start, end)` timestamps for every
 * `withTenant` invocation, and a fake provider fetch that records its
 * own `(start, end)`. After each operation we assert:
 *
 *   no `withTenant` interval overlaps the provider's call interval.
 *
 * Any future refactor that accidentally awaits a provider response
 * inside a `withTenant` block will fail these tests.
 *
 * The suite also covers the persistence-on-failure contract:
 *   - if the provider throws, no outbound message row is created.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { MetaCloudProvider, type FetchFn } from './meta-cloud.provider';
import { WhatsAppService } from './whatsapp.service';
import { WhatsAppAccountsService } from './whatsapp-accounts.service';

const TENANT_CODE = '__c28_tx__';

interface Interval {
  start: number;
  end: number;
}

class RecordingPrismaService extends PrismaService {
  readonly txIntervals: Interval[] = [];
  reset(): void {
    this.txIntervals.length = 0;
  }
  override async withTenant<T>(
    tenantId: string,
    fn: Parameters<PrismaService['withTenant']>[1],
  ): Promise<T> {
    const start = Date.now();
    try {
      return (await super.withTenant(tenantId, fn)) as T;
    } finally {
      this.txIntervals.push({ start, end: Date.now() });
    }
  }
}

function intervalsOverlap(a: Interval, b: Interval): boolean {
  // Half-open: an interval that ends exactly when another starts is OK.
  return a.start < b.end && b.start < a.end;
}

let prisma: PrismaClient;
let prismaSvc: RecordingPrismaService;
let svc: WhatsAppService;
let accounts: WhatsAppAccountsService;
let tenantId: string;
let accountId: string;
let providerInterval: Interval | null = null;

const FETCH_DELAY_MS = 40; // long enough to make any tx-overlap visible

const slowFakeFetch: FetchFn = async (url, init) => {
  const start = Date.now();
  await new Promise((r) => setTimeout(r, FETCH_DELAY_MS));
  // Different shape per endpoint — same pattern the C24A test uses.
  if (init?.method === 'POST' && url.includes('/messages')) {
    const end = Date.now();
    providerInterval = { start, end };
    return {
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({ messages: [{ id: `wamid.C28.${Math.random()}` }] }),
    };
  }
  // testConnection
  const end = Date.now();
  providerInterval = { start, end };
  return {
    ok: true,
    status: 200,
    text: async () => '',
    json: async () => ({
      display_phone_number: '+201111000200',
      verified_name: 'C28 Tx Discipline',
    }),
  };
};

describe('whatsapp — transaction discipline invariants (C28)', () => {
  before(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    prismaSvc = new RecordingPrismaService();
    const provider = new MetaCloudProvider(slowFakeFetch);
    svc = new WhatsAppService(prismaSvc, provider);
    accounts = new WhatsAppAccountsService(prismaSvc, svc);

    const tenant = await prisma.tenant.upsert({
      where: { code: TENANT_CODE },
      update: { isActive: true },
      create: { code: TENANT_CODE, name: 'C28 tx-discipline tenant' },
    });
    tenantId = tenant.id;

    const account = await prismaSvc.withTenant<{ id: string }>(tenantId, (tx) =>
      tx.whatsAppAccount.upsert({
        where: { phoneNumberId: 'PNID-C28-1' },
        update: {},
        create: {
          tenantId,
          displayName: 'C28 Account',
          phoneNumber: '+201111000200',
          phoneNumberId: 'PNID-C28-1',
          provider: 'meta_cloud',
          accessToken: 'live-token',
          appSecret: 'live-app-secret',
          verifyToken: 'verify-c28-aa',
        },
        select: { id: true },
      }),
    );
    accountId = account.id;
  });

  after(async () => {
    await prisma.tenant.delete({ where: { code: TENANT_CODE } }).catch(() => {});
    await prisma.$disconnect();
  });

  it('sendText: no withTenant interval overlaps the provider HTTP call', async () => {
    prismaSvc.reset();
    providerInterval = null;
    await svc.sendText({
      tenantId,
      accountId,
      to: '+201001100200',
      text: 'C28 outbound',
    });
    assert.ok(providerInterval, 'provider was called');
    const overlapping = prismaSvc.txIntervals.filter((iv) =>
      intervalsOverlap(iv, providerInterval as Interval),
    );
    assert.equal(
      overlapping.length,
      0,
      `${overlapping.length} withTenant interval(s) overlapped the provider call — regressed back inside a DB transaction`,
    );
    // Sanity: we expect at least 2 distinct withTenant calls (read + write).
    assert.ok(prismaSvc.txIntervals.length >= 2);
  });

  it('runTest: no withTenant interval overlaps the provider HTTP call', async () => {
    // Need a fresh account for a clean test run.
    const created = await accounts.create(tenantId, {
      displayName: 'C28 runTest',
      phoneNumber: '+201001100201',
      phoneNumberId: 'PNID-C28-runtest',
      provider: 'meta_cloud',
      accessToken: 'live-token-2',
      appSecret: 'live-app-secret-2',
      verifyToken: 'verify-c28-bb',
    });
    prismaSvc.reset();
    providerInterval = null;

    const result = await accounts.runTest(tenantId, created.id);
    assert.equal(result.ok, true);
    assert.ok(providerInterval, 'provider was called');
    const overlapping = prismaSvc.txIntervals.filter((iv) =>
      intervalsOverlap(iv, providerInterval as Interval),
    );
    assert.equal(
      overlapping.length,
      0,
      `${overlapping.length} withTenant interval(s) overlapped the provider call`,
    );
    assert.ok(prismaSvc.txIntervals.length >= 1);
  });

  it('sendText: provider failure does not persist an outbound message row', async () => {
    // Swap in a failing provider for this single test by constructing a
    // fresh service. The shared `svc` keeps the slow-but-OK provider.
    const failingFetch: FetchFn = async () => {
      throw new Error('whatsapp_send_failed:simulated');
    };
    const failingProvider = new MetaCloudProvider(failingFetch);
    const failingSvc = new WhatsAppService(prismaSvc, failingProvider);

    const beforeCount = await prismaSvc.withTenant(tenantId, (tx) =>
      tx.whatsAppMessage.count({ where: { phone: '+201001100299', direction: 'outbound' } }),
    );

    await assert.rejects(() =>
      failingSvc.sendText({
        tenantId,
        accountId,
        to: '+201001100299',
        text: 'should not persist',
      }),
    );

    const afterCount = await prismaSvc.withTenant(tenantId, (tx) =>
      tx.whatsAppMessage.count({ where: { phone: '+201001100299', direction: 'outbound' } }),
    );
    assert.equal(
      afterCount,
      beforeCount,
      'provider failure must not produce a persisted outbound message',
    );
  });
});
