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

/** Result of `WhatsAppProvider.sendText` (and sendTemplate / sendMedia). */
export interface OutboundResult {
  readonly providerMessageId: string;
}

/**
 * P2-12 — values for a Meta-approved template's positional
 * placeholders (`{{1}}`, `{{2}}`, ...). The array length must
 * match the template's `variableCount`; the service rejects
 * mismatches before calling the provider.
 */
export type TemplateVariables = readonly string[];

export type WhatsAppMediaKind = 'image' | 'document';

/** Result of `WhatsAppProvider.testConnection`. */
export interface ConnectionTestResult {
  readonly ok: boolean;
  /** Human-readable status — surfaced to the admin UI. */
  readonly message: string;
  /** Provider-confirmed display number, when the API returned it. */
  readonly displayPhoneNumber?: string;
  /** Provider-confirmed business name, when the API returned it. */
  readonly verifiedName?: string;
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
    /**
     * C27 — when `true`, reject any payload whose account has no
     * appSecret configured. The webhook controller passes
     * `requireSigned = isProduction()`.
     */
    requireSigned?: boolean,
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

  /**
   * P2-12 — send a Meta-approved template by name. The provider
   * is responsible for filling positional placeholders from the
   * `variables` array. `language` is a BCP-47 code (e.g. "en",
   * "ar", "en_US").
   */
  sendTemplate(input: {
    config: WhatsAppAccountConfig;
    to: string;
    templateName: string;
    language: string;
    variables: TemplateVariables;
  }): Promise<OutboundResult>;

  /**
   * P2-12 — send an image or document by URL. The provider
   * downloads the file from `mediaUrl` and forwards it to Meta.
   * Optional `caption` is shown under the media in the chat.
   */
  sendMedia(input: {
    config: WhatsAppAccountConfig;
    to: string;
    kind: WhatsAppMediaKind;
    mediaUrl: string;
    caption?: string;
  }): Promise<OutboundResult>;

  /**
   * Lightweight liveness check — used by the admin "Test connection"
   * button to verify that the access token + phone-number-id pair is
   * accepted by the provider. Implementations MUST NOT mutate state on
   * the provider side. Errors are reported via `ok: false` rather than
   * throwing, so the UI can render a friendly message in either branch.
   */
  testConnection(input: { config: WhatsAppAccountConfig }): Promise<ConnectionTestResult>;
}
