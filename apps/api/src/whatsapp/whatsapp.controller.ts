import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { WhatsAppService } from './whatsapp.service';

/**
 * /api/v1/webhooks/whatsapp — provider-facing webhook surface.
 *
 * INTENTIONALLY PUBLIC: no JwtAuthGuard, no tenant header. Meta hits this
 * endpoint directly. Authentication is performed against the matched
 * WhatsAppAccount's `verifyToken` (GET handshake) and HMAC `appSecret`
 * (POST signature). All cross-tenant lookups go through
 * `WhatsAppService.findRoutingByPhoneNumberId` which reads the
 * non-RLS'd `whatsapp_routes` table — kept in sync by a trigger on
 * `whatsapp_accounts` and carrying only routing fields (no access token).
 */
@ApiTags('whatsapp')
@Controller('webhooks/whatsapp')
export class WhatsAppController {
  private readonly logger = new Logger(WhatsAppController.name);

  constructor(private readonly whatsapp: WhatsAppService) {}

  /**
   * GET handshake. Meta sends:
   *   GET /webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...
   *
   * We resolve the matching account by `verifyToken` (unique per active
   * account), let the provider verify the rest of the query, and echo
   * back `hub.challenge` on success.
   */
  @Get()
  @ApiOperation({ summary: 'Provider webhook GET handshake' })
  async verify(@Query() query: Record<string, string | undefined>): Promise<string> {
    const presented = query['hub.verify_token'];
    if (typeof presented !== 'string' || presented.length === 0) {
      throw new BadRequestException({
        code: 'whatsapp.invalid_verify',
        message: 'Missing hub.verify_token',
      });
    }

    const account = await this.whatsapp.findRoutingByVerifyToken(presented);
    if (!account) {
      throw new BadRequestException({
        code: 'whatsapp.invalid_verify',
        message: 'Verify token does not match any active account',
      });
    }

    const provider = this.whatsapp.providerFor(account.provider);
    const challenge = provider.verifyWebhook(query, account.verifyToken);
    if (challenge === null) {
      throw new BadRequestException({
        code: 'whatsapp.invalid_verify',
        message: 'Webhook handshake rejected',
      });
    }
    return challenge;
  }

  /**
   * POST inbound. Meta delivers webhook payloads here. We:
   *   1. Resolve the account from the payload's metadata.phone_number_id.
   *   2. Verify the HMAC signature when the account has an appSecret.
   *   3. Parse + persist user-authored text messages (idempotent).
   *
   * Statuses, delivery receipts, and non-text events are silently
   * skipped (handled in a later chunk).
   */
  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Provider webhook POST inbound' })
  async inbound(
    @Body() body: unknown,
    @Req() req: Request & { rawBody?: Buffer | undefined },
  ): Promise<{ ok: true; ingested: number; duplicates: number }> {
    // Routing — pull the first phone-number-id we can find. Meta's payload
    // can carry multiple entries each with their own phone-number-id, but
    // a single delivery is always for one Business Account / phone, so
    // the first one is enough for the account lookup.
    const phoneNumberId = extractFirstPhoneNumberId(body);
    if (!phoneNumberId) {
      // Not a `messages` payload — Meta sometimes pings the URL with
      // status events alone. Reply 200 so the provider doesn't retry.
      return { ok: true, ingested: 0, duplicates: 0 };
    }

    const account = await this.whatsapp.findRoutingByPhoneNumberId(phoneNumberId);
    if (!account) {
      this.logger.warn(`inbound webhook for unknown phone_number_id ${phoneNumberId}`);
      return { ok: true, ingested: 0, duplicates: 0 };
    }

    const provider = this.whatsapp.providerFor(account.provider);

    // Signature verification — only enforced when the account is
    // configured with an appSecret.
    const signature = req.header('x-hub-signature-256') ?? undefined;
    const raw = req.rawBody?.toString('utf8') ?? JSON.stringify(body);
    if (!provider.verifySignature(raw, signature, account.appSecret)) {
      throw new BadRequestException({
        code: 'whatsapp.invalid_signature',
        message: 'Webhook signature does not match',
      });
    }

    const messages = provider.parseInbound(body);
    let ingested = 0;
    let duplicates = 0;
    for (const msg of messages) {
      const id = await this.whatsapp.persistInbound(account, msg);
      if (id === null) duplicates += 1;
      else ingested += 1;
    }

    return { ok: true, ingested, duplicates };
  }
}

/** Tolerant extraction so a malformed body returns null instead of crashing. */
function extractFirstPhoneNumberId(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const entries = body['entry'];
  if (!Array.isArray(entries)) return null;
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const changes = entry['changes'];
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      if (!isRecord(change)) continue;
      const value = change['value'];
      if (!isRecord(value)) continue;
      const metadata = value['metadata'];
      if (!isRecord(metadata)) continue;
      const id = metadata['phone_number_id'];
      if (typeof id === 'string' && id.length > 0) return id;
    }
  }
  return null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}
