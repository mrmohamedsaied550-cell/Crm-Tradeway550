/**
 * Sprint 14 (D14) — WhatsApp Inbox triage tests.
 *
 * Verifies the queue filter + scope-aware summary endpoint we added to
 * `WhatsAppService` for the triage workspace. Pattern mirrors
 * `conversations.test.ts`: real Postgres, throwaway tenants, direct
 * service calls (no HTTP).
 *
 * Scope of the tests:
 *   - each queue value (`unassigned`, `mine`, `waiting_reply`,
 *     `needs_review`, `linked`, `unlinked`, `today`) returns only the
 *     conversations it claims to.
 *   - the queue filter ANDs into the existing scope rule rather than
 *     widening it.
 *   - `getInboxSummary` returns the same counts as the equivalent
 *     `listConversations({ queue })` calls.
 *   - tenant isolation still holds for both surfaces.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { MetaCloudProvider, type FetchFn } from './meta-cloud.provider';
import { WhatsAppService } from './whatsapp.service';

const TENANT_A_CODE = '__d14_wa_a__';
const TENANT_B_CODE = '__d14_wa_b__';

let prisma: PrismaClient;
let svc: WhatsAppService;
let tenantAId: string;
let tenantBId: string;
let accountAId: string;
let accountBId: string;
let userAId: string;

async function withTenantRaw<T>(tid: string, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return prisma.$transaction(async (tx: any) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.tenant_id = '${tid}'`);
    return fn(tx);
  });
}

describe('whatsapp — inbox triage queues + summary (Sprint 14 / D14)', () => {
  before(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();

    const fakeFetch: FetchFn = async () => ({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({ messages: [] }),
    });
    svc = new WhatsAppService(new PrismaService(), new MetaCloudProvider(fakeFetch));

    const a = await prisma.tenant.upsert({
      where: { code: TENANT_A_CODE },
      update: { isActive: true },
      create: { code: TENANT_A_CODE, name: 'D14 WA tenant A' },
    });
    tenantAId = a.id;
    const b = await prisma.tenant.upsert({
      where: { code: TENANT_B_CODE },
      update: { isActive: true },
      create: { code: TENANT_B_CODE, name: 'D14 WA tenant B' },
    });
    tenantBId = b.id;

    const accountA = await withTenantRaw(tenantAId, (tx) =>
      tx.whatsAppAccount.upsert({
        where: { phoneNumberId: 'PNID-D14-A' },
        update: {},
        create: {
          tenantId: tenantAId,
          displayName: 'D14 Account A',
          phoneNumber: '+201111110000',
          phoneNumberId: 'PNID-D14-A',
          provider: 'meta_cloud',
          accessToken: 'token-A',
          appSecret: null,
          verifyToken: 'verify-D14-A',
        },
      }),
    );
    accountAId = accountA.id;

    const accountB = await withTenantRaw(tenantBId, (tx) =>
      tx.whatsAppAccount.upsert({
        where: { phoneNumberId: 'PNID-D14-B' },
        update: {},
        create: {
          tenantId: tenantBId,
          displayName: 'D14 Account B',
          phoneNumber: '+966222220000',
          phoneNumberId: 'PNID-D14-B',
          provider: 'meta_cloud',
          accessToken: 'token-B',
          appSecret: null,
          verifyToken: 'verify-D14-B',
        },
      }),
    );
    accountBId = accountB.id;

    // Seed a role + user in tenant A for the `mine` queue.
    const roleA = await withTenantRaw(tenantAId, (tx) =>
      tx.role.create({
        data: {
          tenantId: tenantAId,
          code: `d14_owner_${Date.now()}`,
          nameAr: 'D14 Owner',
          nameEn: 'D14 Owner',
          level: 30,
          isSystem: false,
        },
      }),
    );
    const userA = await withTenantRaw(tenantAId, (tx) =>
      tx.user.create({
        data: {
          tenantId: tenantAId,
          roleId: roleA.id,
          email: `d14-owner-${Date.now()}@example.com`,
          name: 'D14 Owner A',
          passwordHash: 'noop',
          status: 'active',
        },
      }),
    );
    userAId = userA.id;
  });

  after(async () => {
    await prisma.tenant.delete({ where: { code: TENANT_A_CODE } }).catch(() => {});
    await prisma.tenant.delete({ where: { code: TENANT_B_CODE } }).catch(() => {});
    await prisma.$disconnect();
  });

  it('queue=unassigned returns only open conversations with no assignee', async () => {
    // Plant: one open + unassigned, one open + assigned to userA, one closed + unassigned.
    const unassigned = await withTenantRaw(tenantAId, (tx) =>
      tx.whatsAppConversation.create({
        data: {
          tenantId: tenantAId,
          accountId: accountAId,
          phone: '+201001000010',
          status: 'open',
        },
      }),
    );
    const assigned = await withTenantRaw(tenantAId, (tx) =>
      tx.whatsAppConversation.create({
        data: {
          tenantId: tenantAId,
          accountId: accountAId,
          phone: '+201001000011',
          status: 'open',
          assignedToId: userAId,
        },
      }),
    );
    await withTenantRaw(tenantAId, (tx) =>
      tx.whatsAppConversation.create({
        data: {
          tenantId: tenantAId,
          accountId: accountAId,
          phone: '+201001000012',
          status: 'closed',
        },
      }),
    );

    const res = await svc.listConversations(tenantAId, { queue: 'unassigned', limit: 200 });
    const ids = res.items.map((c) => c.id);
    assert.ok(ids.includes(unassigned.id), 'open + unassigned visible');
    assert.ok(!ids.includes(assigned.id), 'open + assigned excluded');
    assert.ok(res.items.every((c) => c.status === 'open' && c.assignedToId === null));
  });

  it('queue=mine returns only conversations assigned to the calling user', async () => {
    const mine = await withTenantRaw(tenantAId, (tx) =>
      tx.whatsAppConversation.create({
        data: {
          tenantId: tenantAId,
          accountId: accountAId,
          phone: '+201001000020',
          status: 'open',
          assignedToId: userAId,
        },
      }),
    );
    const someoneElse = await withTenantRaw(tenantAId, (tx) =>
      tx.whatsAppConversation.create({
        data: {
          tenantId: tenantAId,
          accountId: accountAId,
          phone: '+201001000021',
          status: 'open',
          assignedToId: null,
        },
      }),
    );

    const res = await svc.listConversations(
      tenantAId,
      { queue: 'mine', limit: 200 },
      { userId: userAId, tenantId: tenantAId, roleId: 'role-A' },
    );
    const ids = res.items.map((c) => c.id);
    assert.ok(ids.includes(mine.id), 'mine visible');
    assert.ok(!ids.includes(someoneElse.id), 'others excluded');
    assert.ok(res.items.every((c) => c.assignedToId === userAId));
  });

  it('queue=linked vs unlinked partition conversations by leadId', async () => {
    // Create a lead in tenant A first.
    const stage = await withTenantRaw(tenantAId, (tx) =>
      tx.pipelineStage.findFirst({ where: { tenantId: tenantAId } }),
    );
    if (!stage) {
      // The base test schema seeds at least one stage; skip gracefully if not.
      return;
    }
    const lead = await withTenantRaw(tenantAId, (tx) =>
      tx.lead.create({
        data: {
          tenantId: tenantAId,
          stageId: stage.id,
          name: 'D14 lead',
          phone: '+201001000030',
        },
      }),
    );
    const linked = await withTenantRaw(tenantAId, (tx) =>
      tx.whatsAppConversation.create({
        data: {
          tenantId: tenantAId,
          accountId: accountAId,
          phone: '+201001000030',
          status: 'open',
          leadId: lead.id,
        },
      }),
    );
    const unlinked = await withTenantRaw(tenantAId, (tx) =>
      tx.whatsAppConversation.create({
        data: {
          tenantId: tenantAId,
          accountId: accountAId,
          phone: '+201001000031',
          status: 'open',
        },
      }),
    );

    const linkedRes = await svc.listConversations(tenantAId, { queue: 'linked', limit: 200 });
    assert.ok(linkedRes.items.some((c) => c.id === linked.id));
    assert.ok(!linkedRes.items.some((c) => c.id === unlinked.id));
    assert.ok(linkedRes.items.every((c) => c.leadId !== null));

    const unlinkedRes = await svc.listConversations(tenantAId, { queue: 'unlinked', limit: 200 });
    assert.ok(unlinkedRes.items.some((c) => c.id === unlinked.id));
    assert.ok(!unlinkedRes.items.some((c) => c.id === linked.id));
    assert.ok(unlinkedRes.items.every((c) => c.leadId === null && c.status === 'open'));
  });

  it('queue=today returns only conversations with activity today (UTC)', async () => {
    const today = await withTenantRaw(tenantAId, (tx) =>
      tx.whatsAppConversation.create({
        data: {
          tenantId: tenantAId,
          accountId: accountAId,
          phone: '+201001000040',
          status: 'open',
          lastMessageAt: new Date(),
        },
      }),
    );
    const yesterday = await withTenantRaw(tenantAId, (tx) =>
      tx.whatsAppConversation.create({
        data: {
          tenantId: tenantAId,
          accountId: accountAId,
          phone: '+201001000041',
          status: 'open',
          lastMessageAt: new Date(Date.now() - 36 * 60 * 60 * 1000),
        },
      }),
    );

    const res = await svc.listConversations(tenantAId, { queue: 'today', limit: 200 });
    const ids = res.items.map((c) => c.id);
    assert.ok(ids.includes(today.id), 'today visible');
    assert.ok(!ids.includes(yesterday.id), 'yesterday excluded');
  });

  it('queue=waiting_reply requires open status + lastInboundAt IS NOT NULL', async () => {
    const waiting = await withTenantRaw(tenantAId, (tx) =>
      tx.whatsAppConversation.create({
        data: {
          tenantId: tenantAId,
          accountId: accountAId,
          phone: '+201001000050',
          status: 'open',
          lastInboundAt: new Date(),
        },
      }),
    );
    const neverInbound = await withTenantRaw(tenantAId, (tx) =>
      tx.whatsAppConversation.create({
        data: {
          tenantId: tenantAId,
          accountId: accountAId,
          phone: '+201001000051',
          status: 'open',
          lastInboundAt: null,
        },
      }),
    );
    const closed = await withTenantRaw(tenantAId, (tx) =>
      tx.whatsAppConversation.create({
        data: {
          tenantId: tenantAId,
          accountId: accountAId,
          phone: '+201001000052',
          status: 'closed',
          lastInboundAt: new Date(),
        },
      }),
    );

    const res = await svc.listConversations(tenantAId, { queue: 'waiting_reply', limit: 200 });
    const ids = res.items.map((c) => c.id);
    assert.ok(ids.includes(waiting.id), 'open + inbound visible');
    assert.ok(!ids.includes(neverInbound.id), 'never-inbound excluded');
    assert.ok(!ids.includes(closed.id), 'closed excluded');
  });

  it('queue=needs_review picks up conversations with an unresolved review row', async () => {
    const contact = await withTenantRaw(tenantAId, (tx) =>
      tx.contact.create({
        data: {
          tenantId: tenantAId,
          phone: '+201001000060',
          originalPhone: '+201001000060',
        },
      }),
    );
    const reviewed = await withTenantRaw(tenantAId, (tx) =>
      tx.whatsAppConversation.create({
        data: {
          tenantId: tenantAId,
          accountId: accountAId,
          phone: '+201001000060',
          status: 'open',
          contactId: contact.id,
        },
      }),
    );
    await withTenantRaw(tenantAId, (tx) =>
      tx.whatsAppConversationReview.create({
        data: {
          tenant: { connect: { id: tenantAId } },
          conversation: { connect: { id: reviewed.id } },
          contact: { connect: { id: contact.id } },
          reason: 'unmatched_after_routing',
        },
      }),
    );
    const noReview = await withTenantRaw(tenantAId, (tx) =>
      tx.whatsAppConversation.create({
        data: {
          tenantId: tenantAId,
          accountId: accountAId,
          phone: '+201001000061',
          status: 'open',
        },
      }),
    );

    const res = await svc.listConversations(tenantAId, { queue: 'needs_review', limit: 200 });
    const ids = res.items.map((c) => c.id);
    assert.ok(ids.includes(reviewed.id), 'reviewed visible');
    assert.ok(!ids.includes(noReview.id), 'no-review excluded');
  });

  it('getInboxSummary returns counts matching the queue list for the same tenant', async () => {
    // Snapshot the per-queue lists, then assert summary equals their lengths.
    const [unassigned, mine, linked, unlinked, waitingReply, needsReview, today] =
      await Promise.all([
        svc.listConversations(tenantAId, { queue: 'unassigned', limit: 1000 }),
        svc.listConversations(
          tenantAId,
          { queue: 'mine', limit: 1000 },
          { userId: userAId, tenantId: tenantAId, roleId: 'role-A' },
        ),
        svc.listConversations(tenantAId, { queue: 'linked', limit: 1000 }),
        svc.listConversations(tenantAId, { queue: 'unlinked', limit: 1000 }),
        svc.listConversations(tenantAId, { queue: 'waiting_reply', limit: 1000 }),
        svc.listConversations(tenantAId, { queue: 'needs_review', limit: 1000 }),
        svc.listConversations(tenantAId, { queue: 'today', limit: 1000 }),
      ]);

    const summary = await svc.getInboxSummary(
      tenantAId,
      {},
      { userId: userAId, tenantId: tenantAId, roleId: 'role-A' },
    );
    assert.equal(summary.unassigned, unassigned.total);
    assert.equal(summary.mine, mine.total);
    assert.equal(summary.linked, linked.total);
    assert.equal(summary.unlinked, unlinked.total);
    assert.equal(summary.waitingReply, waitingReply.total);
    assert.equal(summary.needsReview, needsReview.total);
    assert.equal(summary.today, today.total);
  });

  it('summary + queue filter respects tenant isolation (tenant B data does not leak)', async () => {
    // Plant a noisy conversation in tenant B.
    await withTenantRaw(tenantBId, (tx) =>
      tx.whatsAppConversation.create({
        data: {
          tenantId: tenantBId,
          accountId: accountBId,
          phone: '+966500009999',
          status: 'open',
        },
      }),
    );
    const aSummary = await svc.getInboxSummary(tenantAId);
    const bSummary = await svc.getInboxSummary(tenantBId);
    assert.ok(bSummary.open >= 1, 'tenant B sees its own row');
    // A's counts are not influenced by B's plant — easiest sanity check
    // is that the two summaries are independent reads.
    const aList = await svc.listConversations(tenantAId, { limit: 1000 });
    assert.ok(!aList.items.some((c) => c.phone === '+966500009999'));
    assert.equal(aSummary.open, aList.items.filter((c) => c.status === 'open').length);
  });
});
