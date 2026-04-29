import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type {
  ConnectionTestResult,
  InboundMessage,
  OutboundResult,
  WhatsAppAccountConfig,
  WhatsAppProvider,
} from './whatsapp.provider';

const META_GRAPH_BASE = 'https://graph.facebook.com/v20.0';

/** Minimal `fetch`-compatible function so tests can swap a stub. */
export type FetchFn = (
  input: string,
  init?: RequestInit,
) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
}>;

/**
 * Meta WhatsApp Business Platform — Cloud API provider.
 *
 * Reference:
 *   - GET handshake:  https://developers.facebook.com/docs/graph-api/webhooks/getting-started#configure-webhooks-product
 *   - Inbound shape:  https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples
 *   - Send message:   https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages
 *
 * The implementation deliberately covers only what C21 needs:
 *   - GET ?hub.mode=subscribe&hub.verify_token=…&hub.challenge=… handshake
 *   - HMAC-SHA256 signature verification of POST bodies (x-hub-signature-256)
 *   - Inbound parsing: walks entry[].changes[].value.messages[] and emits
 *     one InboundMessage per text message; non-text events are skipped.
 *   - Outbound: POST messages endpoint with type=text + body. Media,
 *     templates, and reactions land in a later chunk.
 */
@Injectable()
export class MetaCloudProvider implements WhatsAppProvider {
  private readonly logger = new Logger(MetaCloudProvider.name);

  /**
   * Allow tests to inject a `fetch` stub. Production wiring uses the
   * global `fetch` (Node 20+).
   */
  constructor(private readonly fetchImpl: FetchFn = globalThis.fetch as unknown as FetchFn) {}

  // ─────── GET handshake ───────

  verifyWebhook(
    query: Record<string, string | undefined>,
    expectedVerifyToken: string,
  ): string | null {
    const mode = query['hub.mode'];
    const token = query['hub.verify_token'];
    const challenge = query['hub.challenge'];
    if (mode !== 'subscribe') return null;
    if (typeof token !== 'string' || token !== expectedVerifyToken) return null;
    if (typeof challenge !== 'string' || challenge.length === 0) return null;
    return challenge;
  }

  // ─────── HMAC signature verification ───────

  verifySignature(
    rawBody: string,
    signatureHeader: string | undefined,
    appSecret: string | null,
  ): boolean {
    // No app secret configured → signatures aren't enforceable. Acceptable
    // in dev; deployments must always set an appSecret in production.
    if (appSecret === null || appSecret.length === 0) return true;
    if (!signatureHeader) return false;

    // Meta sends `sha256=<hex>`; some BSP relays drop the prefix.
    const presented = signatureHeader.startsWith('sha256=')
      ? signatureHeader.slice('sha256='.length)
      : signatureHeader;
    if (!/^[0-9a-f]+$/iu.test(presented)) return false;

    const expected = createHmac('sha256', appSecret).update(rawBody).digest('hex');
    if (presented.length !== expected.length) return false;

    try {
      return timingSafeEqual(Buffer.from(presented, 'hex'), Buffer.from(expected, 'hex'));
    } catch {
      return false;
    }
  }

  // ─────── Inbound parsing ───────

