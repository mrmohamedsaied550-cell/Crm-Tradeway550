/**
 * C21 — WhatsApp foundation tests.
 *
 * Two layers of coverage:
 *   1. Provider unit tests — pure-function behaviour of MetaCloudProvider
 *      without touching the database (verifyWebhook / verifySignature /
 *      parseInbound / sendText against a stubbed fetch).
 *   2. Service integration tests — exercise persistInbound + sendText
 *      against a real Postgres, with two throwaway tenants to verify
 *      RLS isolation + idempotency on duplicate webhook deliveries.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { MetaCloudProvider, type FetchFn } from './meta-cloud.provider';
import { WhatsAppService } from './whatsapp.service';

const TENANT_A_CODE = '__c21_wa_a__';
const TENANT_B_CODE = '__c21_wa_b__';

let prisma: PrismaClient;

async function withTenantRaw<T>(tid: string, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return prisma.$transaction(async (tx: any) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.tenant_id = '${tid}'`);
    return fn(tx);
  });
}

// ───────────────────────────────────────────────────────────────────────
// Provider abstraction (pure functions)
// ───────────────────────────────────────────────────────────────────────

describe('whatsapp — MetaCloudProvider', () => {
  const provider = new MetaCloudProvider(
    /* fetchImpl */ () => {
      throw new Error('fetch should not be called here');
    },
  );

  it('verifyWebhook accepts the right token + mode and returns the challenge', () => {
    const out = provider.verifyWebhook(
      {
        'hub.mode': 'subscribe',
        'hub.verify_token': 'expected-secret',
        'hub.challenge': 'CHALLENGE_123',
      },
      'expected-secret',
    );
    assert.equal(out, 'CHALLENGE_123');
  });

  it('verifyWebhook rejects wrong token / wrong mode / missing challenge', () => {
    assert.equal(
      provider.verifyWebhook(
        { 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': 'x' },
        'expected',
      ),
      null,
    );
    assert.equal(
      provider.verifyWebhook(
        { 'hub.mode': 'unsubscribe', 'hub.verify_token': 'expected', 'hub.challenge': 'x' },
        'expected',
      ),
      null,
    );
    assert.equal(
      provider.verifyWebhook(
        { 'hub.mode': 'subscribe', 'hub.verify_token': 'expected' },
        'expected',
      ),
      null,
    );
  });

  it('verifySignature returns true when no app secret is configured', () => {
    assert.equal(provider.verifySignature('any body', undefined, null), true);
    assert.equal(provider.verifySignature('any body', undefined, ''), true);
  });

  it('verifySignature accepts a correct sha256 HMAC and rejects a tampered one', () => {
    const secret = 'app-secret';
    const body = '{"hello":"world"}';
    const expected = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    assert.equal(provider.verifySignature(body, expected, secret), true);

    // Tampered body should fail.
    assert.equal(provider.verifySignature('{"hello":"WORLD"}', expected, secret), false);
    // Wrong header should fail.
    assert.equal(
      provider.verifySignature(body, 'sha256=00112233445566778899aabbccddeeff', secret),
      false,
    );
    // Missing header should fail.
    assert.equal(provider.verifySignature(body, undefined, secret), false);
  });

  it('parseInbound returns [] for empty / malformed bodies', () => {
    assert.deepEqual(provider.parseInbound(null), []);
    assert.deepEqual(provider.parseInbound({}), []);
    assert.deepEqual(provider.parseInbound({ entry: 'nope' }), []);
    assert.deepEqual(provider.parseInbound({ entry: [{ changes: 'nope' }] }), []);
  });

  it('parseInbound extracts text messages from a representative payload', () => {
    const body = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'BUSINESS_ID',
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: '123456789012345' },
                messages: [
                  {
                    from: '201001112222',
                    id: 'wamid.A1',
                    timestamp: '1698768000',
                    type: 'text',
                    text: { body: 'Hello from the lead' },
                  },
                  {
                    from: '201001112222',
                    id: 'wamid.A2',
                    timestamp: '1698768060',
                    type: 'image',
                    image: { id: 'img-1' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const out = provider.parseInbound(body);
    assert.equal(out.length, 1, 'only text messages emit InboundMessage');
    assert.equal(out[0]?.providerMessageId, 'wamid.A1');
    assert.equal(out[0]?.phone, '+201001112222', 'leading + is added');
    assert.equal(out[0]?.text, 'Hello from the lead');
    assert.equal(out[0]?.phoneNumberId, '123456789012345');
    assert.equal(out[0]?.receivedAt.getTime(), 1698768000 * 1000);
  });

  it('parseInbound handles multiple entries / multiple changes', () => {
    const body = {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: 'pn-1' },
                messages: [{ from: '20111', id: 'm1', type: 'text', text: { body: 'a' } }],
              },
            },
          ],
        },
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: 'pn-2' },
                messages: [
                  { from: '20222', id: 'm2', type: 'text', text: { body: 'b' } },
                  { from: '20333', id: 'm3', type: 'text', text: { body: 'c' } },
                ],
              },
            },
          ],
        },
      ],
    };
    const out = provider.parseInbound(body);
    assert.equal(out.length, 3);
    assert.deepEqual(
      out.map((m) => m.providerMessageId),
      ['m1', 'm2', 'm3'],
    );
  });

  it('sendText posts to the Cloud API and returns the provider message id', async () => {
    let calledUrl = '';
    let calledBody: unknown = null;
    let calledHeaders: Record<string, string> | null = null;

    const fakeFetch: FetchFn = async (url, init) => {
      calledUrl = url;
      calledBody = init?.body ? JSON.parse(init.body as string) : null;
      calledHeaders = (init?.headers as Record<string, string>) ?? null;
      return {
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({
          messaging_product: 'whatsapp',
          contacts: [{ wa_id: '201001112222' }],
          messages: [{ id: 'wamid.OUT1' }],
        }),
      };
    };

    const local = new MetaCloudProvider(fakeFetch);
    const result = await local.sendText({
      config: {
        accessToken: 'token-abc',
        phoneNumberId: 'PNID-123',
        appSecret: null,
        verifyToken: 'verify',
      },
      to: '+201001112222',
      text: 'Hello captain',
    });

    assert.equal(result.providerMessageId, 'wamid.OUT1');
    assert.match(calledUrl, /\/PNID-123\/messages$/);
    assert.equal(calledHeaders?.['Authorization'], 'Bearer token-abc');
    assert.equal(calledHeaders?.['Content-Type'], 'application/json');
    assert.deepEqual(calledBody, {
      messaging_product: 'whatsapp',
      to: '201001112222',
      type: 'text',
      text: { body: 'Hello captain' },
    });
  });

  it('sendText surfaces an error on non-ok response', async () => {
    const failing: FetchFn = async () => ({
      ok: false,
      status: 401,
      text: async () => '{"error":{"message":"bad token"}}',
      json: async () => ({}),
    });
    const local = new MetaCloudProvider(failing);
    await assert.rejects(
      () =>
        local.sendText({
          config: {
            accessToken: 'bad',
            phoneNumberId: 'PNID',
            appSecret: null,
            verifyToken: 'verify',
          },
          to: '+201001112222',
          text: 'fail',
        }),
      /whatsapp_send_failed:401/,
    );
  });
});

