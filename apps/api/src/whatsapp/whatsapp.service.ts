import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { decryptSecret } from '../common/crypto';
import { normalizeE164 } from '../crm/phone.util';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { ScopeContextService, type ScopeUserClaims } from '../rbac/scope-context.service';
import { WhatsAppVisibilityService } from '../rbac/whatsapp-visibility.service';
import { RealtimeService } from '../realtime/realtime.service';
import { MetaCloudProvider } from './meta-cloud.provider';
import type { InboundMessage, WhatsAppAccountConfig, WhatsAppProvider } from './whatsapp.provider';

const META_CLOUD = 'meta_cloud' as const;
const WHATSAPP_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * P2-12 — substitute positional placeholders `{{1}}`, `{{2}}`, ...
 * in a template body with the supplied variables. Used to compute
 * the inbox-preview text for a sent template message.
 */
function renderTemplateBody(body: string, variables: readonly string[]): string {
  return body.replace(/\{\{\s*(\d+)\s*\}\}/gu, (_match, n: string) => {
    const idx = Number.parseInt(n, 10) - 1;
    return idx >= 0 && idx < variables.length ? (variables[idx] ?? '') : '';
  });
}

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
    @Optional() private readonly notifications?: NotificationsService,
    @Optional() private readonly realtime?: RealtimeService,
    /**
     * Phase C — C10B-4: scope resolver. Optional so legacy fixtures
     * + the inbound webhook path (system context, no claims) keep
     * working without RoleScope wiring.
     */
    @Optional() private readonly scopeContext?: ScopeContextService,
    /**
     * Phase D5 — D5.12-A: WhatsApp visibility resolver. Applies
     * field-permission + transfer-mode redaction to read paths
     * (`listConversations`, `findConversationById`,
     * `listConversationMessages`). Optional so legacy fixtures
     * keep compiling; production wiring (`WhatsAppModule` via the
     * `@Global` `RbacModule`) always provides it.
     */
    @Optional() private readonly visibility?: WhatsAppVisibilityService,
    /**
     * Phase D5 — D5.13: audit sink for the dedicated
     * `whatsapp.handover.completed` verb emitted alongside the
     * existing `LeadActivity` rows. The audit row carries
     * structural metadata only (`conversationId`, `leadId`,
     * `mode`, `notify`, `hasSummary`) — never `fromUserId`,
     * `toUserId`, or the summary text itself. Optional so legacy
     * fixtures (which build a thin WhatsAppService for routing /
     * inbound tests) keep compiling; production wiring
     * (`WhatsAppModule`) provides the real instance.
     */
    @Optional() private readonly audit?: AuditService,
  ) {}

  /**
   * Phase C — C10B-4: resolve the conversation scope `where` for the
   * calling user. Returns `null` when no claims, no scope service, or
   * the role's scope is `global` — the call site simply skips the
   * AND.
   */
  private async resolveConversationScopeWhere(
    userClaims: ScopeUserClaims | undefined,
  ): Promise<Prisma.WhatsAppConversationWhereInput | null> {
    if (!userClaims || !this.scopeContext) return null;
    const { where } = await this.scopeContext.resolveConversationScope(userClaims);
    return where;
  }

  /**
   * Phase C — C10B-4: visibility guard used by every write path. Re-
   * reads the conversation row through the actor's scope; if the
   * row doesn't exist or is out-of-scope, throws `whatsapp.conversation.not_found`
   * (404 keeps existence opaque across scope boundaries — same
   * semantic as `lead.not_found` in C3 / C10A).
   */
  private async assertConversationVisible(
    tx: Prisma.TransactionClient,
    conversationId: string,
    userClaims: ScopeUserClaims | undefined,
  ): Promise<void> {
    const scopeWhere =
      userClaims && this.scopeContext
        ? (await this.scopeContext.resolveConversationScope(userClaims)).where
        : null;
    const where: Prisma.WhatsAppConversationWhereInput = scopeWhere
      ? { AND: [{ id: conversationId }, scopeWhere] }
      : { id: conversationId };
    const row = await tx.whatsAppConversation.findFirst({ where, select: { id: true } });
    if (!row) {
      throw new NotFoundException({
        code: 'whatsapp.conversation.not_found',
        message: `Conversation ${conversationId} not found in active tenant`,
      });
    }
  }

  /**
   * Phase C — C10B-4: outbound auto-claim. When an agent sends an
   * outbound message on a conversation that currently has NO owner,
   * claim it on their behalf with `assignmentSource='outbound_self'`.
   *
   * Idempotent: a conversation that already has an `assignmentSource`
   * is left alone (the existing assignee is the owner; outbound from
   * another user does NOT steal the conversation).
   *
   * Denormalisation: read the actor's `teamId` from the user row so
   * the conversation's team scope stays in sync.
   */
  private async maybeAutoClaimOnOutbound(
    tx: Prisma.TransactionClient,
    conversationId: string,
    actorUserId: string,
  ): Promise<void> {
    const conversation = await tx.whatsAppConversation.findUnique({
      where: { id: conversationId },
      select: { assignmentSource: true },
    });
    if (!conversation || conversation.assignmentSource !== null) return;
    const actor = await tx.user.findUnique({
      where: { id: actorUserId },
      select: { teamId: true },
    });
    await tx.whatsAppConversation.update({
      where: { id: conversationId },
      data: {
        assignedToId: actorUserId,
        teamId: actor?.teamId ?? null,
        assignmentSource: 'outbound_self',
        assignedAt: new Date(),
      },
    });
  }

  /**
   * Phase C — C10B-4: assert the user has a given capability via
   * their role's RoleCapability join. Used by handover to confirm
   * the target assignee can actually see what they're being given
   * (locked decision §6).
   *
   * Note: this is a runtime read, separate from the `CapabilityGuard`
   * that gates the actor at the controller layer. Both are needed:
   * the guard validates the actor; this validates the target.
   */
  private async assertUserHasCapability(
    tx: Prisma.TransactionClient,
    userId: string,
    capabilityCode: string,
  ): Promise<boolean> {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { status: true, roleId: true },
    });
    if (!user || user.status !== 'active') return false;
    const grant = await tx.roleCapability.findFirst({
      where: { roleId: user.roleId, capability: { code: capabilityCode } },
      select: { roleId: true },
    });
    return grant !== null;
  }

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
    let result: { messageId: string; conversationId: string } | null = null;
    try {
      result = await this.prisma.withTenant(account.tenantId, (tx) =>
        this.persistInboundInTx(tx, account, msg),
      );
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

    // P3-02 — fan out to every connected agent in the tenant. Inbound
    // WhatsApp messages aren't owned by a single user, and any agent
    // browsing the inbox should see the conversation row update live.
    // Emitted post-commit so a client refetch always sees the new row.
    if (result && this.realtime) {
      this.emitInboundRealtime(account.tenantId, result);
    }
    return result;
  }

  /**
   * Phase C — C10B-3: tx-accepting variant of `persistInbound` so the
   * new `WhatsAppInboundService` orchestrator can compose persist +
   * contact match + routing + lead create-or-link inside a single
   * transaction. Returns `null` on duplicate provider id so the caller
   * can short-circuit before doing any orchestration work.
   *
   * The duplicate-suppression branch is the same `P2002` catch as the
   * public method — but here we let the error bubble up to the caller
   * so the surrounding orchestrator can decide whether to short-circuit
   * the whole chain (tests #1 expectations: a duplicate webhook never
   * re-routes an already-assigned conversation).
   */
  async persistInboundInTx(
    tx: Prisma.TransactionClient,
    account: RoutedAccount,
    msg: InboundMessage,
  ): Promise<{ messageId: string; conversationId: string } | null> {
    const conversationId = await this.ensureOpenConversation(
      tx,
      account.tenantId,
      account.id,
      msg.phone,
    );

    let messageId: string;
    try {
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
      messageId = message.id;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        // Idempotent path — caller short-circuits.
        return null;
      }
      throw err;
    }

    await tx.whatsAppConversation.update({
      where: { id: conversationId },
      data: {
        lastMessageAt: msg.receivedAt,
        lastMessageText: msg.text,
        // P2-12 — bump the customer-service-window timer so the
        // outbound freeform path knows the contact has replied
        // within the last 24h. Templates remain available even
        // when this is null.
        lastInboundAt: msg.receivedAt,
      },
    });

    return { messageId, conversationId };
  }

  /** C10B-3: small helper — used by both the legacy `persistInbound`
   *  path and the new orchestrator so the realtime emit shape stays
   *  uniform. */
  emitInboundRealtime(
    tenantId: string,
    payload: { messageId: string; conversationId: string },
  ): void {
    if (!this.realtime) return;
    try {
      this.realtime.emitToTenant(tenantId, {
        type: 'whatsapp.message',
        conversationId: payload.conversationId,
        messageId: payload.messageId,
        direction: 'inbound',
      });
    } catch (err) {
      this.logger.warn(`realtime emit skipped: ${(err as Error).message}`);
    }
  }

  // ─────── Outbound send ───────

  /**
   * Send a plain-text message via the provider configured on the
   * account, thread it into the open conversation for (account, to),
   * and bump the conversation summary. Tenant scope is required — the
   * caller must run under the active tenant context.
   *
   * Transaction discipline (C28 — production hardening):
   *   1. READ tx: load the account row (including the access token).
   *      The transaction closes immediately when the await returns.
   *   2. EXTERNAL CALL: hit the provider OUTSIDE any DB transaction.
   *      Holding a Postgres connection across a Meta round-trip
   *      (~500ms typical, multi-second under retry) starves the
   *      connection pool under modest load, so this MUST stay tx-free.
   *   3. WRITE tx: persist the outbound message + bump the conversation
   *      summary in a single short transaction.
   *
   * If the provider throws (network error, 4xx, 5xx), the WRITE tx is
   * never reached — no fake "sent" row is persisted. The caller sees
   * the original provider error.
   */
  async sendText(input: {
    tenantId: string;
    accountId: string;
    to: string;
    text: string;
    /**
     * Phase C — C10B-4: when supplied, the conversation gets auto-
     * claimed by `actorUserId` if its `assignedToId` is currently
     * NULL (locked decision §5: outbound_self).
     */
    actorUserId?: string;
  }): Promise<{ messageId: string; providerMessageId: string; conversationId: string }> {
    const { tenantId, accountId, to, text, actorUserId } = input;

    // Load the account first so a cross-tenant lookup surfaces a
    // typed `whatsapp.account_not_found` 404 instead of an
    // unauthenticated `whatsapp.window_closed` 400. P2-12 — only
    // then enforce Meta's 24-hour customer-service window.
    const { account, config } = await this.loadAccountForSend(tenantId, accountId);
    await this.assertWindowOpen(tenantId, accountId, to);

    const provider = this.providerFor(account.provider);
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
          messageType: 'text',
          providerMessageId,
          status: 'sent',
        },
        select: { id: true },
      });

      await tx.whatsAppConversation.update({
        where: { id: conversationId },
        data: { lastMessageAt: sentAt, lastMessageText: text },
      });

      // Phase C — C10B-4: outbound auto-claim. If the conversation has
      // no current owner, the agent who just replied becomes the
      // owner with assignmentSource='outbound_self'.
      if (actorUserId) {
        await this.maybeAutoClaimOnOutbound(tx, conversationId, actorUserId);
      }

      return { messageId: message.id, providerMessageId, conversationId };
    });
  }

  /**
   * P2-12 — send a Meta-approved template by name + language. This
   * is the one path that's allowed OUTSIDE the 24-hour customer-
   * service window: templates are how you initiate or re-open a
   * conversation. The CRM still requires the template to be
   * recorded in `whatsapp_templates` (admins maintain the picker
   * via the templates CRUD) so a typo in `templateName` doesn't
   * silently send something Meta will reject.
   */
  async sendTemplate(input: {
    tenantId: string;
    accountId: string;
    to: string;
    /** Phase C — C10B-4: see sendText. */
    actorUserId?: string;
    templateName: string;
    language: string;
    variables: readonly string[];
  }): Promise<{ messageId: string; providerMessageId: string; conversationId: string }> {
    const { tenantId, accountId, to, templateName, language, variables } = input;

    // Validate the template exists in our table + the variable
    // count matches before paying for the Meta round-trip.
    const tpl = await this.prisma.withTenant(tenantId, (tx) =>
      tx.whatsAppTemplate.findFirst({
        where: { accountId, name: templateName, language, status: 'approved' },
        select: { variableCount: true, bodyText: true },
      }),
    );
    if (!tpl) {
      throw new BadRequestException({
        code: 'whatsapp.template_not_found',
        message: `Approved template "${templateName}" (${language}) not found for this account`,
      });
    }
    if (variables.length !== tpl.variableCount) {
      throw new BadRequestException({
        code: 'whatsapp.template_variable_mismatch',
        message: `Template expects ${tpl.variableCount} variables, got ${variables.length}`,
      });
    }

    const { account, config } = await this.loadAccountForSend(tenantId, accountId);
    const provider = this.providerFor(account.provider);
    const { providerMessageId } = await provider.sendTemplate({
      config,
      to,
      templateName,
      language,
      variables,
    });

    // Render the template body for the inbox preview text. We
    // don't try to be fancy with formatting; substituting `{{N}}`
    // with the supplied values is enough.
    const renderedText = renderTemplateBody(tpl.bodyText, variables);

    return this.prisma.withTenant(tenantId, async (tx) => {
      const conversationId = await this.ensureOpenConversation(tx, tenantId, accountId, to);
      const sentAt = new Date();
      const message = await tx.whatsAppMessage.create({
        data: {
          tenantId,
          accountId,
          conversationId,
          phone: to,
          text: renderedText,
          direction: 'outbound',
          messageType: 'template',
          templateName,
          templateLanguage: language,
          providerMessageId,
          status: 'sent',
        },
        select: { id: true },
      });
      await tx.whatsAppConversation.update({
        where: { id: conversationId },
        data: { lastMessageAt: sentAt, lastMessageText: renderedText },
      });
      if (input.actorUserId) {
        await this.maybeAutoClaimOnOutbound(tx, conversationId, input.actorUserId);
      }
      return { messageId: message.id, providerMessageId, conversationId };
    });
  }

  /**
   * P2-12 — send media (image / document) by URL. Media-with-caption
   * counts as a freeform message; gated by the 24-hour window
   * exactly like sendText.
   */
  async sendMedia(input: {
    tenantId: string;
    accountId: string;
    to: string;
    kind: 'image' | 'document';
    mediaUrl: string;
    mediaMimeType?: string | null;
    caption?: string;
    /** Phase C — C10B-4: see sendText. */
    actorUserId?: string;
  }): Promise<{ messageId: string; providerMessageId: string; conversationId: string }> {
    const { tenantId, accountId, to, kind, mediaUrl } = input;
    const caption = input.caption ?? '';

    const { account, config } = await this.loadAccountForSend(tenantId, accountId);
    await this.assertWindowOpen(tenantId, accountId, to);
    const provider = this.providerFor(account.provider);
    const { providerMessageId } = await provider.sendMedia({
      config,
      to,
      kind,
      mediaUrl,
      ...(caption.length > 0 && { caption }),
    });

    return this.prisma.withTenant(tenantId, async (tx) => {
      const conversationId = await this.ensureOpenConversation(tx, tenantId, accountId, to);
      const sentAt = new Date();
      const previewText = caption.length > 0 ? caption : `[${kind}]`;
      const message = await tx.whatsAppMessage.create({
        data: {
          tenantId,
          accountId,
          conversationId,
          phone: to,
          text: previewText,
          direction: 'outbound',
          messageType: kind,
          mediaUrl,
          mediaMimeType: input.mediaMimeType ?? null,
          providerMessageId,
          status: 'sent',
        },
        select: { id: true },
      });
      await tx.whatsAppConversation.update({
        where: { id: conversationId },
        data: { lastMessageAt: sentAt, lastMessageText: previewText },
      });
      if (input.actorUserId) {
        await this.maybeAutoClaimOnOutbound(tx, conversationId, input.actorUserId);
      }
      return { messageId: message.id, providerMessageId, conversationId };
    });
  }

  /**
   * P2-12 — common pre-flight: read the account row, decrypt the
   * access token, build the provider config. Throws 404 when the
   * account is missing or disabled. Used by sendText / sendTemplate /
   * sendMedia.
   */
  private async loadAccountForSend(
    tenantId: string,
    accountId: string,
  ): Promise<{
    account: {
      id: string;
      provider: string;
      phoneNumberId: string;
      accessToken: string;
      appSecret: string | null;
      verifyToken: string;
    };
    config: WhatsAppAccountConfig;
  }> {
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
    const config: WhatsAppAccountConfig = {
      accessToken: decryptSecret(account.accessToken),
      phoneNumberId: account.phoneNumberId,
      appSecret: account.appSecret,
      verifyToken: account.verifyToken,
    };
    return { account, config };
  }

  /**
   * P2-12 — Meta's 24-hour customer-service window:
   *   - if the contact has NEVER replied (`lastInboundAt = null`)
   *     freeform send is denied. Use a template instead.
   *   - if their last reply was > 24h ago, same denial.
   *   - otherwise allowed.
   *
   * For a not-yet-existing conversation we treat it as
   * `lastInboundAt = null` and deny — there's no reason for a
   * tenant to reach a brand-new contact with a freeform message
   * via the CRM; the first touch must go through a template.
   */
  private async assertWindowOpen(
    tenantId: string,
    accountId: string,
    phone: string,
  ): Promise<void> {
    const conversation = await this.prisma.withTenant(tenantId, (tx) =>
      tx.whatsAppConversation.findFirst({
        where: { accountId, phone },
        select: { lastInboundAt: true },
      }),
    );
    const lastInboundAt = conversation?.lastInboundAt ?? null;
    if (!lastInboundAt) {
      throw new BadRequestException({
        code: 'whatsapp.window_closed',
        message: 'Cannot send a freeform message before the contact has replied. Use a template.',
      });
    }
    const ageMs = Date.now() - lastInboundAt.getTime();
    if (ageMs > WHATSAPP_WINDOW_MS) {
      throw new BadRequestException({
        code: 'whatsapp.window_closed',
        message: `Customer-service window expired ${Math.round(
          ageMs / (60 * 60 * 1000),
        )}h ago. Use a template to re-open the conversation.`,
      });
    }
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
  async listConversations(
    tenantId: string,
    opts: {
      accountId?: string;
      status?: 'open' | 'closed';
      phone?: string;
      limit?: number;
      offset?: number;
    } = {},
    userClaims?: ScopeUserClaims,
  ) {
    // Phase C — C10B-4: AND the role's conversation scope into the
    // existing filter. Unassigned conversations are invisible to
    // own / team / company / country scope holders (locked decision §1);
    // admins surface them via the review queue.
    const scopeWhere = await this.resolveConversationScopeWhere(userClaims);
    // D5.12-A — resolve the caller's whatsapp.conversation visibility
    // ONCE per request; applied to each row below. When the
    // visibility service isn't wired (legacy fixtures / inbound
    // path with no claims), every row passes through unchanged.
    const visibility =
      userClaims && this.visibility
        ? await this.visibility.resolveConversationVisibility(userClaims)
        : null;
    return this.prisma.withTenant(tenantId, async (tx) => {
      const baseWhere: Prisma.WhatsAppConversationWhereInput = {
        ...(opts.accountId && { accountId: opts.accountId }),
        ...(opts.status && { status: opts.status }),
        ...(opts.phone && { phone: { contains: opts.phone } }),
      };
      const where: Prisma.WhatsAppConversationWhereInput = scopeWhere
        ? { AND: [baseWhere, scopeWhere] }
        : baseWhere;
      const [rawItems, total] = await Promise.all([
        tx.whatsAppConversation.findMany({
          where,
          orderBy: { lastMessageAt: 'desc' },
          take: opts.limit ?? 50,
          skip: opts.offset ?? 0,
          // D1.1 — surface assignee name + contact identity so the
          // inbox list can render owner/contact badges without an
          // N+1 user lookup.
          include: {
            assignedTo: { select: { id: true, name: true, email: true, teamId: true } },
            contact: {
              select: {
                id: true,
                phone: true,
                displayName: true,
                language: true,
                isCaptain: true,
                hasOpenLead: true,
              },
            },
          },
        }),
        tx.whatsAppConversation.count({ where }),
      ]);
      // D5.12-A — apply per-row redaction: null-out lastMessageText
      // when the preview predates a handover assignedAt AND the
      // role can't see prior agent messages, and strip
      // assignmentSource / assignedTo.email when internal metadata
      // is denied. Row count is preserved.
      let items = rawItems;
      if (visibility !== null && this.visibility) {
        const helper = this.visibility;
        items = await Promise.all(
          rawItems.map(async (row) => {
            const mode = await helper.resolveTransferMode(tx, {
              id: row.id,
              leadId: row.leadId,
              assignmentSource: row.assignmentSource,
            });
            return helper.applyConversationListRow(row, visibility, mode);
          }),
        );
      }
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
  async findConversationById(tenantId: string, id: string, userClaims?: ScopeUserClaims) {
    // Phase C — C10B-4: out-of-scope direct access returns null so
    // the controller maps to a clean 404 (no scope leak).
    const scopeWhere = await this.resolveConversationScopeWhere(userClaims);
    const visibility =
      userClaims && this.visibility
        ? await this.visibility.resolveConversationVisibility(userClaims)
        : null;
    return this.prisma.withTenant(tenantId, async (tx) => {
      const where: Prisma.WhatsAppConversationWhereInput = scopeWhere
        ? { AND: [{ id }, scopeWhere] }
        : { id };
      const row = await tx.whatsAppConversation.findFirst({
        where,
        // D1.1 — side-panel needs lead + contact + assignee in one
        // round-trip. Stage join lets the lead card render its
        // pipeline badge without a follow-up call.
        include: {
          lead: { include: { stage: true } },
          contact: true,
          assignedTo: { select: { id: true, name: true, email: true, teamId: true } },
        },
      });
      if (!row) return null;
      const linked = row.leadId !== null ? row : await this.maybeAutoLinkLead(tx, row);
      if (!linked) return null;
      // D5.12-A — apply detail-shape redaction (top-level
      // `priorMessagesHidden` / `handoverChainHidden` /
      // `historyHidden` flags + null'd lastMessageText preview /
      // assignmentSource / email).
      if (visibility !== null && this.visibility) {
        const mode = await this.visibility.resolveTransferMode(tx, {
          id: linked.id,
          leadId: linked.leadId,
          assignmentSource: linked.assignmentSource,
        });
        return this.visibility.applyConversationDetailRow(linked, visibility, mode);
      }
      return linked;
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
    userClaims?: ScopeUserClaims,
  ) {
    const scopeWhere = await this.resolveConversationScopeWhere(userClaims);
    const visibility =
      userClaims && this.visibility
        ? await this.visibility.resolveConversationVisibility(userClaims)
        : null;
    return this.prisma.withTenant(tenantId, async (tx) => {
      // Phase C — C10B-4: gate on conversation visibility before
      // returning any messages.
      const where: Prisma.WhatsAppConversationWhereInput = scopeWhere
        ? { AND: [{ id: conversationId }, scopeWhere] }
        : { id: conversationId };
      // D5.12-A — load assignmentSource + assignedAt so the
      // visibility helper can resolve transfer mode + apply the
      // prior-message cutoff. Pre-D5.12-A queries selected only
      // id/phone/leadId; the extra columns are tiny scalars on the
      // same row.
      const conversation = await tx.whatsAppConversation.findFirst({
        where,
        select: {
          id: true,
          phone: true,
          leadId: true,
          assignmentSource: true,
          assignedAt: true,
        },
      });
      if (!conversation) return null;
      if (conversation.leadId === null) {
        await this.maybeAutoLinkLead(tx, conversation);
      }
      // D5.12-A — DB-level cutoff: when the visibility rules say
      // "hide prior messages" AND a handover assignedAt timestamp
      // exists, the SQL filter excludes older rows so the message
      // list NEVER ships them. Hidden rows do not leak via count,
      // pagination, or any other channel.
      let createdAtCutoff: Date | null = null;
      if (visibility !== null && this.visibility) {
        const mode = await this.visibility.resolveTransferMode(tx, {
          id: conversation.id,
          leadId: conversation.leadId,
          assignmentSource: conversation.assignmentSource,
        });
        if (this.visibility.shouldHidePriorMessages(visibility, mode)) {
          createdAtCutoff = conversation.assignedAt ?? null;
        }
      }
      return tx.whatsAppMessage.findMany({
        where: {
          conversationId,
          ...(createdAtCutoff && { createdAt: { gte: createdAtCutoff } }),
        },
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
    /**
     * Phase C — C10B-4: scope claims. When supplied, both the
     * conversation AND the lead must be visible under the actor's
     * scope. Out-of-scope on either side throws `*.not_found` (locked
     * decision §2 — never 403, no existence leak).
     */
    userClaims?: ScopeUserClaims,
  ): Promise<{
    id: string;
    leadId: string | null;
  }> {
    const conversationScope = await this.resolveConversationScopeWhere(userClaims);
    const leadScope =
      userClaims && this.scopeContext
        ? (await this.scopeContext.resolveLeadScope(userClaims)).where
        : null;
    return this.prisma.withTenant(tenantId, async (tx) => {
      const convoWhere: Prisma.WhatsAppConversationWhereInput = conversationScope
        ? { AND: [{ id: conversationId }, conversationScope] }
        : { id: conversationId };
      const conversation = await tx.whatsAppConversation.findFirst({
        where: convoWhere,
        select: { id: true },
      });
      if (!conversation) {
        throw new NotFoundException({
          code: 'whatsapp.conversation_not_found',
          message: `Conversation ${conversationId} not found in active tenant`,
        });
      }
      const leadWhere: Prisma.LeadWhereInput = leadScope
        ? { AND: [{ id: leadId }, leadScope] }
        : { id: leadId };
      const lead = await tx.lead.findFirst({
        where: leadWhere,
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
   * Phase C — C10B-4: clear the conversation's `leadId`. Ownership
   * (assignedToId / teamId / companyId / countryId) is preserved —
   * unlinking the lead does not orphan the conversation.
   */
  async unlinkConversationLead(
    tenantId: string,
    conversationId: string,
    userClaims?: ScopeUserClaims,
  ): Promise<{ id: string; leadId: string | null }> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.assertConversationVisible(tx, conversationId, userClaims);
      const updated = await tx.whatsAppConversation.update({
        where: { id: conversationId },
        data: { leadId: null },
        select: { id: true, leadId: true },
      });
      return updated;
    });
  }

  /**
   * Phase C — C10B-4: admin-style direct assignment. Bypasses the
   * lead-reassignment + handover audit chain — used when ops needs
   * to forcibly reassign a conversation. Same target-capability
   * check as handover (locked decision §6).
   */
  async assignConversation(
    tenantId: string,
    conversationId: string,
    newAssigneeId: string,
    userClaims?: ScopeUserClaims,
  ): Promise<{ id: string; assignedToId: string; teamId: string | null }> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.assertConversationVisible(tx, conversationId, userClaims);
      const target = await tx.user.findUnique({
        where: { id: newAssigneeId },
        select: { id: true, status: true, teamId: true },
      });
      if (!target || target.status !== 'active') {
        throw new NotFoundException({
          code: 'whatsapp.assignee_not_found',
          message: `Assignee ${newAssigneeId} not found / disabled in active tenant`,
        });
      }
      const canRead = await this.assertUserHasCapability(
        tx,
        newAssigneeId,
        'whatsapp.conversation.read',
      );
      if (!canRead) {
        throw new BadRequestException({
          code: 'whatsapp.assign.target_lacks_capability',
          message: `Assignee ${newAssigneeId} cannot read WhatsApp conversations`,
        });
      }
      const updated = await tx.whatsAppConversation.update({
        where: { id: conversationId },
        data: {
          assignedToId: newAssigneeId,
          teamId: target.teamId,
          assignmentSource: 'manual_handover',
          assignedAt: new Date(),
        },
        select: { id: true, assignedToId: true, teamId: true },
      });
      return {
        id: updated.id,
        assignedToId: updated.assignedToId!,
        teamId: updated.teamId,
      };
    });
  }

  /**
   * Phase C — C10B-4: flip status to 'closed'. Idempotent — closing
   * an already-closed conversation is a no-op. Closure does NOT
   * detach ownership (the audit log keeps showing who owned it
   * when it was active).
   */
  async closeConversation(
    tenantId: string,
    conversationId: string,
    userClaims?: ScopeUserClaims,
  ): Promise<{ id: string; status: string }> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.assertConversationVisible(tx, conversationId, userClaims);
      const updated = await tx.whatsAppConversation.update({
        where: { id: conversationId },
        data: { status: 'closed' },
        select: { id: true, status: true },
      });
      return updated;
    });
  }

  /**
   * Phase C — C10B-4: flip status back to 'open'. The partial-unique
   * index `(tenantId, accountId, phone) WHERE status='open'` rejects
   * reopen if there's already another open conversation for the same
   * (account, phone). The DB error surfaces as a typed 409.
   */
  async reopenConversation(
    tenantId: string,
    conversationId: string,
    userClaims?: ScopeUserClaims,
  ): Promise<{ id: string; status: string }> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.assertConversationVisible(tx, conversationId, userClaims);
      try {
        const updated = await tx.whatsAppConversation.update({
          where: { id: conversationId },
          data: { status: 'open' },
          select: { id: true, status: true },
        });
        return updated;
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw new BadRequestException({
            code: 'whatsapp.conversation.reopen_conflict',
            message:
              'Another open conversation already exists for this (account, phone). Close it first.',
          });
        }
        throw err;
      }
    });
  }

  /**
   * C35 — handover a conversation (and its linked lead) to another
   * agent. Three transfer modes:
   *
   *   - `full`    — keep history, just reassign the lead.
   *   - `clean`   — close the current conversation. The next inbound
   *                 from the same phone opens a fresh thread under the
   *                 new agent (the partial-unique-on-open index from
   *                 C22 takes care of that).
   *   - `summary` — additionally writes a `note` lead-activity carrying
   *                 the outgoing agent's handover summary.
   *
   * Always emits an `assignment` activity row with a payload describing
   * the handover so the audit trail captures who → who, mode, and the
   * notify flag.
   *
   * Cross-tenant ids surface as 404 because RLS hides them.
   */
  async handoverConversation(
    tenantId: string,
    conversationId: string,
    opts: {
      newAssigneeId: string;
      mode: 'full' | 'clean' | 'summary';
      summary?: string;
      notify?: boolean;
      actorUserId: string | null;
      /** Phase C — C10B-4: scope check + audit context. */
      userClaims?: ScopeUserClaims;
    },
  ): Promise<{
    conversationId: string;
    leadId: string;
    fromUserId: string | null;
    toUserId: string;
    mode: 'full' | 'clean' | 'summary';
  }> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      // Phase C — C10B-4: visibility check first; out-of-scope hand-
      // overs throw `whatsapp.conversation.not_found` (404 keeps
      // existence opaque across scope boundaries).
      await this.assertConversationVisible(tx, conversationId, opts.userClaims);
      const conversation = await tx.whatsAppConversation.findUnique({
        where: { id: conversationId },
        select: { id: true, leadId: true, status: true },
      });
      if (!conversation) {
        throw new NotFoundException({
          code: 'whatsapp.conversation_not_found',
          message: `Conversation ${conversationId} not found in active tenant`,
        });
      }
      if (!conversation.leadId) {
        throw new NotFoundException({
          code: 'whatsapp.conversation_not_linked',
          message:
            'Conversation has no linked lead — link it first via POST /:id/link-lead before handover',
        });
      }

      const lead = await tx.lead.findUnique({
        where: { id: conversation.leadId },
        select: { id: true, assignedToId: true },
      });
      if (!lead) {
        throw new NotFoundException({
          code: 'whatsapp.lead_not_found',
          message: `Linked lead ${conversation.leadId} not found in active tenant`,
        });
      }

      const newAssignee = await tx.user.findUnique({
        where: { id: opts.newAssigneeId },
        select: { id: true, status: true, teamId: true },
      });
      if (!newAssignee || newAssignee.status === 'disabled') {
        throw new NotFoundException({
          code: 'whatsapp.assignee_not_found',
          message: `Assignee ${opts.newAssigneeId} not found / disabled in active tenant`,
        });
      }

      // Phase C — C10B-4 (locked decision §6): the target assignee
      // must hold `whatsapp.conversation.read` so the hand-off
      // doesn't land them with a row they can't open. This guards
      // against role mis-configuration (e.g. handing over to an
      // activation_agent on a sales conversation).
      const canRead = await this.assertUserHasCapability(
        tx,
        opts.newAssigneeId,
        'whatsapp.conversation.read',
      );
      if (!canRead) {
        throw new BadRequestException({
          code: 'whatsapp.handover.target_lacks_capability',
          message: `Assignee ${opts.newAssigneeId} cannot read WhatsApp conversations`,
        });
      }

      const fromUserId = lead.assignedToId;

      // Reassign the lead.
      await tx.lead.update({
        where: { id: lead.id },
        data: { assignedToId: opts.newAssigneeId },
      });

      // Phase C — C10B-4: denormalise the new ownership onto the
      // conversation row. Mirrors the inbound flow's pattern but
      // uses `assignmentSource='manual_handover'` so audit can tell
      // them apart.
      await tx.whatsAppConversation.update({
        where: { id: conversationId },
        data: {
          assignedToId: opts.newAssigneeId,
          teamId: newAssignee.teamId,
          assignmentSource: 'manual_handover',
          assignedAt: new Date(),
          // Status update for clean-mode happens below as a separate
          // call so the existing flow stays untouched.
        },
      });

      // Close the conversation on a clean transfer.
      if (opts.mode === 'clean' && conversation.status !== 'closed') {
        await tx.whatsAppConversation.update({
          where: { id: conversationId },
          data: { status: 'closed' },
        });
      }

      // Audit trail — `assignment` activity with handover payload.
      await tx.leadActivity.create({
        data: {
          tenantId,
          leadId: lead.id,
          type: 'assignment',
          body: `WhatsApp handover (${opts.mode})`,
          payload: {
            event: 'whatsapp_handover',
            conversationId,
            mode: opts.mode,
            fromUserId,
            toUserId: opts.newAssigneeId,
            notify: opts.notify ?? false,
            ...(opts.summary ? { summary: opts.summary } : {}),
          } as Prisma.InputJsonValue,
          createdById: opts.actorUserId ?? null,
        },
      });

      // Summary mode also emits the summary as a regular note so it
      // shows up in the lead's activity timeline next to the handover.
      if (opts.mode === 'summary' && opts.summary) {
        await tx.leadActivity.create({
          data: {
            tenantId,
            leadId: lead.id,
            type: 'note',
            body: opts.summary,
            payload: {
              event: 'whatsapp_handover_summary',
              fromUserId,
              toUserId: opts.newAssigneeId,
            } as Prisma.InputJsonValue,
            createdById: opts.actorUserId ?? null,
          },
        });
      }

      // D5.13 — emit a dedicated `whatsapp.handover.completed`
      // audit row alongside the LeadActivity rows. The
      // governance audit feed filters on action-prefix groups
      // (D5.11); the dedicated verb lets the `whatsapp_handover`
      // chip light up cleanly without payload-key matching. The
      // payload carries STRUCTURAL metadata only — no
      // `fromUserId` / `toUserId` (gated by REST field
      // permissions), no `summary` text (gated by the
      // `whatsapp.conversation.handoverSummary` field
      // permission — see D5.12-B). The flag `hasSummary`
      // signals whether a summary note exists without echoing
      // its content.
      if (this.audit) {
        await this.audit.writeInTx(tx, tenantId, {
          action: 'whatsapp.handover.completed',
          entityType: 'whatsapp_conversation',
          entityId: conversationId,
          actorUserId: opts.actorUserId ?? null,
          payload: {
            conversationId,
            leadId: lead.id,
            mode: opts.mode,
            notify: opts.notify ?? false,
            hasSummary: Boolean(opts.summary && opts.summary.length > 0),
          },
        });
      }

      // P2-02 — notify the new assignee that a conversation just
      // landed in their lap. Self-handover (testing) doesn't bell.
      //
      // D5.13 — Notification body MUST stay neutral. The summary
      // text (when present) can quote prior-agent or customer
      // content; we never put it in the body. The recipient reads
      // the full handover note through the lead timeline, where
      // the `whatsapp_handover_summary` activity is already gated
      // by the `whatsapp.conversation.handoverSummary` field
      // permission (see D5.12-B). The payload also DROPS
      // `fromUserId` — clients re-fetch the canonical record via
      // the (already-redacted) REST endpoints when they need the
      // identity. The structural fields (`conversationId`,
      // `leadId`, `mode`) stay so the bell can deep-link.
      if (this.notifications && opts.newAssigneeId !== opts.actorUserId) {
        await this.notifications.createInTx(tx, tenantId, {
          recipientUserId: opts.newAssigneeId,
          kind: 'whatsapp.handover',
          title: 'WhatsApp conversation handed to you',
          body: `Transfer mode: ${opts.mode}`,
          payload: {
            conversationId,
            leadId: lead.id,
            mode: opts.mode,
          },
        });
      }

      return {
        conversationId,
        leadId: lead.id,
        fromUserId,
        toUserId: opts.newAssigneeId,
        mode: opts.mode,
      };
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
