import { Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { LeadsService } from '../crm/leads.service';
import { normalizeE164WithDefault } from '../crm/phone.util';
import { DistributionService } from '../distribution/distribution.service';
import type { ConversationRoutingDecision } from '../distribution/distribution.types';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { TenantSettingsService } from '../tenants/tenant-settings.service';

import type { InboundMessage } from './whatsapp.provider';
import { WhatsAppService, type RoutedAccount } from './whatsapp.service';

/**
 * Phase C — C10B-3: orchestrator for the inbound WhatsApp webhook.
 *
 * The webhook controller hands every parsed message to this service.
 * It runs a single transaction with `prisma.withTenant(...)` and
 * composes:
 *
 *   1. `WhatsAppService.persistInboundInTx` — store the conversation +
 *      message rows. Returns `null` on duplicate provider id ⇒ short
 *      circuit (idempotent webhook retries never re-route).
 *   2. Phone normalisation + tenant default-dial-code resolution.
 *   3. Contact match-or-create by `(tenantId, phone)`. Profile name
 *      updates the mutable `displayName`; first-seen snapshots
 *      `originalDisplayName` for audit.
 *   4. Captain check — `Contact.isCaptain` plus a real Captain row
 *      lookup. An active captain phone NEVER auto-creates a sales
 *      lead and routes straight to the review queue.
 *   5. Open-lead lookup by phone:
 *        • 0 matches  → call `routeConversation`, then
 *                       `LeadsService.createFromWhatsApp` with the
 *                       chosen assignee. Race on duplicate phone is
 *                       caught and falls through to the 1-match path.
 *        • 1 match    → link the conversation to that lead and
 *                       denormalise ownership from the lead.
 *        • 2+ matches → review queue with reason='duplicate_lead'.
 *   6. Owner denormalisation onto the conversation row +
 *      `assignmentSource = 'inbound_route'` (per locked decision).
 *   7. Audit + notification emission inside the same tx.
 *   8. Post-commit realtime emit (legacy tenant-wide channel).
 *
 * Feature flag: `WHATSAPP_INBOUND_V2`. When `false`, the orchestrator
 * falls back to the legacy `persistInbound` path (no contact / no
 * routing / no review queue) — first-deploy safety valve. Defaults to
 * `true` (tests + dev); production opt-in via env until proven stable.
 */
@Injectable()
export class WhatsAppInboundService {
  private readonly logger = new Logger(WhatsAppInboundService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly whatsapp: WhatsAppService,
    private readonly leads: LeadsService,
    private readonly distribution: DistributionService,
    private readonly tenantSettings: TenantSettingsService,
    private readonly audit: AuditService,
    @Optional() private readonly notifications?: NotificationsService,
  ) {}

  /**
   * Public entry. Returns the same shape as the legacy
   * `persistInbound` so the controller can keep the same
   * `ingested / duplicates` counter math without branching on the
   * feature flag.
   */
  async handleInbound(
    account: RoutedAccount,
    msg: InboundMessage,
  ): Promise<{ messageId: string; conversationId: string } | null> {
    if (!isV2Enabled()) {
      // Feature-flag off: behave exactly like the pre-C10B-3 path.
      return this.whatsapp.persistInbound(account, msg);
    }

    let outcome: {
      messageId: string;
      conversationId: string;
      assignedToId: string | null;
      reviewReason: ReviewReason | null;
    } | null = null;

    try {
      outcome = await this.prisma.withTenant(account.tenantId, async (tx) => {
        const persisted = await this.whatsapp.persistInboundInTx(tx, account, msg);
        if (persisted === null) {
          // Idempotent duplicate: nothing else to do — caller short-
          // circuits its counters.
          return null;
        }
        return this.orchestrateAfterPersist(tx, account, msg, persisted);
      });
    } catch (err) {
      // Unexpected errors propagate — webhook controller logs +
      // returns 500. Idempotent outer-tx retry is the operator's
      // remediation (Meta will retry the same message).
      this.logger.error(`handleInbound failed: ${(err as Error).message}`);
      throw err;
    }

    if (outcome) {
      this.whatsapp.emitInboundRealtime(account.tenantId, {
        messageId: outcome.messageId,
        conversationId: outcome.conversationId,
      });
      return { messageId: outcome.messageId, conversationId: outcome.conversationId };
    }
    return null;
  }

  // ───────────────────────────────────────────────────────────────────
  // private — orchestration after the message + conversation are stored
  // ───────────────────────────────────────────────────────────────────

  private async orchestrateAfterPersist(
    tx: Prisma.TransactionClient,
    account: RoutedAccount,
    msg: InboundMessage,
    persisted: { messageId: string; conversationId: string },
  ): Promise<{
    messageId: string;
    conversationId: string;
    assignedToId: string | null;
    reviewReason: ReviewReason | null;
  }> {
    // 1. Resolve normalised phone using the tenant's default dial code
    //    (covers local-format inputs from the rare BSP that doesn't
    //    pre-normalise). The provider parse already canonicalises
    //    digits-only input, so this is mostly idempotent.
    const settings = await this.tenantSettings.getInTx(tx, account.tenantId);
    let phone = msg.phone;
    try {
      phone = normalizeE164WithDefault(msg.phone, settings.defaultDialCode);
    } catch (err) {
      // Provider already filtered most malformed inputs; the rare
      // post-parse failure is treated as a soft no-op so the webhook
      // never 5xxs out. Conversation row already exists at the
      // pre-normalised phone — don't re-write it.
      this.logger.warn(
        `orchestrateAfterPersist: phone normalise skipped: ${(err as Error).message}`,
      );
    }

    // 2. Contact match-or-create.
    const contact = await this.matchOrCreateContact(tx, account.tenantId, phone, msg);

    // 3. Captain lookup. A contact whose phone matches an ACTIVE
    //    captain row never enters the normal sales funnel.
    const captainOnPhone = await tx.captain.findFirst({
      where: { phone, status: 'active' },
      select: { id: true },
    });
    if (captainOnPhone) {
      // Keep the denormalised flag accurate even if the backfill
      // hasn't run for this contact yet.
      if (!contact.isCaptain) {
        await tx.contact.update({
          where: { id: contact.id },
          data: { isCaptain: true },
        });
      }
      await this.linkConversationToContact(tx, persisted.conversationId, contact.id);
      await this.queueReview(tx, account.tenantId, {
        conversationId: persisted.conversationId,
        contactId: contact.id,
        reason: 'captain_active',
        candidateLeadIds: [],
        candidateCaptainId: captainOnPhone.id,
        msg,
      });
      return {
        messageId: persisted.messageId,
        conversationId: persisted.conversationId,
        assignedToId: null,
        reviewReason: 'captain_active',
      };
    }

    // 4. Open-lead lookup (lifecycleState === 'open').
    const openLeads = await tx.lead.findMany({
      where: { phone, lifecycleState: 'open' },
      select: {
        id: true,
        assignedToId: true,
        companyId: true,
        countryId: true,
        assignedTo: { select: { teamId: true } },
      },
    });

    if (openLeads.length >= 2) {
      await this.linkConversationToContact(tx, persisted.conversationId, contact.id);
      await this.queueReview(tx, account.tenantId, {
        conversationId: persisted.conversationId,
        contactId: contact.id,
        reason: 'duplicate_lead',
        candidateLeadIds: openLeads.map((l) => l.id),
        candidateCaptainId: null,
        msg,
      });
      return {
        messageId: persisted.messageId,
        conversationId: persisted.conversationId,
        assignedToId: null,
        reviewReason: 'duplicate_lead',
      };
    }

    if (openLeads.length === 1) {
      const match = openLeads[0]!;
      await this.linkConversationToLeadAndContact(
        tx,
        persisted.conversationId,
        match.id,
        contact.id,
        {
          assignedToId: match.assignedToId,
          teamId: match.assignedTo?.teamId ?? null,
          companyId: match.companyId,
          countryId: match.countryId,
        },
      );
      // Update the lead's primary conversation pointer so
      // "open WhatsApp from lead" lands on the latest thread.
      await tx.lead.update({
        where: { id: match.id },
        data: { primaryConversationId: persisted.conversationId },
      });
      await this.audit.writeInTx(tx, account.tenantId, {
        action: 'whatsapp.conversation.assigned',
        entityType: 'whatsapp.conversation',
        entityId: persisted.conversationId,
        actorUserId: null,
        payload: {
          branch: 'linked_existing_lead',
          leadId: match.id,
          contactId: contact.id,
          assignedToId: match.assignedToId,
          teamId: match.assignedTo?.teamId ?? null,
        } as unknown as Prisma.InputJsonValue,
      });
      await this.notifyAssignee(tx, account.tenantId, match.assignedToId, {
        conversationId: persisted.conversationId,
        leadId: match.id,
      });
      return {
        messageId: persisted.messageId,
        conversationId: persisted.conversationId,
        assignedToId: match.assignedToId,
        reviewReason: null,
      };
    }

    // 5. 0 matches → route + create lead. The routing inputs
    //    (companyId / countryId) are NULL today; rules with
    //    explicit company/country selectors are skipped, wildcard
    //    rules + tenant default strategy take over. Future work can
    //    pre-resolve these from the WhatsApp account's metadata.
    const decision = await this.distribution.routeConversation(
      {
        tenantId: account.tenantId,
        source: 'whatsapp',
        companyId: null,
        countryId: null,
      },
      tx,
    );

    if (decision.chosenUserId === null) {
      // Truly unmatched — review queue, no lead creation.
      await this.linkConversationToContact(tx, persisted.conversationId, contact.id);
      await this.queueReview(tx, account.tenantId, {
        conversationId: persisted.conversationId,
        contactId: contact.id,
        reason: 'unmatched_after_routing',
        candidateLeadIds: [],
        candidateCaptainId: null,
        msg,
        decision,
      });
      return {
        messageId: persisted.messageId,
        conversationId: persisted.conversationId,
        assignedToId: null,
        reviewReason: 'unmatched_after_routing',
      };
    }

    // 6. Auto-create the lead with the pre-resolved assignee.
    //    Race-handling: a concurrent webhook may have already created
    //    a lead for this phone since our `findMany` above returned 0;
    //    P2002 surfaces as `lead.duplicate_phone` and we fall through
    //    to the 1-match branch (re-fetch + link).
    let createdLead: { id: string };
    try {
      createdLead = await this.leads.createFromWhatsApp(tx, {
        tenantId: account.tenantId,
        contactId: contact.id,
        phone,
        name: contact.displayName ?? phone,
        profileName: msg.profileName ?? null,
        waId: msg.waId ?? null,
        companyId: null,
        countryId: null,
        assignedToId: decision.chosenUserId,
        primaryConversationId: persisted.conversationId,
      });
    } catch (err) {
      const isDuplicate =
        err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
      const errCode =
        err !== null &&
        typeof err === 'object' &&
        'getResponse' in err &&
        typeof (err as { getResponse: unknown }).getResponse === 'function'
          ? (((err as { getResponse: () => unknown }).getResponse() as Record<string, unknown>)
              ?.code as string | undefined)
          : undefined;
      const isShapedDuplicate = errCode === 'lead.duplicate_phone';
      // Phase D2 — D2.3: createFromWhatsApp now also throws
      // `lead.requires_review` when the duplicate-decision engine
      // (LEAD_ATTEMPTS_V2=true) decides the inbound matches a
      // captain / won / cooldown case. We surface it as a review
      // row with reason='duplicate_lead' (the closest existing
      // enum value; D2.4 may extend the WhatsApp review reason set
      // to surface cooldown / won distinctly).
      const isRequiresReview = errCode === 'lead.requires_review';
      if (isRequiresReview) {
        await this.linkConversationToContact(tx, persisted.conversationId, contact.id);
        await this.queueReview(tx, account.tenantId, {
          conversationId: persisted.conversationId,
          contactId: contact.id,
          reason: 'duplicate_lead',
          candidateLeadIds: [],
          candidateCaptainId: null,
          msg,
        });
        return {
          messageId: persisted.messageId,
          conversationId: persisted.conversationId,
          assignedToId: null,
          reviewReason: 'duplicate_lead',
        };
      }
      if (!isDuplicate && !isShapedDuplicate) throw err;
      // Race: another inbound created the lead first. Re-fetch and
      // treat as "1 match found" branch.
      const reread = await tx.lead.findFirst({
        where: { phone, lifecycleState: 'open' },
        select: {
          id: true,
          assignedToId: true,
          companyId: true,
          countryId: true,
          assignedTo: { select: { teamId: true } },
        },
      });
      if (!reread) {
        // Defensive: the duplicate landed between our findMany and
        // create but disappeared by re-read. Bail to review queue
        // rather than swallow.
        await this.linkConversationToContact(tx, persisted.conversationId, contact.id);
        await this.queueReview(tx, account.tenantId, {
          conversationId: persisted.conversationId,
          contactId: contact.id,
          reason: 'unmatched_after_routing',
          candidateLeadIds: [],
          candidateCaptainId: null,
          msg,
          decision,
        });
        return {
          messageId: persisted.messageId,
          conversationId: persisted.conversationId,
          assignedToId: null,
          reviewReason: 'unmatched_after_routing',
        };
      }
      await this.linkConversationToLeadAndContact(
        tx,
        persisted.conversationId,
        reread.id,
        contact.id,
        {
          assignedToId: reread.assignedToId,
          teamId: reread.assignedTo?.teamId ?? null,
          companyId: reread.companyId,
          countryId: reread.countryId,
        },
      );
      await tx.lead.update({
        where: { id: reread.id },
        data: { primaryConversationId: persisted.conversationId },
      });
      await this.audit.writeInTx(tx, account.tenantId, {
        action: 'whatsapp.conversation.assigned',
        entityType: 'whatsapp.conversation',
        entityId: persisted.conversationId,
        actorUserId: null,
        payload: {
          branch: 'race_resolved_to_existing_lead',
          leadId: reread.id,
          contactId: contact.id,
          assignedToId: reread.assignedToId,
        } as unknown as Prisma.InputJsonValue,
      });
      await this.notifyAssignee(tx, account.tenantId, reread.assignedToId, {
        conversationId: persisted.conversationId,
        leadId: reread.id,
      });
      return {
        messageId: persisted.messageId,
        conversationId: persisted.conversationId,
        assignedToId: reread.assignedToId,
        reviewReason: null,
      };
    }

    // Denormalise ownership onto the conversation row using the
    // routing decision we already have in hand.
    await this.linkConversationToLeadAndContact(
      tx,
      persisted.conversationId,
      createdLead.id,
      contact.id,
      {
        assignedToId: decision.chosenUserId,
        teamId: decision.chosenTeamId,
        companyId: null,
        countryId: null,
      },
    );

    await this.audit.writeInTx(tx, account.tenantId, {
      action: 'lead.created_from_whatsapp',
      entityType: 'lead',
      entityId: createdLead.id,
      actorUserId: null,
      payload: {
        leadId: createdLead.id,
        contactId: contact.id,
        conversationId: persisted.conversationId,
        assignedToId: decision.chosenUserId,
        teamId: decision.chosenTeamId,
        routing: routingPayload(decision),
      } as unknown as Prisma.InputJsonValue,
    });
    await this.audit.writeInTx(tx, account.tenantId, {
      action: 'whatsapp.conversation.assigned',
      entityType: 'whatsapp.conversation',
      entityId: persisted.conversationId,
      actorUserId: null,
      payload: {
        branch: 'auto_created_lead',
        leadId: createdLead.id,
        contactId: contact.id,
        assignedToId: decision.chosenUserId,
        teamId: decision.chosenTeamId,
        routing: routingPayload(decision),
      } as unknown as Prisma.InputJsonValue,
    });
    await this.notifyAssignee(tx, account.tenantId, decision.chosenUserId, {
      conversationId: persisted.conversationId,
      leadId: createdLead.id,
    });

    return {
      messageId: persisted.messageId,
      conversationId: persisted.conversationId,
      assignedToId: decision.chosenUserId,
      reviewReason: null,
    };
  }

  // ───────────────────────────────────────────────────────────────────
  // private helpers
  // ───────────────────────────────────────────────────────────────────

  private async matchOrCreateContact(
    tx: Prisma.TransactionClient,
    tenantId: string,
    phone: string,
    msg: InboundMessage,
  ): Promise<{ id: string; displayName: string | null; isCaptain: boolean }> {
    const profileName = msg.profileName ?? null;
    const existing = await tx.contact.findUnique({
      where: { tenantId_phone: { tenantId, phone } },
      select: { id: true, displayName: true, isCaptain: true },
    });
    if (existing) {
      // Latest-wins on display name: if the inbound carries a name,
      // overwrite. Never touch `originalDisplayName`.
      const data: Prisma.ContactUncheckedUpdateInput = {
        lastSeenAt: msg.receivedAt,
      };
      if (profileName !== null && profileName.length > 0) {
        data.displayName = profileName;
      }
      // Persist the raw provider profile snapshot for audit.
      data.rawProfile = {
        profileName: profileName,
        waId: msg.waId ?? null,
      } as unknown as Prisma.InputJsonValue;
      const updated = await tx.contact.update({
        where: { id: existing.id },
        data,
        select: { id: true, displayName: true, isCaptain: true },
      });
      return updated;
    }
    const created = await tx.contact.create({
      data: {
        tenantId,
        phone,
        originalPhone: phone,
        displayName: profileName,
        originalDisplayName: profileName,
        rawProfile: {
          profileName,
          waId: msg.waId ?? null,
        } as unknown as Prisma.InputJsonValue,
        firstSeenAt: msg.receivedAt,
        lastSeenAt: msg.receivedAt,
      },
      select: { id: true, displayName: true, isCaptain: true },
    });
    return created;
  }

  private async linkConversationToContact(
    tx: Prisma.TransactionClient,
    conversationId: string,
    contactId: string,
  ): Promise<void> {
    await tx.whatsAppConversation.update({
      where: { id: conversationId },
      data: { contactId },
    });
  }

  private async linkConversationToLeadAndContact(
    tx: Prisma.TransactionClient,
    conversationId: string,
    leadId: string,
    contactId: string,
    ownership: {
      assignedToId: string | null;
      teamId: string | null;
      companyId: string | null;
      countryId: string | null;
    },
  ): Promise<void> {
    // Re-read the conversation so we don't overwrite a real
    // (non-`migrated`) ownership that landed since persistInboundInTx
    // ran. `assignmentSource = null` ⇒ this is the first owner;
    // anything else ⇒ leave ownership untouched, just link to lead +
    // contact and let the existing owner stand.
    const current = await tx.whatsAppConversation.findUnique({
      where: { id: conversationId },
      select: { assignmentSource: true },
    });
    const data: Prisma.WhatsAppConversationUncheckedUpdateInput = {
      contactId,
      leadId,
    };
    if (current?.assignmentSource === null && ownership.assignedToId !== null) {
      data.assignedToId = ownership.assignedToId;
      data.teamId = ownership.teamId;
      data.companyId = ownership.companyId;
      data.countryId = ownership.countryId;
      data.assignmentSource = 'inbound_route';
      data.assignedAt = new Date();
    }
    await tx.whatsAppConversation.update({ where: { id: conversationId }, data });
  }

  private async queueReview(
    tx: Prisma.TransactionClient,
    tenantId: string,
    input: {
      conversationId: string;
      contactId: string;
      reason: ReviewReason;
      candidateLeadIds: string[];
      candidateCaptainId: string | null;
      msg: InboundMessage;
      decision?: ConversationRoutingDecision;
    },
  ): Promise<void> {
    // Snapshot the last 2 inbound messages (including the one we
    // just persisted) so a reviewer sees what the contact said
    // without paging through the conversation later.
    const recent = await tx.whatsAppMessage.findMany({
      where: { conversationId: input.conversationId, direction: 'inbound' },
      orderBy: { createdAt: 'desc' },
      take: 2,
      select: { text: true, createdAt: true },
    });
    const contextSnapshot = recent.map((r) => ({
      text: r.text,
      createdAt: r.createdAt.toISOString(),
    }));

    // Idempotence: a second inbound on a conversation already in the
    // queue MUST NOT duplicate the row. UPSERT keyed on the
    // conversationId UNIQUE constraint would be cleanest, but Prisma
    // upsert needs the unique selector — which we have.
    await tx.whatsAppConversationReview.upsert({
      where: { conversationId: input.conversationId },
      create: {
        tenantId,
        conversationId: input.conversationId,
        contactId: input.contactId,
        reason: input.reason,
        candidateLeadIds: input.candidateLeadIds,
        candidateCaptainId: input.candidateCaptainId,
        contextSnapshot: contextSnapshot as unknown as Prisma.InputJsonValue,
      },
      update: {
        // Refresh the snapshot + candidate hints; never re-resolve a
        // resolved row (we keep `resolvedAt` / `resolvedById` as-is).
        candidateLeadIds: input.candidateLeadIds,
        candidateCaptainId: input.candidateCaptainId,
        contextSnapshot: contextSnapshot as unknown as Prisma.InputJsonValue,
      },
    });

    await this.audit.writeInTx(tx, tenantId, {
      action: 'whatsapp.conversation.review_queued',
      entityType: 'whatsapp.conversation',
      entityId: input.conversationId,
      actorUserId: null,
      payload: {
        reason: input.reason,
        contactId: input.contactId,
        candidateLeadIds: input.candidateLeadIds,
        candidateCaptainId: input.candidateCaptainId,
        ...(input.decision && { routing: routingPayload(input.decision) }),
      } as unknown as Prisma.InputJsonValue,
    });
  }

  private async notifyAssignee(
    tx: Prisma.TransactionClient,
    tenantId: string,
    assigneeUserId: string | null,
    payload: { conversationId: string; leadId: string },
  ): Promise<void> {
    if (!assigneeUserId || !this.notifications) return;
    await this.notifications.createInTx(tx, tenantId, {
      recipientUserId: assigneeUserId,
      kind: 'whatsapp.conversation.assigned',
      title: 'New WhatsApp conversation assigned',
      body: 'A new inbound conversation has been routed to you.',
      payload: {
        conversationId: payload.conversationId,
        leadId: payload.leadId,
      },
    });
  }
}

type ReviewReason = 'captain_active' | 'duplicate_lead' | 'unmatched_after_routing';

function routingPayload(decision: ConversationRoutingDecision): Record<string, unknown> {
  return {
    ruleId: decision.ruleId,
    strategy: decision.strategy,
    chosenUserId: decision.chosenUserId,
    chosenTeamId: decision.chosenTeamId,
    candidateCount: decision.candidateCount,
    excludedReasons: decision.excludedReasons,
  };
}

/**
 * Locked decision §1: feature flag `WHATSAPP_INBOUND_V2`.
 *   - Defaults to `true` in tests / dev.
 *   - Production must opt-in (set `WHATSAPP_INBOUND_V2=true` in env).
 *   - When the flag resolves to `false`, the orchestrator falls back
 *     to the legacy `persistInbound` path verbatim — no contact, no
 *     routing, no review queue. Used as the first-deploy safety
 *     valve.
 *
 * Resolution order:
 *   1. Explicit env value `'true' | 'false' | '1' | '0'` wins.
 *   2. Otherwise, default depends on `NODE_ENV`: `'production'` ⇒
 *      `false` (opt-in), everything else ⇒ `true`.
 */
export function isV2Enabled(): boolean {
  const raw = process.env['WHATSAPP_INBOUND_V2'];
  if (raw !== undefined) {
    const v = raw.trim().toLowerCase();
    if (v === 'true' || v === '1') return true;
    if (v === 'false' || v === '0') return false;
  }
  return process.env['NODE_ENV'] !== 'production';
}
