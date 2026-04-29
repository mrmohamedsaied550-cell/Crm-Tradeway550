/**
 * WhatsApp provider abstraction.
 *
 * The CRM speaks to one provider implementation per WhatsAppAccount; the
 * MVP ships `meta_cloud` (Meta's WhatsApp Business Cloud API). The
 * interface keeps the rest of the system provider-agnostic so adding a
 * BSP partner (360dialog, Gupshup, …) later is just a new implementation
 * + a new `provider` value on the account row.
 *
 * The interface intentionally stays small:
 *   - `verifyWebhook` covers the GET-handshake every provider does.
 *   - `verifySignature` covers the POST-body HMAC check.
 *   - `parseInbound` normalises the provider's wire format into our
 *     `InboundMessage` shape.
 *   - `sendText` covers outbound. Media + templates land in a later
 *     chunk; today's surface is plain text only.
 */

/**
 * Connection details handed to provider operations. We pass the access
 * token + phone-number-id explicitly rather than coupling the provider
 * to our Prisma model so unit tests can construct a minimal config.
 */
export interface WhatsAppAccountConfig {
  readonly accessToken: string;
  readonly phoneNumberId: string;
  readonly appSecret: string | null;
  readonly verifyToken: string;
}

/**
 * One inbound message as parsed from a webhook payload. Statuses and
 * delivery receipts are intentionally not modeled in C21 — we only
 * persist user-authored inbound messages.
 */
export interface InboundMessage {
  /** Other party's E.164 phone number (digits only, no formatting). */
  readonly phone: string;
  /** Plain-text body. */
  readonly text: string;
  /** Provider-assigned message id. Used for idempotent persistence. */
  readonly providerMessageId: string;
  /**
   * UTC timestamp the provider stamped on the message. Falls back to
   * "now" when the provider didn't include it.
   */
  readonly receivedAt: Date;
  /**
   * The Meta phone-number-id the message was delivered to — lets the
   * webhook router map back to the account/tenant without parsing the
   * payload twice.
   */
  readonly phoneNumberId: string;
}

/** Result of `WhatsAppProvider.sendText`. */
export interface OutboundResult {
  readonly providerMessageId: string;
}

export interface WhatsAppProvider {
  /**
   * Reply to the GET-handshake the provider sends when registering the
   * webhook. Returns the verification challenge string when the request
   * is valid, `null` otherwise. Implementations check `hub.mode`,
   * `hub.verify_token`, and pull `hub.challenge` from the query.
   */
  verifyWebhook(
    query: Record<string, string | undefined>,
    expectedVerifyToken: string,
  ): string | null;

  /**
   * Verify the POST body's HMAC signature. Returns true only when the
   * provider's signature matches the expected HMAC of the raw body using
   * the configured app secret. When no secret is configured (test/dev),
   * implementations return true.
   */
  verifySignature(
    rawBody: string,
    signatureHeader: string | undefined,
    appSecret: string | null,
  ): boolean;

  /**
   * Parse the inbound webhook payload into zero or more InboundMessage
   * rows. Statuses, errors, and other event types are filtered out.
   */
  parseInbound(body: unknown): readonly InboundMessage[];

  /**
   * Send a plain-text message via the provider. Returns the
   * provider-assigned message id.
   */
  sendText(input: {
    config: WhatsAppAccountConfig;
    to: string;
    text: string;
  }): Promise<OutboundResult>;
}
