/**
 * P2-05 — end-to-end integration tests for WhatsApp access-token
 * encryption.
 *
 * Real Postgres + a throwaway tenant. Verifies:
 *   1. Service write encrypts: the raw column carries `v1:` ciphertext.
 *   2. Service read decrypts at the point of use: `runTest` hands the
 *      original plaintext to the provider via Bearer header.
 *   3. Legacy plaintext rows (planted directly via Prisma to simulate
 *      a pre-P2-05 deploy) are still decryptable by the read path.
 *      That's the contract that lets the bulk re-encrypt script run
 *      lazily — apps don't break before it does.
 *   4. The bulk re-encrypt path encrypts only plaintext rows and is
 *      idempotent (re-runs are no-ops).
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';

import {
  decryptSecret,
  encryptSecret,
  isFieldEncrypted,
  loadFieldEncryptionKey,
} from '../common/crypto';
import { PrismaService } from '../prisma/prisma.service';
import { MetaCloudProvider, type FetchFn } from './meta-cloud.provider';
import { WhatsAppAccountsService } from './whatsapp-accounts.service';
import { WhatsAppService } from './whatsapp.service';

const TENANT_CODE = '__p2_05_token_encrypt__';

let prisma: PrismaClient;
let prismaSvc: PrismaService;
let svc: WhatsAppAccountsService;
let tenantId: string;

let lastFetch: { url: string; init?: RequestInit | undefined } | null = null;
const fakeFetch: FetchFn = async (url, init) => {
  lastFetch = { url, init };
  return {
    ok: true,
    status: 200,
    text: async () => '',
    json: async () => ({ display_phone_number: '+201000000000', verified_name: 'X' }),
  };
};

async function withTenantRaw<T>(tid: string, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return prisma.$transaction(async (tx: any) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.tenant_id = '${tid}'`);
    return fn(tx);
  });
}

describe('whatsapp — access-token encryption (P2-05)', () => {
  before(async () => {
    // Force the key cache so every test in this run uses the same
    // bytes (otherwise the dev fallback would generate a fresh key
    // and the legacy-plaintext test below would still pass — but
    // for the wrong reason).
    loadFieldEncryptionKey();
    prisma = new PrismaClient();
    await prisma.$connect();
    prismaSvc = new PrismaService();
    const provider = new MetaCloudProvider(fakeFetch);
    const wa = new WhatsAppService(prismaSvc, provider);
    svc = new WhatsAppAccountsService(prismaSvc, wa);

    const tenant = await prisma.tenant.upsert({
      where: { code: TENANT_CODE },
      update: { isActive: true },
      create: { code: TENANT_CODE, name: 'P2-05 token encryption' },
    });
    tenantId = tenant.id;
  });

  after(async () => {
    await prisma.tenant.delete({ where: { code: TENANT_CODE } }).catch(() => {});
    await prisma.$disconnect();
  });

  it('create stores `access_token` as v1: ciphertext, not plaintext', async () => {
    const view = await svc.create(tenantId, {
      displayName: 'P2-05 create',
      phoneNumber: '+201111200001',
      phoneNumberId: 'PNID-P2-05-1',
      provider: 'meta_cloud',
      accessToken: 'plaintext-create-token',
      verifyToken: 'verify-create',
    });
    const raw = await withTenantRaw(tenantId, (tx) =>
      tx.whatsAppAccount.findUnique({
        where: { id: view.id },
        select: { accessToken: true },
      }),
    );
    assert.ok(raw);
    assert.equal(isFieldEncrypted(raw.accessToken), true);
    assert.notEqual(raw.accessToken, 'plaintext-create-token');
    assert.equal(decryptSecret(raw.accessToken), 'plaintext-create-token');
  });

  it('update encrypts a rotated token', async () => {
    const created = await svc.create(tenantId, {
      displayName: 'P2-05 rotate',
      phoneNumber: '+201111200002',
      phoneNumberId: 'PNID-P2-05-2',
      provider: 'meta_cloud',
      accessToken: 'first',
      verifyToken: 'verify-rotate',
    });
    await svc.update(tenantId, created.id, { accessToken: 'second' });
    const raw = await withTenantRaw(tenantId, (tx) =>
      tx.whatsAppAccount.findUnique({
        where: { id: created.id },
        select: { accessToken: true },
      }),
    );
    assert.equal(isFieldEncrypted(raw!.accessToken), true);
    assert.equal(decryptSecret(raw!.accessToken), 'second');
  });

  it('runTest decrypts at the point of use; provider receives plaintext Bearer', async () => {
    const view = await svc.create(tenantId, {
      displayName: 'P2-05 runTest',
      phoneNumber: '+201111200003',
      phoneNumberId: 'PNID-P2-05-3',
      provider: 'meta_cloud',
      accessToken: 'live-plaintext-3',
      verifyToken: 'verify-runtest',
    });
    lastFetch = null;
    const out = await svc.runTest(tenantId, view.id);
    assert.equal(out.ok, true);
    const captured = lastFetch as { url: string; init?: RequestInit | undefined } | null;
    if (!captured) throw new Error('provider was not called');
    const headers = captured.init?.headers as Record<string, string> | undefined;
    assert.equal(headers?.['Authorization'], 'Bearer live-plaintext-3');
  });

  it('decryption is lenient on legacy plaintext rows (lazy migration)', async () => {
    // Plant a row directly via Prisma WITHOUT going through the
    // service, simulating an account that pre-dates the P2-05
    // deploy. Read it back through the service path: runTest must
    // still succeed and hand the plaintext to the provider verbatim.
    const id = await withTenantRaw(tenantId, async (tx) => {
      const row = await tx.whatsAppAccount.create({
        data: {
          tenantId,
          displayName: 'P2-05 legacy',
          phoneNumber: '+201111200004',
          phoneNumberId: 'PNID-P2-05-4',
          provider: 'meta_cloud',
          accessToken: 'legacy-plaintext',
          appSecret: null,
          verifyToken: 'verify-legacy',
          isActive: true,
        },
        select: { id: true },
      });
      return row.id;
    });
    lastFetch = null;
    const out = await svc.runTest(tenantId, id);
    assert.equal(out.ok, true);
    const captured = lastFetch as { url: string; init?: RequestInit | undefined } | null;
    if (!captured) throw new Error('provider was not called');
    const headers = captured.init?.headers as Record<string, string> | undefined;
    assert.equal(headers?.['Authorization'], 'Bearer legacy-plaintext');
  });

  it('bulk re-encrypt logic upgrades plaintext → v1 and is idempotent', async () => {
    // Plant another plaintext row.
    const id = await withTenantRaw(tenantId, async (tx) => {
      const row = await tx.whatsAppAccount.create({
        data: {
          tenantId,
          displayName: 'P2-05 bulk',
          phoneNumber: '+201111200005',
          phoneNumberId: 'PNID-P2-05-5',
          provider: 'meta_cloud',
          accessToken: 'bulk-plaintext',
          appSecret: null,
          verifyToken: 'verify-bulk',
          isActive: true,
        },
        select: { id: true },
      });
      return row.id;
    });

    // Mirror what scripts/encrypt-whatsapp-tokens.ts does, scoped to
    // this test's tenant (the script walks every tenant; we don't
    // want to touch unrelated rows).
    async function runBulk(): Promise<{ encrypted: number; skipped: number }> {
      return withTenantRaw(tenantId, async (tx) => {
        let encrypted = 0;
        let skipped = 0;
        const rows = await tx.whatsAppAccount.findMany({
          select: { id: true, accessToken: true },
        });
        for (const row of rows) {
          if (isFieldEncrypted(row.accessToken)) {
            skipped += 1;
            continue;
          }
          await tx.whatsAppAccount.update({
            where: { id: row.id },
            data: { accessToken: encryptSecret(row.accessToken) },
          });
          encrypted += 1;
        }
        return { encrypted, skipped };
      });
    }

    const first = await runBulk();
    assert.ok(first.encrypted >= 1, 'expected at least one row encrypted on first run');

    // The planted row should now be encrypted with the live key.
    const row = await withTenantRaw(tenantId, (tx) =>
      tx.whatsAppAccount.findUnique({ where: { id }, select: { accessToken: true } }),
    );
    assert.equal(isFieldEncrypted(row!.accessToken), true);
    assert.equal(decryptSecret(row!.accessToken), 'bulk-plaintext');

    const second = await runBulk();
    assert.equal(second.encrypted, 0, 'second run must not re-encrypt');
    assert.ok(second.skipped >= 1);
  });
});
