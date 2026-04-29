import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { normalizeE164 } from '../crm/phone.util';
import { PrismaService } from '../prisma/prisma.service';
import { MetaCloudProvider } from './meta-cloud.provider';
import type { InboundMessage, WhatsAppAccountConfig, WhatsAppProvider } from './whatsapp.provider';

const META_CLOUD = 'meta_cloud' as const;

/**
 * C25 — auto-link policy. Returns the single match, or null when zero
 * or multiple matches are present. Multiple matches force a manual
 * decision (admin must call POST /:id/link-lead) instead of guessing.
 *
 * Exported for unit testing the three branches without a database.
 */
export function pickAutoLinkLead<T>(matches: readonly T[]): T | null {
  return matches.length === 1 ? (matches[0] as T) : null;
}

/** Routing record returned by the cross-tenant phone-number-id lookup. */
export interface RoutedAccount {
  id: string;
  tenantId: string;
  provider: string;
  appSecret: string | null;
  verifyToken: string;
}

/** Raw shape returned by the routing-table lookups. */
interface RoutingRow {
  id: string;
  tenantId: string;
  provider: string;
  appSecret: string | null;
  verifyToken: string;
  isActive: boolean;
}

/**
 * Subset of the `WhatsAppAccount` row safe to return to internal callers.
 * Does NOT include the access token — only the persistence layer reads it.
 */
export interface WhatsAppAccountSummary {
  id: string;
  tenantId: string;
  phoneNumber: string;
  phoneNumberId: string;
  provider: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * WhatsAppService — the only module-internal write path for the
 * `whatsapp_*` tables.
 *
 * Responsibilities:
 *   1. Cross-tenant routing of inbound webhook payloads to the right
 *      WhatsAppAccount via Meta's `phone_number_id`.
 *   2. Idempotent threaded persistence of inbound + outbound messages
 *      (C22): every message is attached to a WhatsAppConversation keyed on
 *      `(tenantId, accountId, phone)`. The conversation summary
 *      (`lastMessageAt`, `lastMessageText`) is kept in sync inside the
 *      same transaction as the message insert.
 *   3. Outbound `sendText` that routes through the appropriate provider
 *      and threads the outgoing message into the conversation.
 *
 * Conversation lifecycle:
 *   - "open" by default. The partial unique index
 *     `(tenantId, accountId, phone) WHERE status='open'` enforces at most
 *     one open thread per phone per account.
 *   - "closed" — soft archive. New inbound from the same phone opens a
 *     fresh thread; closing is admin-driven (no automatic close in C22).
 */
@Injectable()
export class WhatsAppService {
  private readonly logger = new Logger(WhatsAppService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly metaCloud: MetaCloudProvider,
  ) {}

  /**
   * Resolve a provider implementation for the given account row. Today
   * we ship one provider; the switch is here so adding a BSP partner is
   * a strict extension.
   */
  providerFor(provider: string): WhatsAppProvider {
    switch (provider) {
      case META_CLOUD:
        return this.metaCloud;
      default:
        throw new Error(`unsupported_provider:${provider}`);
    }
  }

  // ─────── Cross-tenant routing (webhook GET + POST) ───────

  /**
   * Look up an account by Meta's `phone_number_id`. The webhook is
   * public so no tenant context is set yet — we read from the
   * `whatsapp_routes` table which is intentionally NOT RLS'd and holds
   * only routing fields (no access token). The token stays inside the
   * RLS'd `whatsapp_accounts` table; we re-read it via withTenant when
   * sending an outbound message.
   */
  async findRoutingByPhoneNumberId(phoneNumberId: string): Promise<RoutedAccount | null> {
    const rows = await this.prisma.$queryRaw<RoutingRow[]>`
      SELECT account_id  AS "id",
             tenant_id   AS "tenantId",
             provider,
             app_secret  AS "appSecret",
             verify_token AS "verifyToken",
             is_active   AS "isActive"
      FROM whatsapp_routes
      WHERE phone_number_id = ${phoneNumberId}
      LIMIT 1
    `;
    const row = rows[0];
    if (!row || !row.isActive) return null;
    return {
      id: row.id,
      tenantId: row.tenantId,
      provider: row.provider,
      appSecret: row.appSecret,
      verifyToken: row.verifyToken,
    };
  }

