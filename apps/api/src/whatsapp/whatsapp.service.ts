import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { MetaCloudProvider } from './meta-cloud.provider';
import type { InboundMessage, WhatsAppAccountConfig, WhatsAppProvider } from './whatsapp.provider';

const META_CLOUD = 'meta_cloud' as const;

/** Routing record returned by the cross-tenant phone-number-id lookup. */
export interface RoutedAccount {
  id: string;
  tenantId: string;
  provider: string;
  appSecret: string | null;
  verifyToken: string;
}

/** Raw shape returned by the SECURITY DEFINER routing functions. */
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
 *   2. Idempotent persistence of inbound + outbound messages under the
 *      account's tenant scope (so RLS + tenant isolation hold).
 *   3. Outbound `sendText` that routes through the appropriate provider
 *      and logs the resulting message.
 *
 * The provider layer is injected via the `providerFor` factory so the
 * unit tests can substitute a stub without hitting Meta.
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

  // ─────── Inbound persistence ───────

  /**
   * Persist a parsed inbound message under the account's tenant scope.
   * Returns the new message id, or `null` when the message has already
   * been ingested (idempotent on `(tenantId, providerMessageId)`).
   */
  async persistInbound(account: RoutedAccount, msg: InboundMessage): Promise<string | null> {
    try {
      const created = await this.prisma.withTenant(account.tenantId, (tx) =>
        tx.whatsAppMessage.create({
          data: {
            tenantId: account.tenantId,
            accountId: account.id,
            phone: msg.phone,
            text: msg.text,
            direction: 'inbound',
            providerMessageId: msg.providerMessageId,
            status: 'received',
            createdAt: msg.receivedAt,
          },
          select: { id: true },
        }),
      );
      return created.id;
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
   * account, then persist the outbound row. Tenant scope is required —
   * the caller (a future API endpoint, currently nothing) must run
   * under the active tenant context.
   */
  async sendText(input: {
    tenantId: string;
    accountId: string;
    to: string;
    text: string;
  }): Promise<{ messageId: string; providerMessageId: string }> {
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

    const created = await this.prisma.withTenant(tenantId, (tx) =>
      tx.whatsAppMessage.create({
        data: {
          tenantId,
          accountId,
          phone: to,
          text,
          direction: 'outbound',
          providerMessageId,
          status: 'sent',
        },
        select: { id: true },
      }),
    );
    return { messageId: created.id, providerMessageId };
  }

  // ─────── Module-internal helpers used by tests + admin tooling ───────

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