  parseInbound(body: unknown): readonly InboundMessage[] {
    const out: InboundMessage[] = [];
    if (!isRecord(body)) return out;

    const entries = body['entry'];
    if (!Array.isArray(entries)) return out;

    for (const entry of entries) {
      if (!isRecord(entry)) continue;
      const changes = entry['changes'];
      if (!Array.isArray(changes)) continue;

      for (const change of changes) {
        if (!isRecord(change)) continue;
        const value = change['value'];
        if (!isRecord(value)) continue;

        // Only "messages" events carry user-authored inbound text. Status
        // events live under value.statuses and are skipped here.
        const messages = value['messages'];
        if (!Array.isArray(messages)) continue;

        const metadata = isRecord(value['metadata']) ? value['metadata'] : null;
        const phoneNumberId =
          metadata && typeof metadata['phone_number_id'] === 'string'
            ? (metadata['phone_number_id'] as string)
            : '';

        for (const m of messages) {
          if (!isRecord(m)) continue;
          if (m['type'] !== 'text') continue; // skip media / interactive in C21
          const text =
            isRecord(m['text']) && typeof m['text']['body'] === 'string' ? m['text']['body'] : '';
          if (text.length === 0) continue;
          const phone = typeof m['from'] === 'string' ? (m['from'] as string) : '';
          const id = typeof m['id'] === 'string' ? (m['id'] as string) : '';
          const ts =
            typeof m['timestamp'] === 'string'
              ? Number.parseInt(m['timestamp'] as string, 10)
              : NaN;
          const receivedAt = Number.isFinite(ts) ? new Date(ts * 1000) : new Date();
          if (phone.length === 0 || id.length === 0 || phoneNumberId.length === 0) continue;
          out.push({
            phone: normalizeLeadingPlus(phone),
            text,
            providerMessageId: id,
            receivedAt,
            phoneNumberId,
          });
        }
      }
    }
    return out;
  }

  // ─────── Outbound send ───────

  async sendText(input: {
    config: WhatsAppAccountConfig;
    to: string;
    text: string;
  }): Promise<OutboundResult> {
    const { config, to, text } = input;
    const url = `${META_GRAPH_BASE}/${encodeURIComponent(config.phoneNumberId)}/messages`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: stripLeadingPlus(to),
        type: 'text',
        text: { body: text },
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      this.logger.warn(`MetaCloudProvider.sendText failed: ${res.status} ${detail.slice(0, 200)}`);
      throw new Error(`whatsapp_send_failed:${res.status}`);
    }

    const parsed = (await res.json()) as Record<string, unknown>;
    const messages = parsed['messages'];
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new Error('whatsapp_send_unexpected_response');
    }
    const first = messages[0] as Record<string, unknown>;
    const id = typeof first['id'] === 'string' ? first['id'] : '';
    if (id.length === 0) {
      throw new Error('whatsapp_send_missing_message_id');
    }
    return { providerMessageId: id };
  }

  // ─────── Test connection (admin liveness check) ───────

  /**
   * Hits Meta's `GET /v20.0/{phone-number-id}?fields=display_phone_number,verified_name`.
   * A 200 response with a recognisable shape means the access token + phone
   * number id are paired correctly. Any non-2xx is reported as `ok: false`
   * with the message redacted of raw provider error bodies (so we never
   * leak token-related strings into the admin UI).
   */
  async testConnection(input: { config: WhatsAppAccountConfig }): Promise<ConnectionTestResult> {
    const { config } = input;
    const url =
      `${META_GRAPH_BASE}/${encodeURIComponent(config.phoneNumberId)}` +
      `?fields=display_phone_number,verified_name`;

    let res: Awaited<ReturnType<FetchFn>>;
    try {
      res = await this.fetchImpl(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${config.accessToken}` },
      });
    } catch (err) {
      // Network-level failure (DNS, TLS, timeout). Don't include the
      // exception message verbatim — it could echo the raw URL with the
      // (sensitive) phone-number-id.
      this.logger.warn(`testConnection network error: ${(err as Error).name}`);
      return { ok: false, message: 'Network error reaching Meta' };
    }

    if (!res.ok) {
      return { ok: false, message: `Meta rejected the request (HTTP ${res.status})` };
    }

    const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const displayPhoneNumber =
      typeof parsed['display_phone_number'] === 'string'
        ? (parsed['display_phone_number'] as string)
        : undefined;
    const verifiedName =
      typeof parsed['verified_name'] === 'string' ? (parsed['verified_name'] as string) : undefined;

    return {
      ok: true,
      message: 'Connection healthy',
      ...(displayPhoneNumber !== undefined && { displayPhoneNumber }),
      ...(verifiedName !== undefined && { verifiedName }),
    };
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** Meta returns sender phone without `+`; we keep ours with `+` to match leads. */
function normalizeLeadingPlus(phone: string): string {
  return phone.startsWith('+') ? phone : `+${phone}`;
}

function stripLeadingPlus(phone: string): string {
  return phone.startsWith('+') ? phone.slice(1) : phone;
}
