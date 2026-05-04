/**
 * Phase C — C10B-3: WhatsAppInboundService orchestrator tests.
 *
 * Throwaway tenant with one company / one country / one team, two
 * sales agents (Alice + Bob), and one WhatsApp account. Tests cover
 * the full branching matrix:
 *
 *   • unknown phone, no rule, agents available → routed via default
 *     strategy + lead auto-created + audit + notification
 *   • unknown phone, NO eligible agents → review queue with
 *     reason='unmatched_after_routing'; NO lead, NO assignment
 *   • active captain phone → review queue with reason='captain_active';
 *     Contact.isCaptain set; NO lead
 *   • exactly 1 matching open lead → conversation linked, ownership
 *     denormalised from the lead; NO new lead
 *   • 2+ matching open leads → review queue with reason='duplicate_lead'
 *   • profile-name latest-wins on the Contact
 *   • idempotent webhook: duplicate providerMessageId returns null
 *   • feature flag off → falls back to legacy persistInbound (no
 *     contact, no routing, no review queue)
 */

import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { LeadsService } from '../crm/leads.service';
import { LostReasonsService } from '../crm/lost-reasons.service';
import { PipelineService } from '../crm/pipeline.service';
import { SlaService } from '../crm/sla.service';
import { AssignmentService } from '../crm/assignment.service';
import { AgentCapacitiesService } from '../distribution/capacities.service';
import { DistributionService } from '../distribution/distribution.service';
import { LeadRoutingLogService } from '../distribution/routing-log.service';
import { DistributionRulesService } from '../distribution/rules.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { tenantContext } from '../tenants/tenant-context';
import { TenantSettingsService } from '../tenants/tenant-settings.service';

import { MetaCloudProvider } from './meta-cloud.provider';
import { WhatsAppInboundService } from './whatsapp-inbound.service';
import type { InboundMessage } from './whatsapp.provider';
import { WhatsAppService, type RoutedAccount } from './whatsapp.service';

const TENANT_CODE = '__c10b3_inbound__';

let prisma: PrismaClient;
let prismaSvc: PrismaService;
let svc: WhatsAppInboundService;
let whatsappSvc: WhatsAppService;
let leads: LeadsService;
let distribution: DistributionService;

let tenantId: string;
let companyId: string;
let countryId: string;
let teamId: string;
let aliceId: string;
let bobId: string;
let salesRoleId: string;
let pipelineId: string;
let stageNewId: string;
let stageWonId: string;
let accountId: string;
let account: RoutedAccount;

let providerMessageCounter = 1;

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

function buildMessage(input: {
  phone: string;
  text?: string;
  profileName?: string;
  providerMessageId?: string;
  receivedAt?: Date;
}): InboundMessage {
  return {
    phone: input.phone,
    text: input.text ?? 'hello from a customer',
    providerMessageId: input.providerMessageId ?? `wamid.C10B3-${providerMessageCounter++}`,
    receivedAt: input.receivedAt ?? new Date(),
    phoneNumberId: 'PNID-C10B3',
    profileName: input.profileName,
    waId: input.phone.replace(/^\+/, ''),
  };
}

