/**
 * C25 — WhatsApp ↔ Lead linkage tests.
 *
 * Verifies:
 *   - linkConversationToLead attaches a tenant-scoped lead to a
 *     tenant-scoped conversation;
 *   - relinking to a different lead overwrites (latest wins);
 *   - cross-tenant ids surface as NotFoundException (the FORCE'd RLS
 *     hides them from the service-level lookup);
 *   - lazy auto-link on read attaches the unique-by-phone lead;
 *   - no auto-link when no lead matches the phone;
 *   - pickAutoLinkLead pure-function behaviour for 0 / 1 / 2-match
 *     branches (the (tenantId, phone) unique on `leads` makes the 2-
 *     match branch impossible at the integration layer, so we cover
 *     it via the helper directly).
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { MetaCloudProvider, type FetchFn } from './meta-cloud.provider';
import { WhatsAppService, pickAutoLinkLead } from './whatsapp.service';

const TENANT_A_CODE = '__c25_wa_a__';
const TENANT_B_CODE = '__c25_wa_b__';

let prisma: PrismaClient;
let svc: WhatsAppService;
let tenantAId: string;
let tenantBId: string;
let stageANewId: string;
let stageBNewId: string;
let accountAId: string;
let accountBId: string;

async function withTenantRaw<T>(tid: string, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return prisma.$transaction(async (tx: any) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.tenant_id = '${tid}'`);
    return fn(tx);
  });
}

async function ensurePipelineStage(tenantId: string): Promise<string> {
  return withTenantRaw(tenantId, async (tx) => {
    const existing = await tx.pipeline.findFirst({
      where: { tenantId, isDefault: true },
      select: { id: true },
    });
    const pipelineId =
      existing?.id ??
      (
        await tx.pipeline.create({
          data: { tenantId, name: 'Default', isDefault: true, isActive: true },
          select: { id: true },
        })
      ).id;
    const stage = await tx.pipelineStage.upsert({
      where: { pipelineId_code: { pipelineId, code: 'new' } },
      update: {},
      create: {
        tenantId,
        pipelineId,
        code: 'new',
        name: 'New',
        order: 10,
        isTerminal: false,
      },
    });
    return stage.id;
  });
}

describe('whatsapp — chat-to-lead linkage (C25)', () => {
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
      create: { code: TENANT_A_CODE, name: 'C25 WA tenant A' },
    });
    tenantAId = a.id;
    const b = await prisma.tenant.upsert({
      where: { code: TENANT_B_CODE },
      update: { isActive: true },
      create: { code: TENANT_B_CODE, name: 'C25 WA tenant B' },
    });
    tenantBId = b.id;

    stageANewId = await ensurePipelineStage(tenantAId);
    stageBNewId = await ensurePipelineStage(tenantBId);

    const accountA = await withTenantRaw(tenantAId, (tx) =>
      tx.whatsAppAccount.upsert({
        where: { phoneNumberId: 'PNID-C25-A' },
        update: {},
        create: {
          tenantId: tenantAId,
          displayName: 'C25 Account A',
          phoneNumber: '+201111000099',
          phoneNumberId: 'PNID-C25-A',
          provider: 'meta_cloud',
          accessToken: 'token-a',
          appSecret: null,
          verifyToken: 'verify-c25-a',
        },
      }),
    );
    accountAId = accountA.id;

    const accountB = await withTenantRaw(tenantBId, (tx) =>
      tx.whatsAppAccount.upsert({
        where: { phoneNumberId: 'PNID-C25-B' },
        update: {},
        create: {
          tenantId: tenantBId,
          displayName: 'C25 Account B',
          phoneNumber: '+966222000099',
          phoneNumberId: 'PNID-C25-B',
          provider: 'meta_cloud',
          accessToken: 'token-b',
          appSecret: null,
          verifyToken: 'verify-c25-b',
        },
      }),
    );
    accountBId = accountB.id;
  });

  after(async () => {
    await prisma.tenant.delete({ where: { code: TENANT_A_CODE } }).catch(() => {});
    await prisma.tenant.delete({ where: { code: TENANT_B_CODE } }).catch(() => {});
    await prisma.$disconnect();
  });

  // Helper: create a fresh conversation row directly (bypasses webhook).
  async function makeConversation(
    tenantId: string,
    accountId: string,
    phone: string,
  ): Promise<string> {
    return withTenantRaw(tenantId, async (tx) => {
      const c = await tx.whatsAppConversation.create({
        data: { tenantId, accountId, phone, status: 'open' },
        select: { id: true },
      });
      return c.id;
    });
  }

  async function makeLead(
    tenantId: string,
    stageId: string,
    name: string,
    phone: string,
  ): Promise<string> {
    return withTenantRaw(tenantId, async (tx) => {
      const lead = await tx.lead.create({
        data: { tenantId, stageId, name, phone, source: 'manual' },
        select: { id: true },
      });
      return lead.id;
    });
  }

  it('linkConversationToLead attaches a same-tenant lead', async () => {
    const convoId = await makeConversation(tenantAId, accountAId, '+201001100025');
    const leadId = await makeLead(tenantAId, stageANewId, 'Lead Linked', '+201001100025');

    const linked = await svc.linkConversationToLead(tenantAId, convoId, leadId);
    assert.equal(linked.id, convoId);
    assert.equal(linked.leadId, leadId);

    // findConversationById returns the lead inline.
    const fetched = await svc.findConversationById(tenantAId, convoId);
    assert.equal(fetched?.leadId, leadId);
    assert.ok(fetched?.lead);
    assert.equal(fetched?.lead?.id, leadId);
    assert.equal(fetched?.lead?.name, 'Lead Linked');
  });

  it('relinking to a different lead overwrites (latest wins)', async () => {
    const convoId = await makeConversation(tenantAId, accountAId, '+201001100026');
    const leadOne = await makeLead(tenantAId, stageANewId, 'First lead', '+201002200026');
    const leadTwo = await makeLead(tenantAId, stageANewId, 'Second lead', '+201003300026');

    const r1 = await svc.linkConversationToLead(tenantAId, convoId, leadOne);
    assert.equal(r1.leadId, leadOne);

    const r2 = await svc.linkConversationToLead(tenantAId, convoId, leadTwo);
    assert.equal(r2.leadId, leadTwo);

    const fetched = await svc.findConversationById(tenantAId, convoId);
    assert.equal(fetched?.leadId, leadTwo);
    assert.equal(fetched?.lead?.name, 'Second lead');
  });

  it('rejects cross-tenant lead with 404 (lead invisible under tenant A RLS)', async () => {
    const convoId = await makeConversation(tenantAId, accountAId, '+201001100027');
    // A lead in tenant B — invisible to tenant A.
    const tenantBLeadId = await makeLead(tenantBId, stageBNewId, 'Tenant B lead', '+966500110027');
    await assert.rejects(
      () => svc.linkConversationToLead(tenantAId, convoId, tenantBLeadId),
      (err: unknown) =>
        err instanceof NotFoundException &&
        // The lead lookup runs first when both ids are valid uuids; a
        // cross-tenant lead surfaces as `lead_not_found`.
        (err.getResponse() as { code?: string }).code === 'whatsapp.lead_not_found',
    );
  });

  it('rejects cross-tenant conversation with 404', async () => {
    const tenantBConvoId = await makeConversation(tenantBId, accountBId, '+966500110028');
    const tenantALeadId = await makeLead(
      tenantAId,
      stageANewId,
      'Tenant A lead C',
      '+201001100028',
    );
    await assert.rejects(
      () => svc.linkConversationToLead(tenantAId, tenantBConvoId, tenantALeadId),
      (err: unknown) =>
        err instanceof NotFoundException &&
        (err.getResponse() as { code?: string }).code === 'whatsapp.conversation_not_found',
    );
  });

  it('auto-links on read when exactly one tenant-scoped lead matches phone', async () => {
    const phone = '+201001100029';
    const convoId = await makeConversation(tenantAId, accountAId, phone);
    const leadId = await makeLead(tenantAId, stageANewId, 'Auto match', phone);

    // Sanity: the lead is NOT linked yet at the row level.
    const before = await withTenantRaw(tenantAId, (tx) =>
      tx.whatsAppConversation.findUnique({
        where: { id: convoId },
        select: { leadId: true },
      }),
    );
    assert.equal(before?.leadId, null);

    const fetched = await svc.findConversationById(tenantAId, convoId);
    assert.equal(fetched?.leadId, leadId, 'auto-linked the unique-phone lead');
    assert.equal(fetched?.lead?.id, leadId);

    // The auto-link is persisted, not just hydrated for this read.
    const after = await withTenantRaw(tenantAId, (tx) =>
      tx.whatsAppConversation.findUnique({
        where: { id: convoId },
        select: { leadId: true },
      }),
    );
    assert.equal(after?.leadId, leadId);
  });

  it('does not auto-link when no lead matches the phone', async () => {
    const convoId = await makeConversation(tenantAId, accountAId, '+201001100030');
    // Deliberately do NOT create a matching lead.
    const fetched = await svc.findConversationById(tenantAId, convoId);
    assert.equal(fetched?.leadId, null);
    assert.equal(fetched?.lead, null);
  });

  it('does not auto-link across tenants — a tenant-B lead does not attach to a tenant-A conversation', async () => {
    const phone = '+201001100031';
    const convoId = await makeConversation(tenantAId, accountAId, phone);
    // Lead with the SAME phone, but in tenant B.
    await makeLead(tenantBId, stageBNewId, 'Cross-tenant phone match', phone);

    const fetched = await svc.findConversationById(tenantAId, convoId);
    assert.equal(fetched?.leadId, null, 'cross-tenant lead must not auto-link');
  });

  it('auto-links via listConversationMessages too', async () => {
    const phone = '+201001100032';
    const convoId = await makeConversation(tenantAId, accountAId, phone);
    const leadId = await makeLead(tenantAId, stageANewId, 'Msg auto link', phone);

    await svc.listConversationMessages(tenantAId, convoId, { limit: 50 });
    const after = await withTenantRaw(tenantAId, (tx) =>
      tx.whatsAppConversation.findUnique({
        where: { id: convoId },
        select: { leadId: true },
      }),
    );
    assert.equal(after?.leadId, leadId);
  });

  // ─── C26: phone normalization parity between WhatsApp inbound and lead.
  // The WhatsApp parser used to slap a `+` on the raw `from` value via a
  // local helper. If a conversation row was written before C26 (or via a
  // future code path that bypasses the normaliser), its phone could be
  // non-canonical. C26 has the auto-link defensively run normalizeE164
  // on conversation.phone so that case still matches a canonical lead.
  it('auto-links a conversation persisted with a bare-digit phone to a +E.164 lead (C26)', async () => {
    // Simulate a legacy / non-canonical conversation row by writing
    // directly through the raw client (bypasses the parser fix).
    const rawPhone = '201001100099';
    const canonical = '+201001100099';

    const convoId = await withTenantRaw(tenantAId, async (tx) => {
      const c = await tx.whatsAppConversation.create({
        data: { tenantId: tenantAId, accountId: accountAId, phone: rawPhone, status: 'open' },
        select: { id: true },
      });
      return c.id;
    });
    const leadId = await makeLead(tenantAId, stageANewId, 'C26 match', canonical);

    const fetched = await svc.findConversationById(tenantAId, convoId);
    assert.equal(fetched?.leadId, leadId, 'auto-link must reach across the +/no-+ boundary');
    assert.equal(fetched?.lead?.id, leadId);
  });

  it('still auto-links cleanly when both sides are already canonical (C26 regression)', async () => {
    const phone = '+201001100098';
    const convoId = await makeConversation(tenantAId, accountAId, phone);
    const leadId = await makeLead(tenantAId, stageANewId, 'Canonical both', phone);

    const fetched = await svc.findConversationById(tenantAId, convoId);
    assert.equal(fetched?.leadId, leadId);
  });

  it('does not auto-link when the conversation phone cannot be coerced to E.164 (C26)', async () => {
    // Junk phone — neither E.164 nor a country-code-prefixed digit string.
    // Defensive normalisation skips auto-link rather than throwing out of
    // the read path.
    const convoId = await withTenantRaw(tenantAId, async (tx) => {
      const c = await tx.whatsAppConversation.create({
        data: { tenantId: tenantAId, accountId: accountAId, phone: 'garbage', status: 'open' },
        select: { id: true },
      });
      return c.id;
    });
    const fetched = await svc.findConversationById(tenantAId, convoId);
    assert.equal(fetched?.leadId, null);
    assert.equal(fetched?.lead, null);
  });

  // ─── Pure helper: covers the no-match / single-match / multi-match
  // policy without needing to violate the (tenantId, phone) unique.
  it('pickAutoLinkLead returns null on 0 matches', () => {
    assert.equal(pickAutoLinkLead([]), null);
  });
  it('pickAutoLinkLead returns the row on exactly 1 match', () => {
    const row = { id: 'l1' };
    assert.equal(pickAutoLinkLead([row]), row);
  });
  it('pickAutoLinkLead returns null on >1 matches (no fuzzy guess)', () => {
    assert.equal(pickAutoLinkLead([{ id: 'l1' }, { id: 'l2' }]), null);
  });
});
