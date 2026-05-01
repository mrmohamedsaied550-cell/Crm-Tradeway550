/**
 * P2-12 — WhatsApp templates + media + 24h-window tests.
 *
 * Real Postgres + a throwaway tenant. Stub provider so we don't
 * actually call Meta. Covers:
 *
 *   Templates CRUD:
 *     - create + listForAccount + variableCount inferred from `{{N}}`
 *     - duplicate (account, name, language) → typed conflict
 *     - update flips status, recomputes variableCount on body change
 *
 *   24h customer-service window:
 *     - sendText denies a brand-new conversation (no inbound yet)
 *     - sendText denies a stale conversation (lastInboundAt > 24h ago)
 *     - sendText allows a fresh window
 *     - sendMedia honours the same gate
 *     - sendTemplate is allowed irrespective of the window
 *
 *   sendTemplate:
 *     - rejects unknown template name
 *     - rejects variable-count mismatch
 *     - persists messageType='template' + templateName + templateLanguage
 *
 *   sendMedia:
 *     - persists messageType='image'/'document' + mediaUrl + caption
 */

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { encryptSecret } from '../common/crypto';
import { PrismaService } from '../prisma/prisma.service';
import { tenantContext } from '../tenants/tenant-context';
import { countTemplateVariables, WhatsAppTemplatesService } from './whatsapp-templates.service';
import { MetaCloudProvider, type FetchFn } from './meta-cloud.provider';
import { WhatsAppService } from './whatsapp.service';

const TENANT_CODE = '__p2_12_whatsapp__';

let prisma: PrismaClient;
let prismaSvc: PrismaService;
let svc: WhatsAppService;
let templates: WhatsAppTemplatesService;
let tenantId: string;
let accountId: string;
let actorUserId: string;

let lastFetchUrl: string | null = null;
let lastFetchBody: string | null = null;
const fakeFetch: FetchFn = async (url, init) => {
  lastFetchUrl = url;
  lastFetchBody = typeof init?.body === 'string' ? init.body : null;
  return {
    ok: true,
    status: 200,
    text: async () => '',
    json: async () => ({ messages: [{ id: `wamid.${Math.random().toString(36).slice(2)}` }] }),
  };
};

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

async function setLastInboundAt(phone: string, at: Date | null): Promise<void> {
  await withTenantRaw(tenantId, async (tx) => {
    const existing = await tx.whatsAppConversation.findFirst({
      where: { accountId, phone },
      select: { id: true },
    });
    if (existing) {
      await tx.whatsAppConversation.update({
        where: { id: existing.id },
        data: { lastInboundAt: at },
      });
    } else {
      await tx.whatsAppConversation.create({
        data: {
          tenantId,
          accountId,
          phone,
          status: 'open',
          lastMessageAt: new Date(),
          lastMessageText: '',
          lastInboundAt: at,
        },
      });
    }
  });
}