// ───────────────────────────────────────────────────────────────────────
// Service integration (real Postgres)
// ───────────────────────────────────────────────────────────────────────

describe('whatsapp — service + persistence (C21)', () => {
  let svc: WhatsAppService;
  let tenantAId: string;
  let tenantBId: string;
  let accountAId: string;

  before(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();

    // Service wiring: Prisma + a stub provider for sendText so we don't
    // hit Meta. The MetaCloudProvider doesn't need a real fetch for the
    // persistence-only tests we run here.
    const fakeFetch: FetchFn = async () => ({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({ messages: [{ id: 'wamid.STUB' }] }),
    });
    const provider = new MetaCloudProvider(fakeFetch);
    svc = new WhatsAppService(new PrismaService(), provider);

    const a = await prisma.tenant.upsert({
      where: { code: TENANT_A_CODE },
      update: { isActive: true },
      create: { code: TENANT_A_CODE, name: 'C21 WA tenant A' },
    });
    tenantAId = a.id;
    const b = await prisma.tenant.upsert({
      where: { code: TENANT_B_CODE },
      update: { isActive: true },
      create: { code: TENANT_B_CODE, name: 'C21 WA tenant B' },
    });
    tenantBId = b.id;

    // Two accounts — one per tenant — with distinct phoneNumberIds so the
    // routing lookup tests are unambiguous.
    const accountA = await withTenantRaw(tenantAId, (tx) =>
      tx.whatsAppAccount.upsert({
        where: { phoneNumberId: 'PNID-A' },
        update: {},
        create: {
          tenantId: tenantAId,
          displayName: 'C21 Account A',
          phoneNumber: '+201111111111',
          phoneNumberId: 'PNID-A',
          provider: 'meta_cloud',
          accessToken: 'token-A',
          appSecret: 'secret-A',
          verifyToken: 'verify-A',
        },
      }),
    );
    accountAId = accountA.id;

    await withTenantRaw(tenantBId, (tx) =>
      tx.whatsAppAccount.upsert({
        where: { phoneNumberId: 'PNID-B' },
        update: {},
        create: {
          tenantId: tenantBId,
          displayName: 'C21 Account B',
          phoneNumber: '+966222222222',
          phoneNumberId: 'PNID-B',
          provider: 'meta_cloud',
          accessToken: 'token-B',
          appSecret: null,
          verifyToken: 'verify-B',
        },
      }),
    );
  });

  after(async () => {
    await prisma.tenant.delete({ where: { code: TENANT_A_CODE } }).catch(() => {});
    await prisma.tenant.delete({ where: { code: TENANT_B_CODE } }).catch(() => {});
    await prisma.$disconnect();
  });

  it('findRoutingByPhoneNumberId returns the right account across tenants', async () => {
    const a = await svc.findRoutingByPhoneNumberId('PNID-A');
    assert.ok(a);
    assert.equal(a?.tenantId, tenantAId);

    const b = await svc.findRoutingByPhoneNumberId('PNID-B');
    assert.ok(b);
    assert.equal(b?.tenantId, tenantBId);

    const missing = await svc.findRoutingByPhoneNumberId('PNID-DOES-NOT-EXIST');
    assert.equal(missing, null);
  });

  it('findRoutingByVerifyToken matches the per-account verify token', async () => {
    const a = await svc.findRoutingByVerifyToken('verify-A');
    assert.equal(a?.tenantId, tenantAId);
    const b = await svc.findRoutingByVerifyToken('verify-B');
    assert.equal(b?.tenantId, tenantBId);
    const none = await svc.findRoutingByVerifyToken('not-a-token');
    assert.equal(none, null);
  });

  it('persistInbound creates a row under the account tenant; idempotent on duplicate id', async () => {
    const account = await svc.findRoutingByPhoneNumberId('PNID-A');
    assert.ok(account);

    const id1 = await svc.persistInbound(account, {
      phone: '+201001112222',
      text: 'hi',
      providerMessageId: 'wamid.DUP1',
      receivedAt: new Date(),
      phoneNumberId: 'PNID-A',
    });
    assert.ok(id1, 'first insert returns the new id');

    // Second time — same providerMessageId — must short-circuit to null.
    const id2 = await svc.persistInbound(account, {
      phone: '+201001112222',
      text: 'hi (duplicate webhook delivery)',
      providerMessageId: 'wamid.DUP1',
      receivedAt: new Date(),
      phoneNumberId: 'PNID-A',
    });
    assert.equal(id2, null, 'duplicate delivery is idempotent');

    // Tenant-scoped count must show exactly one row for this providerMessageId.
    const rows = await withTenantRaw(tenantAId, (tx) =>
      tx.whatsAppMessage.findMany({ where: { providerMessageId: 'wamid.DUP1' } }),
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.direction, 'inbound');
    assert.equal(rows[0]?.status, 'received');
  });

  it('messages from tenant A are not visible from tenant B (RLS isolation)', async () => {
    // Probe: insert in tenant A, then list in tenant B.
    const account = await svc.findRoutingByPhoneNumberId('PNID-A');
    assert.ok(account);
    await svc.persistInbound(account, {
      phone: '+201001119999',
      text: 'tenant A only',
      providerMessageId: 'wamid.RLS1',
      receivedAt: new Date(),
      phoneNumberId: 'PNID-A',
    });

    const visibleInA = await svc.listMessages(tenantAId, { limit: 50 });
    assert.ok(visibleInA.some((m) => m.providerMessageId === 'wamid.RLS1'));

    const visibleInB = await svc.listMessages(tenantBId, { limit: 50 });
    assert.ok(!visibleInB.some((m) => m.providerMessageId === 'wamid.RLS1'));
  });

  it('sendText sends through the provider and persists an outbound message', async () => {
    const out = await svc.sendText({
      tenantId: tenantAId,
      accountId: accountAId,
      to: '+201001112222',
      text: 'Outbound from C21',
    });
    assert.equal(out.providerMessageId, 'wamid.STUB');

    // Persisted under tenant A as outbound.
    const rows = await withTenantRaw(tenantAId, (tx) =>
      tx.whatsAppMessage.findMany({
        where: { providerMessageId: 'wamid.STUB' },
      }),
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.direction, 'outbound');
    assert.equal(rows[0]?.phone, '+201001112222');
    assert.equal(rows[0]?.text, 'Outbound from C21');
    assert.equal(rows[0]?.status, 'sent');
  });

  it('sendText rejects a foreign accountId via the tenant-scoped lookup', async () => {
    // accountAId belongs to tenantA — calling it under tenantB must fail.
    await assert.rejects(
      () =>
        svc.sendText({
          tenantId: tenantBId,
          accountId: accountAId,
          to: '+201001112222',
          text: 'cross-tenant',
        }),
      /not found in active tenant/,
    );
  });
});
