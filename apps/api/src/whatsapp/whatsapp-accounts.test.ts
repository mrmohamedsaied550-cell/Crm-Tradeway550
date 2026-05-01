/**
 * C24A — WhatsAppAccountsService tests.
 *
 * Coverage:
 *   - create / list / get round-trip with the no-secret projection
 *     (responses NEVER expose accessToken / appSecret).
 *   - update rotates accessToken + appSecret when provided, leaves
 *     them untouched when omitted, and clears appSecret when explicitly
 *     null.
 *   - enable / disable are idempotent.
 *   - duplicate `phone_number_id` (cross-tenant) and per-tenant
 *     `phone_number` rejections surface as typed conflict errors.
 *   - tenant isolation: tenant A cannot read tenant B's accounts.
 *   - runTest: hands fresh credentials to the provider, returns the
 *     provider's ConnectionTestResult; provider exceptions are caught
 *     and reported as ok:false (no leakage of sensitive data into the
 *     error message).
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';

import { decryptSecret, isFieldEncrypted } from '../common/crypto';
import { PrismaService } from '../prisma/prisma.service';
import { MetaCloudProvider, type FetchFn } from './meta-cloud.provider';
import { WhatsAppService } from './whatsapp.service';
import { WhatsAppAccountsService } from './whatsapp-accounts.service';

const TENANT_A_CODE = '__c24a_wa_a__';
const TENANT_B_CODE = '__c24a_wa_b__';

let prisma: PrismaClient;
let prismaSvc: PrismaService;
let svc: WhatsAppAccountsService;
let tenantAId: string;
let tenantBId: string;

let lastFetch: { url: string; init?: RequestInit | undefined } | null = null;
const fakeFetch: FetchFn = async (url, init) => {
  lastFetch = { url, init };
  // Inspect URL: send-messages endpoints return a stub message id, the
  // GET /{phone-number-id} liveness check returns metadata.
  if (init?.method === 'POST' && url.includes('/messages')) {
    return {
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({ messages: [{ id: `wamid.${Math.random()}` }] }),
    };
  }
  // Default: testConnection success.
  return {
    ok: true,
    status: 200,
    text: async () => '',
    json: async () => ({
      display_phone_number: '+1 555 000 1234',
      verified_name: 'Trade Way',
    }),
  };
};

describe('whatsapp — accounts admin (C24A)', () => {
  before(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    prismaSvc = new PrismaService();
    const provider = new MetaCloudProvider(fakeFetch);
    const wa = new WhatsAppService(prismaSvc, provider);
    svc = new WhatsAppAccountsService(prismaSvc, wa);

    const a = await prisma.tenant.upsert({
      where: { code: TENANT_A_CODE },
      update: { isActive: true },
      create: { code: TENANT_A_CODE, name: 'C24A WA tenant A' },
    });
    tenantAId = a.id;
    const b = await prisma.tenant.upsert({
      where: { code: TENANT_B_CODE },
      update: { isActive: true },
      create: { code: TENANT_B_CODE, name: 'C24A WA tenant B' },
    });
    tenantBId = b.id;
  });

  after(async () => {
    await prisma.tenant.delete({ where: { code: TENANT_A_CODE } }).catch(() => {});
    await prisma.tenant.delete({ where: { code: TENANT_B_CODE } }).catch(() => {});
    await prisma.$disconnect();
  });

  // The shape returned to admins must NEVER include the secrets.
  function assertNoSecrets(view: unknown): void {
    const o = view as Record<string, unknown>;
    assert.equal('accessToken' in o, false, 'accessToken must not be returned');
    assert.equal('appSecret' in o, false, 'appSecret must not be returned');
    assert.equal(typeof o['hasAppSecret'], 'boolean', 'hasAppSecret boolean expected');
  }

  it('create returns the no-secret view; secrets are persisted but not exposed', async () => {
    const view = await svc.create(tenantAId, {
      displayName: 'Egypt — Uber sales',
      phoneNumber: '+201111000001',
      phoneNumberId: 'PNID-C24A-1',
      provider: 'meta_cloud',
      accessToken: 'super-secret-token',
      appSecret: 'super-secret-app-secret',
      verifyToken: 'verify-c24a-aa',
    });
    assertNoSecrets(view);
    assert.equal(view.displayName, 'Egypt — Uber sales');
    assert.equal(view.phoneNumber, '+201111000001');
    assert.equal(view.phoneNumberId, 'PNID-C24A-1');
    assert.equal(view.hasAppSecret, true);
    assert.equal(view.isActive, true);

    // Verify the secrets were actually written to the table — but read
    // via the raw client to prove the masking is at the service layer.
    const raw = await prisma.$transaction(async (tx) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tx as any).$executeRawUnsafe(`SET LOCAL app.tenant_id = '${tenantAId}'`);
      return tx.whatsAppAccount.findUnique({
        where: { id: view.id },
        select: { accessToken: true, appSecret: true },
      });
    });
    // P2-05 — `access_token` is encrypted at rest (v1: prefix +
    // AES-256-GCM); decrypt to verify the plaintext round-trip.
    // `app_secret` stays plaintext: the public webhook reads it
    // cross-tenant via the routes mirror.
    assert.equal(isFieldEncrypted(raw?.accessToken ?? null), true);
    assert.equal(decryptSecret(raw!.accessToken), 'super-secret-token');
    assert.equal(raw?.appSecret, 'super-secret-app-secret');
  });

  it('list / get expose the same masked shape; secrets stay masked', async () => {
    const list = await svc.list(tenantAId);
    assert.ok(list.length >= 1);
    for (const v of list) assertNoSecrets(v);

    const one = list[0]!;
    const fetched = await svc.findByIdOrThrow(tenantAId, one.id);
    assertNoSecrets(fetched);
    assert.equal(fetched.id, one.id);
  });

  it('create rejects a duplicate phoneNumberId with whatsapp.duplicate_phone_number_id', async () => {
    await assert.rejects(
      () =>
        svc.create(tenantAId, {
          displayName: 'Dup',
          phoneNumber: '+201111000099',
          phoneNumberId: 'PNID-C24A-1', // already exists
          provider: 'meta_cloud',
          accessToken: 'x'.repeat(20),
          verifyToken: 'verify-dup-1',
        }),
      /already exists/,
    );
  });

  it('create rejects a duplicate (tenant, phoneNumber) with whatsapp.duplicate_phone', async () => {
    await assert.rejects(
      () =>
        svc.create(tenantAId, {
          displayName: 'Dup phone',
          phoneNumber: '+201111000001', // already exists in tenant A
          phoneNumberId: 'PNID-C24A-DUP',
          provider: 'meta_cloud',
          accessToken: 'x'.repeat(20),
          verifyToken: 'verify-dup-2',
        }),
      /phone number already exists/,
    );
  });

  it('update rotates token + appSecret when provided; leaves them when omitted; clears with null', async () => {
    const created = await svc.create(tenantAId, {
      displayName: 'Rotate test',
      phoneNumber: '+201111000010',
      phoneNumberId: 'PNID-C24A-rot',
      provider: 'meta_cloud',
      accessToken: 'token-v1',
      appSecret: 'secret-v1',
      verifyToken: 'verify-rot',
    });
    const id = created.id;

    // Omit both → unchanged.
    await svc.update(tenantAId, id, { displayName: 'Renamed' });
    const raw1 = await prisma.$transaction(async (tx) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tx as any).$executeRawUnsafe(`SET LOCAL app.tenant_id = '${tenantAId}'`);
      return tx.whatsAppAccount.findUnique({
        where: { id },
        select: { accessToken: true, appSecret: true, displayName: true },
      });
    });
    assert.equal(decryptSecret(raw1!.accessToken), 'token-v1');
    assert.equal(raw1?.appSecret, 'secret-v1');
    assert.equal(raw1?.displayName, 'Renamed');

    // Rotate both.
    const rotated = await svc.update(tenantAId, id, {
      accessToken: 'token-v2',
      appSecret: 'secret-v2',
    });
    assertNoSecrets(rotated);
    const raw2 = await prisma.$transaction(async (tx) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tx as any).$executeRawUnsafe(`SET LOCAL app.tenant_id = '${tenantAId}'`);
      return tx.whatsAppAccount.findUnique({
        where: { id },
        select: { accessToken: true, appSecret: true },
      });
    });
    assert.equal(decryptSecret(raw2!.accessToken), 'token-v2');
    assert.equal(raw2?.appSecret, 'secret-v2');

    // Clear app secret with explicit null.
    const cleared = await svc.update(tenantAId, id, { appSecret: null });
    assert.equal(cleared.hasAppSecret, false);
    const raw3 = await prisma.$transaction(async (tx) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tx as any).$executeRawUnsafe(`SET LOCAL app.tenant_id = '${tenantAId}'`);
      return tx.whatsAppAccount.findUnique({
        where: { id },
        select: { appSecret: true },
      });
    });
    assert.equal(raw3?.appSecret, null);
  });

  it('enable / disable are idempotent and surface in the public view', async () => {
    const created = await svc.create(tenantAId, {
      displayName: 'Toggle',
      phoneNumber: '+201111000020',
      phoneNumberId: 'PNID-C24A-toggle',
      provider: 'meta_cloud',
      accessToken: 'x'.repeat(20),
      verifyToken: 'verify-toggle',
    });
    assert.equal(created.isActive, true);

    const disabled1 = await svc.disable(tenantAId, created.id);
    assert.equal(disabled1.isActive, false);
    const disabled2 = await svc.disable(tenantAId, created.id);
    assert.equal(disabled2.isActive, false);

    const enabled1 = await svc.enable(tenantAId, created.id);
    assert.equal(enabled1.isActive, true);
    const enabled2 = await svc.enable(tenantAId, created.id);
    assert.equal(enabled2.isActive, true);
  });

  // C27 — production may not enable an account that has no appSecret;
  // the webhook would reject every payload anyway since signatures
  // cannot be verified. Disable continues to work so an admin can park
  // a misconfigured account.
  it('refuses to enable an account without appSecret in production (C27)', async () => {
    const originalNodeEnv = process.env['NODE_ENV'];
    const created = await svc.create(tenantAId, {
      displayName: 'Prod gate',
      phoneNumber: '+201111000050',
      phoneNumberId: 'PNID-C24A-prod-gate',
      provider: 'meta_cloud',
      accessToken: 'x'.repeat(20),
      // appSecret intentionally omitted
      verifyToken: 'verify-c27-aa',
    });
    // Disable first — the freshly-created account is active by default.
    await svc.disable(tenantAId, created.id);

    process.env['NODE_ENV'] = 'production';
    try {
      await assert.rejects(() => svc.enable(tenantAId, created.id), /appSecret/);
      // disable must still succeed in production.
      const disabled = await svc.disable(tenantAId, created.id);
      assert.equal(disabled.isActive, false);

      // Set an appSecret, THEN enable should succeed.
      await svc.update(tenantAId, created.id, { appSecret: 'prod-secret' });
      const enabled = await svc.enable(tenantAId, created.id);
      assert.equal(enabled.isActive, true);
      assert.equal(enabled.hasAppSecret, true);
    } finally {
      process.env['NODE_ENV'] = originalNodeEnv;
    }
  });

  it('runTest delegates to the provider and returns ConnectionTestResult', async () => {
    const created = await svc.create(tenantAId, {
      displayName: 'Test conn',
      phoneNumber: '+201111000030',
      phoneNumberId: 'PNID-C24A-test',
      provider: 'meta_cloud',
      accessToken: 'live-token',
      verifyToken: 'verify-test',
    });
    lastFetch = null;
    const result = await svc.runTest(tenantAId, created.id);
    assert.equal(result.ok, true);
    assert.equal(result.message, 'Connection healthy');
    assert.equal(result.displayPhoneNumber, '+1 555 000 1234');
    assert.equal(result.verifiedName, 'Trade Way');

    // The provider call carried the right credentials in the URL + header.
    if (!lastFetch) {
      throw new Error('provider was not called');
    }
    const captured: { url: string; init?: RequestInit | undefined } = lastFetch;
    assert.match(captured.url, /\/PNID-C24A-test\?fields=/);
    const headers = captured.init?.headers as Record<string, string> | undefined;
    assert.equal(headers?.['Authorization'], 'Bearer live-token');
  });

  it('runTest returns ok:false when the provider rejects (no secret leakage)', async () => {
    const failing: FetchFn = async () => ({
      ok: false,
      status: 401,
      text: async () => '{"error":{"message":"Bearer token expired: ABC123"}}',
      json: async () => ({}),
    });
    const localProvider = new MetaCloudProvider(failing);
    const localWa = new WhatsAppService(prismaSvc, localProvider);
    const localSvc = new WhatsAppAccountsService(prismaSvc, localWa);

    const created = await svc.create(tenantAId, {
      displayName: 'Bad creds',
      phoneNumber: '+201111000040',
      phoneNumberId: 'PNID-C24A-bad',
      provider: 'meta_cloud',
      accessToken: 'bad-token',
      verifyToken: 'verify-bad',
    });
    const result = await localSvc.runTest(tenantAId, created.id);
    assert.equal(result.ok, false);
    // The friendly message must NOT carry the raw provider error body.
    assert.ok(!result.message.includes('Bearer token expired'));
    assert.ok(!result.message.includes('ABC123'));
  });

  it('isolates tenants — tenant A list does not include tenant B accounts', async () => {
    await svc.create(tenantBId, {
      displayName: 'Other tenant',
      phoneNumber: '+966222000001',
      phoneNumberId: 'PNID-C24A-B-1',
      provider: 'meta_cloud',
      accessToken: 'b-token',
      verifyToken: 'verify-B-1',
    });

    const aList = await svc.list(tenantAId);
    assert.ok(!aList.some((v) => v.phoneNumberId === 'PNID-C24A-B-1'));

    const bList = await svc.list(tenantBId);
    assert.ok(bList.some((v) => v.phoneNumberId === 'PNID-C24A-B-1'));
  });

  it('cross-tenant findByIdOrThrow surfaces as account_not_found', async () => {
    const planted = await svc.create(tenantBId, {
      displayName: 'Tenant B probe',
      phoneNumber: '+966222000002',
      phoneNumberId: 'PNID-C24A-B-2',
      provider: 'meta_cloud',
      accessToken: 'b-token-2',
      verifyToken: 'verify-B-2',
    });
    await assert.rejects(() => svc.findByIdOrThrow(tenantAId, planted.id), /not found/);
  });
});