describe('whatsapp — templates + media + 24h window (P2-12)', () => {
  before(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    prismaSvc = new PrismaService();
    const provider = new MetaCloudProvider(fakeFetch);
    svc = new WhatsAppService(prismaSvc, provider);
    const audit = new AuditService(prismaSvc);
    templates = new WhatsAppTemplatesService(prismaSvc, audit);

    const tenant = await prisma.tenant.upsert({
      where: { code: TENANT_CODE },
      update: { isActive: true },
      create: { code: TENANT_CODE, name: 'P2-12 whatsapp' },
    });
    tenantId = tenant.id;

    await withTenantRaw(tenantId, async (tx) => {
      const role = await tx.role.create({
        data: { tenantId, code: 'sales_agent', nameAr: 'وكيل', nameEn: 'Sales', level: 30 },
      });
      const actor = await tx.user.create({
        data: {
          tenantId,
          email: 'p212-actor@test',
          name: 'Actor',
          passwordHash: 'x',
          roleId: role.id,
        },
      });
      actorUserId = actor.id;
      const account = await tx.whatsAppAccount.create({
        data: {
          tenantId,
          displayName: 'P2-12 account',
          phoneNumber: '+201001000001',
          phoneNumberId: 'PNID-P212',
          provider: 'meta_cloud',
          accessToken: encryptSecret('p212-token'),
          appSecret: 'p212-secret',
          verifyToken: 'verify-p212',
          isActive: true,
        },
      });
      accountId = account.id;
    });
  });

  after(async () => {
    await prisma.tenant.delete({ where: { code: TENANT_CODE } }).catch(() => {});
    await prisma.$disconnect();
  });

  beforeEach(() => {
    lastFetchUrl = null;
    lastFetchBody = null;
  });

  // ─── countTemplateVariables util ────────────────────────────────

  it('countTemplateVariables tracks the highest positional index', () => {
    assert.equal(countTemplateVariables('Hi {{1}} from {{2}}'), 2);
    assert.equal(countTemplateVariables('No vars'), 0);
    // Sparse indices: {{1}} {{3}} → 3 (positional, gap counts).
    assert.equal(countTemplateVariables('A {{1}} skip {{3}}'), 3);
  });

  // ─── templates CRUD ─────────────────────────────────────────────

  it('create stores the template + computes variableCount', async () => {
    const tpl = await inTenant(() =>
      templates.create(
        {
          accountId,
          name: 'appointment_reminder',
          language: 'en',
          category: 'utility',
          bodyText: 'Hi {{1}}, your appointment is at {{2}}.',
          status: 'approved',
        },
        actorUserId,
      ),
    );
    assert.equal(tpl.variableCount, 2);
    assert.equal(tpl.status, 'approved');
  });

  it('create rejects a duplicate (account, name, language)', async () => {
    await assert.rejects(
      () =>
        inTenant(() =>
          templates.create(
            {
              accountId,
              name: 'appointment_reminder',
              language: 'en',
              category: 'utility',
              bodyText: 'Different body',
              status: 'approved',
            },
            actorUserId,
          ),
        ),
      /already exists/,
    );
  });

  it('update flips status and recomputes variableCount on body change', async () => {
    const list = await inTenant(() => templates.list({ accountId }));
    const tpl = list.find((t) => t.name === 'appointment_reminder');
    assert.ok(tpl);
    const updated = await inTenant(() =>
      templates.update(
        tpl!.id,
        { bodyText: 'Hello {{1}}, {{2}}, {{3}}!', status: 'paused' },
        actorUserId,
      ),
    );
    assert.equal(updated.variableCount, 3);
    assert.equal(updated.status, 'paused');
  });

  // ─── 24h window gate ────────────────────────────────────────────

  it('sendText denies a brand-new conversation (no inbound yet)', async () => {
    await assert.rejects(
      () =>
        svc.sendText({
          tenantId,
          accountId,
          to: '+201001212001',
          text: 'hi',
        }),
      /Cannot send a freeform message before the contact has replied/,
    );
  });

  it('sendText denies a stale conversation (lastInboundAt > 24h ago)', async () => {
    await setLastInboundAt('+201001212002', new Date(Date.now() - 25 * 60 * 60 * 1000));
    await assert.rejects(
      () =>
        svc.sendText({
          tenantId,
          accountId,
          to: '+201001212002',
          text: 'late reply',
        }),
      /Customer-service window expired/,
    );
  });

  it('sendText allows a fresh window', async () => {
    await setLastInboundAt('+201001212003', new Date(Date.now() - 60_000));
    const out = await svc.sendText({
      tenantId,
      accountId,
      to: '+201001212003',
      text: 'within window',
    });
    assert.ok(out.providerMessageId.startsWith('wamid.'));
  });

  it('sendMedia honours the same gate as sendText', async () => {
    await assert.rejects(
      () =>
        svc.sendMedia({
          tenantId,
          accountId,
          to: '+201001212010',
          kind: 'image',
          mediaUrl: 'https://cdn.test/x.jpg',
          caption: 'closed window',
        }),
      /freeform message before the contact has replied|Customer-service window expired/,
    );
  });

  // ─── sendTemplate ───────────────────────────────────────────────

  it('sendTemplate is allowed irrespective of the window', async () => {
    // The previous "update" test left the template paused; re-approve
    // so the sendTemplate filter (`status='approved'`) finds it.
    await withTenantRaw(tenantId, async (tx) => {
      await tx.whatsAppTemplate.updateMany({
        where: { name: 'appointment_reminder', language: 'en' },
        data: { status: 'approved' },
      });
    });
    // No prior inbound on this number.
    const out = await svc.sendTemplate({
      tenantId,
      accountId,
      to: '+201001212020',
      templateName: 'appointment_reminder',
      language: 'en',
      // The previous "update" test left it at 3 variables.
      variables: ['Hassan', '15:00', 'Cairo'],
    });
    assert.ok(out.providerMessageId.startsWith('wamid.'));
    // The persisted message carries the template metadata.
    const msg = await withTenantRaw(tenantId, (tx) =>
      tx.whatsAppMessage.findFirst({
        where: { providerMessageId: out.providerMessageId },
        select: {
          messageType: true,
          templateName: true,
          templateLanguage: true,
          text: true,
        },
      }),
    );
    assert.equal(msg?.messageType, 'template');
    assert.equal(msg?.templateName, 'appointment_reminder');
    assert.equal(msg?.templateLanguage, 'en');
    // Body text is rendered with the variables substituted.
    assert.equal(msg?.text, 'Hello Hassan, 15:00, Cairo!');
  });

  it('sendTemplate rejects an unknown template', async () => {
    await assert.rejects(
      () =>
        svc.sendTemplate({
          tenantId,
          accountId,
          to: '+201001212021',
          templateName: 'no_such_template',
          language: 'en',
          variables: [],
        }),
      /not found/,
    );
  });

  it('sendTemplate rejects a variable-count mismatch', async () => {
    await assert.rejects(
      () =>
        svc.sendTemplate({
          tenantId,
          accountId,
          to: '+201001212022',
          templateName: 'appointment_reminder',
          language: 'en',
          variables: ['only_one'],
        }),
      /expects 3 variables/,
    );
  });

  // ─── sendMedia happy path ───────────────────────────────────────

  it('sendMedia persists the row with messageType + mediaUrl + caption', async () => {
    await setLastInboundAt('+201001212030', new Date(Date.now() - 60_000));
    const out = await svc.sendMedia({
      tenantId,
      accountId,
      to: '+201001212030',
      kind: 'image',
      mediaUrl: 'https://cdn.test/photo.jpg',
      mediaMimeType: 'image/jpeg',
      caption: 'see attached',
    });
    const msg = await withTenantRaw(tenantId, (tx) =>
      tx.whatsAppMessage.findFirst({
        where: { providerMessageId: out.providerMessageId },
        select: {
          messageType: true,
          mediaUrl: true,
          mediaMimeType: true,
          text: true,
        },
      }),
    );
    assert.equal(msg?.messageType, 'image');
    assert.equal(msg?.mediaUrl, 'https://cdn.test/photo.jpg');
    assert.equal(msg?.mediaMimeType, 'image/jpeg');
    assert.equal(msg?.text, 'see attached');
    assert.ok(lastFetchUrl?.endsWith('/PNID-P212/messages'));
    // Sanity: payload carries `type: 'image'` + `image: { link, caption }`.
    assert.match(lastFetchBody ?? '', /"type":"image"/);
    assert.match(lastFetchBody ?? '', /"link":"https:\/\/cdn\.test\/photo\.jpg"/);
  });
});
