/**
 * C22 — WhatsApp conversation threading tests.
 *
 * Builds on the C21 service harness: real Postgres, two throwaway tenants,
 * direct service calls (no HTTP). Verifies that:
 *   - inbound messages create one conversation per (account, phone)
 *   - subsequent inbound messages reuse the open conversation
 *   - outbound messages thread into the same conversation
 *   - lastMessageAt + lastMessageText are kept in sync
 *   - the partial-unique index "one OPEN conversation per (account, phone)"
 *     blocks a second open thread but not a closed-then-new pair
 *   - listConversations / findConversationById / listConversationMessages
 *     all honour tenant isolation
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { MetaCloudProvider, type FetchFn } from './meta-cloud.provider';
import { WhatsAppService } from './whatsapp.service';

const TENANT_A_CODE = '__c22_wa_a__';
const TENANT_B_CODE = '__c22_wa_b__';

let prisma: PrismaClient;
let svc: WhatsAppService;
let tenantAId: string;
let tenantBId: string;
let accountAId: string;

async function withTenantRaw<T>(tid: string, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return prisma.$transaction(async (tx: any) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.tenant_id = '${tid}'`);
    return fn(tx);
  });
}

describe('whatsapp — conversation threading (C22)', () => {
  before(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();

    const fakeFetch: FetchFn = async () => ({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({ messages: [{ id: `wamid.STUB.${Math.random()}` }] }),
    });
    svc = new WhatsAppService(new PrismaService(), new MetaCloudProvider(fakeFetch));

    const a = await prisma.tenant.upsert({
      where: { code: TENANT_A_CODE },
      update: { isActive: true },
      create: { code: TENANT_A_CODE, name: 'C22 WA tenant A' },
    });
    tenantAId = a.id;
    const b = await prisma.tenant.upsert({
      where: { code: TENANT_B_CODE },
      update: { isActive: true },
      create: { code: TENANT_B_CODE, name: 'C22 WA tenant B' },
    });
    tenantBId = b.id;

    const accountA = await withTenantRaw(tenantAId, (tx) =>
      tx.whatsAppAccount.upsert({
        where: { phoneNumberId: 'PNID-C22-A' },
        update: {},
        create: {
          tenantId: tenantAId,
          displayName: 'C22 Account A',
          phoneNumber: '+201111111111',
          phoneNumberId: 'PNID-C22-A',
          provider: 'meta_cloud',
          accessToken: 'token-A',
          appSecret: null,
          verifyToken: 'verify-C22-A',
        },
      }),
    );
    accountAId = accountA.id;

    await withTenantRaw(tenantBId, (tx) =>
      tx.whatsAppAccount.upsert({
        where: { phoneNumberId: 'PNID-C22-B' },
        update: {},
        create: {
          tenantId: tenantBId,
          displayName: 'C22 Account B',
          phoneNumber: '+966222222222',
          phoneNumberId: 'PNID-C22-B',
          provider: 'meta_cloud',
          accessToken: 'token-B',
          appSecret: null,
          verifyToken: 'verify-C22-B',
        },
      }),
    );
  });

  after(async () => {
    await prisma.tenant.delete({ where: { code: TENANT_A_CODE } }).catch(() => {});
    await prisma.tenant.delete({ where: { code: TENANT_B_CODE } }).catch(() => {});
    await prisma.$disconnect();
  });

  it('inbound creates a conversation when none exists for (account, phone)', async () => {
    const account = await svc.findRoutingByPhoneNumberId('PNID-C22-A');
    assert.ok(account);
    const result = await svc.persistInbound(account, {
      phone: '+201001100001',
      text: 'first inbound',
      providerMessageId: 'wamid.C22.in1',
      receivedAt: new Date('2026-04-01T10:00:00Z'),
      phoneNumberId: 'PNID-C22-A',
    });
    assert.ok(result, 'persistInbound returned a result');
    assert.ok(result.conversationId, 'conversationId was returned');

    // Conversation row visible inside tenant A only.
    const conv = await svc.findConversationById(tenantAId, result.conversationId);
    assert.ok(conv);
    assert.equal(conv?.phone, '+201001100001');
    assert.equal(conv?.status, 'open');
    assert.equal(conv?.lastMessageText, 'first inbound');
    assert.equal(conv?.accountId, accountAId);
  });

  it('subsequent inbound from the same phone reuses the open conversation + bumps lastMessage*', async () => {
    const account = await svc.findRoutingByPhoneNumberId('PNID-C22-A');
    assert.ok(account);

    const r1 = await svc.persistInbound(account, {
      phone: '+201001100002',
      text: 'one',
      providerMessageId: 'wamid.C22.reuse1',
      receivedAt: new Date('2026-04-01T11:00:00Z'),
      phoneNumberId: 'PNID-C22-A',
    });
    const r2 = await svc.persistInbound(account, {
      phone: '+201001100002',
      text: 'two',
      providerMessageId: 'wamid.C22.reuse2',
      receivedAt: new Date('2026-04-01T11:05:00Z'),
      phoneNumberId: 'PNID-C22-A',
    });
    assert.ok(r1 && r2);
    assert.equal(r1.conversationId, r2.conversationId, 'both inbound messages share one thread');

    const conv = await svc.findConversationById(tenantAId, r1.conversationId);
    assert.ok(conv);
    assert.equal(conv?.lastMessageText, 'two');
    assert.equal(conv?.lastMessageAt.toISOString(), '2026-04-01T11:05:00.000Z');

    const messages = await svc.listConversationMessages(tenantAId, r1.conversationId);
    assert.ok(messages);
    assert.equal(messages?.length, 2, 'both messages attached to the conversation');
    assert.deepEqual(
      messages?.map((m) => m.providerMessageId),
      ['wamid.C22.reuse1', 'wamid.C22.reuse2'],
      'oldest first',
    );
    assert.ok(messages?.every((m) => m.conversationId === r1.conversationId));
  });

  it('outbound sendText threads into the same open conversation as inbound', async () => {
    const account = await svc.findRoutingByPhoneNumberId('PNID-C22-A');
    assert.ok(account);
    // P2-12 — receivedAt must be within the 24h customer-service
    // window for the outbound sendText below; using a fixed
    // historical timestamp would now trip the freeform-window gate.
    const inbound = await svc.persistInbound(account, {
      phone: '+201001100003',
      text: 'inbound first',
      providerMessageId: 'wamid.C22.thread.in',
      receivedAt: new Date(Date.now() - 60_000),
      phoneNumberId: 'PNID-C22-A',
    });
    assert.ok(inbound);

    const out = await svc.sendText({
      tenantId: tenantAId,
      accountId: accountAId,
      to: '+201001100003',
      text: 'replying',
    });
    assert.equal(
      out.conversationId,
      inbound.conversationId,
      'outbound reuses the inbound conversation',
    );

    const messages = await svc.listConversationMessages(tenantAId, inbound.conversationId);
    assert.ok(messages);
    assert.equal(messages?.length, 2);
    assert.equal(messages?.[0]?.direction, 'inbound');
    assert.equal(messages?.[1]?.direction, 'outbound');
    assert.equal(messages?.[1]?.text, 'replying');

    const conv = await svc.findConversationById(tenantAId, inbound.conversationId);
    assert.equal(conv?.lastMessageText, 'replying', 'outbound bumps the summary');
  });

  it('idempotent webhook delivery does NOT mutate the conversation summary twice', async () => {
    const account = await svc.findRoutingByPhoneNumberId('PNID-C22-A');
    assert.ok(account);
    const first = await svc.persistInbound(account, {
      phone: '+201001100004',
      text: 'unique',
      providerMessageId: 'wamid.C22.idem',
      receivedAt: new Date('2026-04-01T13:00:00Z'),
      phoneNumberId: 'PNID-C22-A',
    });
    assert.ok(first);

    // Force a different "later" inbound to advance the summary…
    await svc.persistInbound(account, {
      phone: '+201001100004',
      text: 'newer',
      providerMessageId: 'wamid.C22.idem.newer',
      receivedAt: new Date('2026-04-01T13:10:00Z'),
      phoneNumberId: 'PNID-C22-A',
    });
    // …then re-deliver the original webhook. It MUST be idempotent: no
    // new message row, no rewrite of the summary back to the older text.
    const dup = await svc.persistInbound(account, {
      phone: '+201001100004',
      text: 'unique',
      providerMessageId: 'wamid.C22.idem',
      receivedAt: new Date('2026-04-01T13:00:00Z'),
      phoneNumberId: 'PNID-C22-A',
    });
    assert.equal(dup, null, 'duplicate provider id returns null');

    const conv = await svc.findConversationById(tenantAId, first.conversationId);
    assert.equal(conv?.lastMessageText, 'newer', 'summary stays at the latest message');
  });

  it('partial-unique index: at most ONE open conversation per (account, phone)', async () => {
    // Plant an open conversation directly via Prisma — second insert with
    // the same (tenant, account, phone) should fail with P2002.
    await withTenantRaw(tenantAId, (tx) =>
      tx.whatsAppConversation.create({
        data: {
          tenantId: tenantAId,
          accountId: accountAId,
          phone: '+201001100099',
          status: 'open',
        },
      }),
    );

    let threw = false;
    try {
      await withTenantRaw(tenantAId, (tx) =>
        tx.whatsAppConversation.create({
          data: {
            tenantId: tenantAId,
            accountId: accountAId,
            phone: '+201001100099',
            status: 'open',
          },
        }),
      );
    } catch {
      threw = true;
    }
    assert.equal(threw, true, 'second open thread for same (account, phone) is rejected');

    // Closing the first lets a new open thread coexist.
    await withTenantRaw(tenantAId, (tx) =>
      tx.whatsAppConversation.updateMany({
        where: {
          tenantId: tenantAId,
          accountId: accountAId,
          phone: '+201001100099',
          status: 'open',
        },
        data: { status: 'closed' },
      }),
    );

    const reopen = await withTenantRaw(tenantAId, (tx) =>
      tx.whatsAppConversation.create({
        data: {
          tenantId: tenantAId,
          accountId: accountAId,
          phone: '+201001100099',
          status: 'open',
        },
      }),
    );
    assert.ok(reopen.id, 'open is allowed after the prior thread was closed');
  });

  it('listConversations is tenant-scoped + ordered by lastMessageAt DESC', async () => {
    // Ensure tenant A has at least one conversation; insert one in tenant B
    // and verify it does NOT show up in tenant A's list.
    const accountB = await svc.findRoutingByPhoneNumberId('PNID-C22-B');
    assert.ok(accountB);
    const planted = await svc.persistInbound(accountB, {
      phone: '+966500001111',
      text: 'tenant B only',
      providerMessageId: 'wamid.C22.B.iso1',
      receivedAt: new Date('2026-04-01T14:00:00Z'),
      phoneNumberId: 'PNID-C22-B',
    });
    assert.ok(planted);

    const aList = await svc.listConversations(tenantAId, { limit: 200 });
    assert.ok(!aList.items.some((c) => c.id === planted.conversationId));

    const bList = await svc.listConversations(tenantBId, { limit: 200 });
    assert.ok(bList.items.some((c) => c.id === planted.conversationId));

    // Newest activity first within tenant A.
    if (aList.items.length >= 2) {
      for (let i = 1; i < aList.items.length; i++) {
        const prev = aList.items[i - 1]!.lastMessageAt.getTime();
        const curr = aList.items[i]!.lastMessageAt.getTime();
        assert.ok(prev >= curr, `lastMessageAt order broken at index ${i}`);
      }
    }
  });

  it('findConversationById + listConversationMessages return null on cross-tenant ids', async () => {
    const accountB = await svc.findRoutingByPhoneNumberId('PNID-C22-B');
    assert.ok(accountB);
    const planted = await svc.persistInbound(accountB, {
      phone: '+966500002222',
      text: 'cross tenant probe',
      providerMessageId: 'wamid.C22.B.iso2',
      receivedAt: new Date(),
      phoneNumberId: 'PNID-C22-B',
    });
    assert.ok(planted);

    const fromA = await svc.findConversationById(tenantAId, planted.conversationId);
    assert.equal(fromA, null, "tenant A cannot see tenant B's conversation");

    const msgsFromA = await svc.listConversationMessages(tenantAId, planted.conversationId);
    assert.equal(msgsFromA, null, "tenant A cannot list messages of tenant B's conversation");
  });

  it('listConversations filters: accountId + status + phone', async () => {
    // A second account in tenant A, then plant a conversation for it.
    const secondAccount = await withTenantRaw(tenantAId, (tx) =>
      tx.whatsAppAccount.upsert({
        where: { phoneNumberId: 'PNID-C22-A2' },
        update: {},
        create: {
          tenantId: tenantAId,
          displayName: 'C22 Account A2',
          phoneNumber: '+201111111112',
          phoneNumberId: 'PNID-C22-A2',
          provider: 'meta_cloud',
          accessToken: 'token-A2',
          verifyToken: 'verify-C22-A2',
        },
      }),
    );
    const route = await svc.findRoutingByPhoneNumberId('PNID-C22-A2');
    assert.ok(route);
    await svc.persistInbound(route, {
      phone: '+201001100777',
      text: 'second account msg',
      providerMessageId: 'wamid.C22.A2.1',
      receivedAt: new Date(),
      phoneNumberId: 'PNID-C22-A2',
    });

    const filtered = await svc.listConversations(tenantAId, { accountId: secondAccount.id });
    assert.ok(filtered.items.length >= 1);
    assert.ok(filtered.items.every((c) => c.accountId === secondAccount.id));

    const onlyOpen = await svc.listConversations(tenantAId, { status: 'open' });
    assert.ok(onlyOpen.items.every((c) => c.status === 'open'));

    const byPhone = await svc.listConversations(tenantAId, { phone: '01100777' });
    assert.ok(byPhone.items.every((c) => c.phone.includes('01100777')));
  });
});