  /** Look up an account by its `verifyToken` (webhook GET handshake). */
  async findRoutingByVerifyToken(verifyToken: string): Promise<RoutedAccount | null> {
    const rows = await this.prisma.$queryRaw<RoutingRow[]>`
      SELECT account_id  AS "id",
             tenant_id   AS "tenantId",
             provider,
             app_secret  AS "appSecret",
             verify_token AS "verifyToken",
             is_active   AS "isActive"
      FROM whatsapp_routes
      WHERE verify_token = ${verifyToken}
        AND is_active = TRUE
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      tenantId: row.tenantId,
      provider: row.provider,
      appSecret: row.appSecret,
      verifyToken: row.verifyToken,
    };
  }

  // ─────── Conversation threading helper (C22) ───────

  /**
   * Find or create the open conversation for `(tenantId, accountId, phone)`.
   * Runs inside the caller's transaction so the message + summary update
   * stay atomic. Returns the conversation id.
   *
   * Handles the partial-unique race: if two concurrent inbound webhooks
   * arrive for the same (account, phone) pair, exactly one will create
   * the conversation row; the other catches the P2002 and re-reads.
   */
  private async ensureOpenConversation(
    tx: Prisma.TransactionClient,
    tenantId: string,
    accountId: string,
    phone: string,
  ): Promise<string> {
    const existing = await tx.whatsAppConversation.findFirst({
      where: { tenantId, accountId, phone, status: 'open' },
      select: { id: true },
    });
    if (existing) return existing.id;

    try {
      const created = await tx.whatsAppConversation.create({
        data: { tenantId, accountId, phone, status: 'open' },
        select: { id: true },
      });
      return created.id;
    } catch (err) {
      // Race: another transaction created the open conversation between
      // our SELECT and INSERT. Fall back to a re-read.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const reread = await tx.whatsAppConversation.findFirst({
          where: { tenantId, accountId, phone, status: 'open' },
          select: { id: true },
        });
        if (reread) return reread.id;
      }
      throw err;
    }
  }

  // ─────── Inbound persistence ───────

  /**
   * Persist a parsed inbound message under the account's tenant scope.
   * Returns the new message id + conversation id, or `null` when the
   * message has already been ingested (idempotent on
   * `(tenantId, providerMessageId)`).
   *
   * In a single transaction we:
   *   1. Find or create the open conversation for (account, phone).
   *   2. Insert the message linked to that conversation.
   *   3. Bump `lastMessageAt` + `lastMessageText` on the conversation.
   */
  async persistInbound(
    account: RoutedAccount,
    msg: InboundMessage,
  ): Promise<{ messageId: string; conversationId: string } | null> {
    try {
      return await this.prisma.withTenant(account.tenantId, async (tx) => {
        const conversationId = await this.ensureOpenConversation(
          tx,
          account.tenantId,
          account.id,
          msg.phone,
        );

        const message = await tx.whatsAppMessage.create({
          data: {
            tenantId: account.tenantId,
            accountId: account.id,
            conversationId,
            phone: msg.phone,
            text: msg.text,
            direction: 'inbound',
            providerMessageId: msg.providerMessageId,
            status: 'received',
            createdAt: msg.receivedAt,
          },
          select: { id: true },
        });

        await tx.whatsAppConversation.update({
          where: { id: conversationId },
          data: { lastMessageAt: msg.receivedAt, lastMessageText: msg.text },
        });

        return { messageId: message.id, conversationId };
      });
    } catch (err) {
      // Duplicate provider id within the same tenant → idempotent no-op.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        this.logger.debug(
          `persistInbound: duplicate ${msg.providerMessageId} for tenant ${account.tenantId}`,
        );
        return null;
      }
      throw err;
    }
  }

  // ─────── Outbound send ───────

  /**
   * Send a plain-text message via the provider configured on the
   * account, thread it into the open conversation for (account, to),
   * and bump the conversation summary. Tenant scope is required — the
   * caller must run under the active tenant context.
   */
  async sendText(input: {
    tenantId: string;
    accountId: string;
    to: string;
    text: string;
  }): Promise<{ messageId: string; providerMessageId: string; conversationId: string }> {
    const { tenantId, accountId, to, text } = input;

    // Read the full account row including the access token. The token
    // never leaves this method — we hand it to the provider and discard.
    const account = await this.prisma.withTenant(tenantId, (tx) =>
      tx.whatsAppAccount.findUnique({
        where: { id: accountId },
        select: {
          id: true,
          provider: true,
          phoneNumberId: true,
          accessToken: true,
          appSecret: true,
          verifyToken: true,
          isActive: true,
        },
      }),
    );
    if (!account || !account.isActive) {
      throw new NotFoundException({
        code: 'whatsapp.account_not_found',
        message: `WhatsApp account ${accountId} not found in active tenant`,
      });
    }

    const provider = this.providerFor(account.provider);
    const config: WhatsAppAccountConfig = {
      accessToken: account.accessToken,
      phoneNumberId: account.phoneNumberId,
      appSecret: account.appSecret,
      verifyToken: account.verifyToken,
    };

    const { providerMessageId } = await provider.sendText({ config, to, text });

    return this.prisma.withTenant(tenantId, async (tx) => {
      const conversationId = await this.ensureOpenConversation(tx, tenantId, accountId, to);
      const sentAt = new Date();

      const message = await tx.whatsAppMessage.create({
        data: {
          tenantId,
          accountId,
          conversationId,
          phone: to,
          text,
          direction: 'outbound',
          providerMessageId,
          status: 'sent',
        },
        select: { id: true },
      });

      await tx.whatsAppConversation.update({
        where: { id: conversationId },
        data: { lastMessageAt: sentAt, lastMessageText: text },
      });

      return { messageId: message.id, providerMessageId, conversationId };
    });
  }

  // ─────── Read helpers (used by the C22 admin endpoints + tests) ───────

  /** Tenant-scoped account read used by tests / future admin screens. */
  findAccountById(tenantId: string, accountId: string): Promise<WhatsAppAccountSummary | null> {
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.whatsAppAccount.findUnique({
        where: { id: accountId },
        select: {
          id: true,
          tenantId: true,
          phoneNumber: true,
          phoneNumberId: true,
          provider: true,
          isActive: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
    );
  }

  /**
   * Tenant-scoped paginated conversations list — newest activity first.
   * Filters by accountId / status / free-text phone match.
   */
  listConversations(
    tenantId: string,
    opts: {
      accountId?: string;
      status?: 'open' | 'closed';
      phone?: string;
      limit?: number;
      offset?: number;
    } = {},
  ) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const where: Prisma.WhatsAppConversationWhereInput = {
        ...(opts.accountId && { accountId: opts.accountId }),
        ...(opts.status && { status: opts.status }),
        ...(opts.phone && { phone: { contains: opts.phone } }),
      };
      const [items, total] = await Promise.all([
        tx.whatsAppConversation.findMany({
          where,
          orderBy: { lastMessageAt: 'desc' },
          take: opts.limit ?? 50,
          skip: opts.offset ?? 0,
        }),
        tx.whatsAppConversation.count({ where }),
      ]);
      return { items, total, limit: opts.limit ?? 50, offset: opts.offset ?? 0 };
    });
  }

  /**
   * Tenant-scoped single-conversation read. Returns null on cross-tenant
   * ids. C25 — additionally:
   *   - includes the linked Lead inline when one is set;
   *   - if no link exists, runs the lazy auto-link pass: a single
   *     tenant-scoped lead with the same phone gets attached, multiple-
   *     or zero-match cases leave `leadId = null`.
   */
  async findConversationById(tenantId: string, id: string) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const row = await tx.whatsAppConversation.findUnique({
        where: { id },
        include: { lead: true },
      });
      if (!row) return null;
      if (row.leadId !== null) return row;
      return await this.maybeAutoLinkLead(tx, row);
    });
  }

  /**
   * Messages for a conversation — oldest first so the inbox can render
   * chronologically without an extra reverse step. Returns null when the
   * conversation isn't visible to the active tenant.
   *
   * C25 — also runs the lazy auto-link pass before returning, so an
   * agent who opens an unlinked conversation has its lead attached
   * without needing a second round-trip.
   */
  async listConversationMessages(
    tenantId: string,
    conversationId: string,
    opts: { limit?: number } = {},
  ) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const conversation = await tx.whatsAppConversation.findUnique({
        where: { id: conversationId },
        select: { id: true, phone: true, leadId: true },
      });
      if (!conversation) return null;
      if (conversation.leadId === null) {
        await this.maybeAutoLinkLead(tx, conversation);
      }
      return tx.whatsAppMessage.findMany({
        where: { conversationId },
        orderBy: { createdAt: 'asc' },
        take: opts.limit ?? 200,
      });
    });
  }

  /**
   * Attach a conversation to a lead in the same tenant. Idempotent:
   * relinking to a different lead is allowed (latest wins). Both ids
   * must resolve in the active tenant — RLS hides cross-tenant rows so
   * either lookup returning null surfaces as 404.
   */
  async linkConversationToLead(
    tenantId: string,
    conversationId: string,
    leadId: string,
  ): Promise<{
    id: string;
    leadId: string | null;
  }> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const conversation = await tx.whatsAppConversation.findUnique({
        where: { id: conversationId },
        select: { id: true },
      });
      if (!conversation) {
        throw new NotFoundException({
          code: 'whatsapp.conversation_not_found',
          message: `Conversation ${conversationId} not found in active tenant`,
        });
      }
      const lead = await tx.lead.findUnique({
        where: { id: leadId },
        select: { id: true },
      });
      if (!lead) {
        throw new NotFoundException({
          code: 'whatsapp.lead_not_found',
          message: `Lead ${leadId} not found in active tenant`,
        });
      }
      const updated = await tx.whatsAppConversation.update({
        where: { id: conversationId },
        data: { leadId },
        select: { id: true, leadId: true },
      });
      return updated;
    });
  }

  /**
   * Lazy auto-link helper. Looks up tenant-scoped leads with the
   * conversation's phone — the (tenantId, phone) unique on `leads`
   * guarantees at most one match in practice, but we still run the
   * `pickAutoLinkLead` policy (length === 1) so future schema changes
   * that loosen the constraint don't silently link the wrong row.
   *
   * The phone is funnelled through `normalizeE164` before lookup so
   * historical conversation rows persisted before C26 (when the
   * inbound parser used a thinner `+`-prepend helper) still match
   * leads stored in canonical E.164. New rows are already normalized
   * at parse time — the call here is the safety net.
   *
   * Returns the conversation row reloaded with the (possibly newly
   * attached) lead included, mirroring `findConversationById`'s shape.
   */
  private async maybeAutoLinkLead(
    tx: Prisma.TransactionClient,
    conversation: { id: string; phone: string },
  ) {
    let lookupPhone: string;
    try {
      lookupPhone = normalizeE164(conversation.phone);
    } catch {
      // Conversation has a phone we can't coerce to E.164 — skip
      // auto-link silently rather than block the read.
      return tx.whatsAppConversation.findUnique({
        where: { id: conversation.id },
        include: { lead: true },
      });
    }
    const matches = await tx.lead.findMany({
      where: { phone: lookupPhone },
      select: { id: true },
      take: 2,
    });
    const pick = pickAutoLinkLead(matches);
    if (pick) {
      await tx.whatsAppConversation.update({
        where: { id: conversation.id },
        data: { leadId: pick.id },
      });
    }
    return tx.whatsAppConversation.findUnique({
      where: { id: conversation.id },
      include: { lead: true },
    });
  }

  /** Tenant-scoped messages list — newest first. Used by tests + future admin. */
  listMessages(
    tenantId: string,
    opts: { phone?: string; direction?: 'inbound' | 'outbound'; limit?: number } = {},
  ) {
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.whatsAppMessage.findMany({
        where: {
          ...(opts.phone && { phone: opts.phone }),
          ...(opts.direction && { direction: opts.direction }),
        },
        orderBy: { createdAt: 'desc' },
        take: opts.limit ?? 100,
      }),
    );
  }
}