describe('whatsapp — inbound orchestrator (C10B-3)', () => {
  before(async () => {
    process.env['WHATSAPP_INBOUND_V2'] = 'true';
    prisma = new PrismaClient();
    await prisma.$connect();
    prismaSvc = new PrismaService();
    const audit = new AuditService(prismaSvc);
    const notifications = new NotificationsService(prismaSvc);
    const tenantSettings = new TenantSettingsService(prismaSvc, audit);
    const pipelineSvc = new PipelineService(prismaSvc);
    const lostReasons = new LostReasonsService(prismaSvc);
    const assignment = new AssignmentService(prismaSvc);
    const sla = new SlaService(prismaSvc, assignment, undefined, tenantSettings);
    const rules = new DistributionRulesService(prismaSvc);
    const capacities = new AgentCapacitiesService(prismaSvc);
    const routingLog = new LeadRoutingLogService(prismaSvc);
    distribution = new DistributionService(
      prismaSvc,
      rules,
      capacities,
      routingLog,
      tenantSettings,
    );
    leads = new LeadsService(
      prismaSvc,
      pipelineSvc,
      sla,
      tenantSettings,
      distribution,
      undefined,
      lostReasons,
    );
    whatsappSvc = new WhatsAppService(prismaSvc, new MetaCloudProvider(), notifications);
    svc = new WhatsAppInboundService(
      prismaSvc,
      whatsappSvc,
      leads,
      distribution,
      tenantSettings,
      audit,
      notifications,
    );

    const tenant = await prisma.tenant.upsert({
      where: { code: TENANT_CODE },
      update: { isActive: true },
      create: { code: TENANT_CODE, name: 'C10B-3 inbound test' },
    });
    tenantId = tenant.id;

    await withTenantRaw(tenantId, async (tx) => {
      await tx.tenantSettings.upsert({
        where: { tenantId },
        update: {},
        create: { tenantId, timezone: 'Africa/Cairo', slaMinutes: 60, defaultDialCode: '+20' },
      });

      const company = await tx.company.create({
        data: { tenantId, code: 'acme', name: 'ACME' },
      });
      companyId = company.id;
      const country = await tx.country.create({
        data: { tenantId, companyId, code: 'EG', name: 'Egypt' },
      });
      countryId = country.id;
      const team = await tx.team.create({
        data: { tenantId, countryId, name: 'Sales' },
      });
      teamId = team.id;

      const role = await tx.role.upsert({
        where: { tenantId_code: { tenantId, code: 'sales_agent' } },
        update: {},
        create: {
          tenantId,
          code: 'sales_agent',
          nameAr: 'وكيل',
          nameEn: 'Sales Agent',
          level: 30,
        },
      });
      salesRoleId = role.id;

      const alice = await tx.user.create({
        data: {
          tenantId,
          email: 'c10b3-alice@test',
          name: 'Alice',
          passwordHash: 'x',
          status: 'active',
          roleId: salesRoleId,
          teamId,
        },
      });
      aliceId = alice.id;

      const bob = await tx.user.create({
        data: {
          tenantId,
          email: 'c10b3-bob@test',
          name: 'Bob',
          passwordHash: 'x',
          status: 'active',
          roleId: salesRoleId,
          teamId,
        },
      });
      bobId = bob.id;

      const pipeline = await tx.pipeline.create({
        data: { tenantId, name: 'Default', isDefault: true, isActive: true },
      });
      pipelineId = pipeline.id;
      const stageNew = await tx.pipelineStage.create({
        data: { tenantId, pipelineId, code: 'new', name: 'New', order: 10 },
      });
      stageNewId = stageNew.id;
      const stageWon = await tx.pipelineStage.create({
        data: {
          tenantId,
          pipelineId,
          code: 'converted',
          name: 'Converted',
          order: 99,
          isTerminal: true,
          terminalKind: 'won',
        },
      });
      stageWonId = stageWon.id;

      const acc = await tx.whatsAppAccount.create({
        data: {
          tenantId,
          displayName: 'Test acc',
          phoneNumber: '+200000000000',
          phoneNumberId: 'PNID-C10B3',
          provider: 'meta_cloud',
          accessToken: 'tok',
          verifyToken: 'verify',
        },
      });
      accountId = acc.id;
    });

    account = {
      id: accountId,
      tenantId,
      provider: 'meta_cloud',
      appSecret: null,
      verifyToken: 'verify',
    };
  });

  after(async () => {
    delete process.env['WHATSAPP_INBOUND_V2'];
    await prisma.tenant.delete({ where: { code: TENANT_CODE } }).catch(() => {});
    await prisma.$disconnect();
  });

  // Reset between tests so state from one branch doesn't leak into the
  // next. Each `it` runs an inbound; we wipe leads + contacts +
  // conversations + reviews + audit between them.
  afterEach(async () => {
    await withTenantRaw(tenantId, async (tx) => {
      await tx.whatsAppConversationReview.deleteMany({ where: { tenantId } });
      await tx.whatsAppMessage.deleteMany({ where: { tenantId } });
      await tx.whatsAppConversation.deleteMany({ where: { tenantId } });
      await tx.leadActivity.deleteMany({ where: { tenantId } });
      await tx.lead.deleteMany({ where: { tenantId } });
      await tx.captain.deleteMany({ where: { tenantId } });
      await tx.contact.deleteMany({ where: { tenantId } });
      await tx.notification.deleteMany({ where: { tenantId } });
      await tx.auditEvent.deleteMany({ where: { tenantId } });
      await tx.leadRoutingLog.deleteMany({ where: { tenantId } });
    });
  });

  it('unknown phone + no rule → routes via default strategy + creates lead + audits', async () => {
    const msg = buildMessage({ phone: '+201001000001', profileName: 'New Customer' });

    const result = await inTenant(() => svc.handleInbound(account, msg));
    assert.ok(result?.conversationId);

    // Lead was created with source='whatsapp', assigned to a sales agent.
    const leadsRows = await withTenantRaw(tenantId, (tx) =>
      tx.lead.findMany({ where: { tenantId } }),
    );
    assert.equal(leadsRows.length, 1);
    const lead = leadsRows[0]!;
    assert.equal(lead.source, 'whatsapp');
    assert.ok(lead.assignedToId === aliceId || lead.assignedToId === bobId);
    assert.equal(lead.lifecycleState, 'open');

    // Conversation was linked + denormalised.
    const conv = await withTenantRaw(tenantId, (tx) =>
      tx.whatsAppConversation.findUnique({ where: { id: result!.conversationId } }),
    );
    assert.equal(conv?.leadId, lead.id);
    assert.equal(conv?.assignedToId, lead.assignedToId);
    assert.equal(conv?.assignmentSource, 'inbound_route');
    assert.ok(conv?.contactId);

    // Audit verbs: lead.created_from_whatsapp + whatsapp.conversation.assigned
    const verbs = await withTenantRaw(tenantId, async (tx) => {
      const rows = await tx.auditEvent.findMany({
        where: { tenantId },
        select: { action: true },
      });
      return rows.map((r) => r.action).sort();
    });
    assert.ok(verbs.includes('lead.created_from_whatsapp'));
    assert.ok(verbs.includes('whatsapp.conversation.assigned'));

    // Notification rang.
    const notifs = await withTenantRaw(tenantId, (tx) =>
      tx.notification.findMany({ where: { tenantId } }),
    );
    assert.equal(notifs.length, 1);
    assert.equal(notifs[0]?.kind, 'whatsapp.conversation.assigned');
  });

  it('no eligible agents → review queue (unmatched_after_routing), NO lead', async () => {
    // Disable both agents.
    await withTenantRaw(tenantId, (tx) =>
      tx.user.updateMany({
        where: { id: { in: [aliceId, bobId] } },
        data: { status: 'disabled' },
      }),
    );
    try {
      const msg = buildMessage({ phone: '+201001000002' });
      const result = await inTenant(() => svc.handleInbound(account, msg));
      assert.ok(result);

      const leadsRows = await withTenantRaw(tenantId, (tx) =>
        tx.lead.findMany({ where: { tenantId } }),
      );
      assert.equal(leadsRows.length, 0, 'no lead should be created when routing fails');

      const review = await withTenantRaw(tenantId, (tx) =>
        tx.whatsAppConversationReview.findFirst({ where: { tenantId } }),
      );
      assert.equal(review?.reason, 'unmatched_after_routing');

      const conv = await withTenantRaw(tenantId, (tx) =>
        tx.whatsAppConversation.findUnique({ where: { id: result!.conversationId } }),
      );
      assert.equal(conv?.assignedToId, null);
      assert.equal(conv?.assignmentSource, null);
      assert.ok(conv?.contactId, 'contact still linked even when routing fails');

      const verbs = await withTenantRaw(tenantId, async (tx) => {
        const rows = await tx.auditEvent.findMany({
          where: { tenantId },
          select: { action: true },
        });
        return rows.map((r) => r.action);
      });
      assert.ok(verbs.includes('whatsapp.conversation.review_queued'));
    } finally {
      await withTenantRaw(tenantId, (tx) =>
        tx.user.updateMany({
          where: { id: { in: [aliceId, bobId] } },
          data: { status: 'active' },
        }),
      );
    }
  });

  it('active captain phone → review queue (captain_active), NO lead, isCaptain set', async () => {
    // Seed a captain on a converted lead with a specific phone.
    const captainPhone = '+201002000003';
    await withTenantRaw(tenantId, async (tx) => {
      const captainLead = await tx.lead.create({
        data: {
          tenantId,
          stageId: stageWonId,
          pipelineId,
          name: 'Existing captain',
          phone: captainPhone,
          source: 'manual',
          companyId,
          countryId,
          lifecycleState: 'won',
          assignedToId: aliceId,
        },
      });
      await tx.captain.create({
        data: {
          tenantId,
          leadId: captainLead.id,
          name: 'Existing captain',
          phone: captainPhone,
          status: 'active',
          onboardingStatus: 'in_progress',
          teamId,
        },
      });
    });

    const beforeCount = await withTenantRaw(tenantId, (tx) =>
      tx.lead.count({ where: { tenantId } }),
    );

    const msg = buildMessage({ phone: captainPhone, profileName: 'Captain Mo' });
    const result = await inTenant(() => svc.handleInbound(account, msg));
    assert.ok(result);

    const afterCount = await withTenantRaw(tenantId, (tx) =>
      tx.lead.count({ where: { tenantId } }),
    );
    assert.equal(afterCount, beforeCount, 'captain phone must NOT create a new sales lead');

    const review = await withTenantRaw(tenantId, (tx) =>
      tx.whatsAppConversationReview.findFirst({ where: { tenantId } }),
    );
    assert.equal(review?.reason, 'captain_active');
    assert.ok(review?.candidateCaptainId);

    const contact = await withTenantRaw(tenantId, (tx) =>
      tx.contact.findUnique({ where: { tenantId_phone: { tenantId, phone: captainPhone } } }),
    );
    assert.equal(contact?.isCaptain, true);
  });

  it('1 matching open lead → conversation linked, ownership denormalised, no new lead', async () => {
    const phone = '+201003000004';
    let existingLeadId = '';
    await withTenantRaw(tenantId, async (tx) => {
      const l = await tx.lead.create({
        data: {
          tenantId,
          stageId: stageNewId,
          pipelineId,
          name: 'Existing lead',
          phone,
          source: 'manual',
          assignedToId: bobId,
          companyId,
          countryId,
          lifecycleState: 'open',
        },
      });
      existingLeadId = l.id;
    });
    const beforeCount = await withTenantRaw(tenantId, (tx) =>
      tx.lead.count({ where: { tenantId } }),
    );

    const msg = buildMessage({ phone, profileName: 'Returning' });
    const result = await inTenant(() => svc.handleInbound(account, msg));
    assert.ok(result);

    const afterCount = await withTenantRaw(tenantId, (tx) =>
      tx.lead.count({ where: { tenantId } }),
    );
    assert.equal(afterCount, beforeCount, 'no new lead — link to existing');

    const conv = await withTenantRaw(tenantId, (tx) =>
      tx.whatsAppConversation.findUnique({ where: { id: result!.conversationId } }),
    );
    assert.equal(conv?.leadId, existingLeadId);
    assert.equal(conv?.assignedToId, bobId);
    assert.equal(conv?.assignmentSource, 'inbound_route');

    const lead = await withTenantRaw(tenantId, (tx) =>
      tx.lead.findUnique({ where: { id: existingLeadId } }),
    );
    assert.equal(lead?.primaryConversationId, result!.conversationId);

    const verbs = await withTenantRaw(tenantId, async (tx) => {
      const rows = await tx.auditEvent.findMany({
        where: { tenantId, entityType: 'whatsapp.conversation' },
        select: { action: true },
      });
      return rows.map((r) => r.action);
    });
    assert.deepEqual(verbs, ['whatsapp.conversation.assigned']);
  });

  // Note: the `duplicate_lead` branch (2+ open leads on the same
  // phone) is defensive code — `Lead @@unique([tenantId, phone])`
  // prevents two open leads sharing a phone today, so the branch
  // cannot be reached without a schema relaxation. Kept in the
  // orchestrator for resilience against future merge/import flows;
  // a runnable test for it lands when (and if) the schema permits.

  it('profile-name latest-wins on Contact; originalDisplayName preserved', async () => {
    const phone = '+201005000006';
    await inTenant(() =>
      svc.handleInbound(account, buildMessage({ phone, profileName: 'First Name' })),
    );
    const first = await withTenantRaw(tenantId, (tx) =>
      tx.contact.findUnique({ where: { tenantId_phone: { tenantId, phone } } }),
    );
    assert.equal(first?.displayName, 'First Name');
    assert.equal(first?.originalDisplayName, 'First Name');

    await inTenant(() =>
      svc.handleInbound(account, buildMessage({ phone, profileName: 'Updated Name' })),
    );
    const second = await withTenantRaw(tenantId, (tx) =>
      tx.contact.findUnique({ where: { tenantId_phone: { tenantId, phone } } }),
    );
    assert.equal(second?.displayName, 'Updated Name', 'latest-wins on display name');
    assert.equal(
      second?.originalDisplayName,
      'First Name',
      'originalDisplayName never overwritten',
    );
  });

  it('idempotent webhook: duplicate providerMessageId returns null, no re-routing', async () => {
    const phone = '+201006000007';
    const sharedId = 'wamid.C10B3-DUP';
    const first = await inTenant(() =>
      svc.handleInbound(account, buildMessage({ phone, providerMessageId: sharedId })),
    );
    assert.ok(first);

    const beforeLeads = await withTenantRaw(tenantId, (tx) =>
      tx.lead.count({ where: { tenantId } }),
    );
    const beforeAudits = await withTenantRaw(tenantId, (tx) =>
      tx.auditEvent.count({ where: { tenantId } }),
    );

    const second = await inTenant(() =>
      svc.handleInbound(account, buildMessage({ phone, providerMessageId: sharedId })),
    );
    assert.equal(second, null, 'duplicate webhook returns null');

    const afterLeads = await withTenantRaw(tenantId, (tx) =>
      tx.lead.count({ where: { tenantId } }),
    );
    const afterAudits = await withTenantRaw(tenantId, (tx) =>
      tx.auditEvent.count({ where: { tenantId } }),
    );
    assert.equal(afterLeads, beforeLeads, 'no extra lead on duplicate webhook');
    assert.equal(afterAudits, beforeAudits, 'no extra audit row on duplicate webhook');
  });

  it('feature flag off → falls back to legacy persistInbound (no contact, no routing)', async () => {
    process.env['WHATSAPP_INBOUND_V2'] = 'false';
    try {
      const phone = '+201007000008';
      const result = await inTenant(() =>
        svc.handleInbound(account, buildMessage({ phone, profileName: 'Flag Off' })),
      );
      assert.ok(result);

      const leadsRows = await withTenantRaw(tenantId, (tx) =>
        tx.lead.count({ where: { tenantId } }),
      );
      assert.equal(leadsRows, 0, 'flag off must not create a lead');

      const contacts = await withTenantRaw(tenantId, (tx) =>
        tx.contact.count({ where: { tenantId } }),
      );
      assert.equal(contacts, 0, 'flag off must not create a contact');

      const conv = await withTenantRaw(tenantId, (tx) =>
        tx.whatsAppConversation.findUnique({ where: { id: result!.conversationId } }),
      );
      assert.equal(conv?.contactId, null);
      assert.equal(conv?.assignedToId, null);
      assert.equal(conv?.assignmentSource, null);
    } finally {
      process.env['WHATSAPP_INBOUND_V2'] = 'true';
    }
  });

  it('routeConversation (direct): rule-less + agents available → returns a chosen user', async () => {
    const decision = await inTenant(() =>
      distribution.routeConversation({
        tenantId,
        source: 'whatsapp',
        companyId: null,
        countryId: null,
      }),
    );
    assert.ok(decision.chosenUserId);
    assert.equal(decision.ruleId, null);
    assert.ok(decision.candidateCount >= 1);
  });

  it('routeConversation (direct): no eligible agents → chosenUserId=null + strategy=no_match', async () => {
    await withTenantRaw(tenantId, (tx) =>
      tx.user.updateMany({
        where: { id: { in: [aliceId, bobId] } },
        data: { status: 'disabled' },
      }),
    );
    try {
      const decision = await inTenant(() =>
        distribution.routeConversation({
          tenantId,
          source: 'whatsapp',
          companyId: null,
          countryId: null,
        }),
      );
      assert.equal(decision.chosenUserId, null);
      assert.equal(decision.chosenTeamId, null);
      assert.equal(decision.strategy, 'no_match');
    } finally {
      await withTenantRaw(tenantId, (tx) =>
        tx.user.updateMany({
          where: { id: { in: [aliceId, bobId] } },
          data: { status: 'active' },
        }),
      );
    }
  });
});
