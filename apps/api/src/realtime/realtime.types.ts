/**
 * P3-02 — realtime event envelopes.
 *
 * Every event is tenant-scoped. Most events are also user-targeted
 * (notifications + lead assignments arrive for a specific recipient);
 * a few are tenant-broadcast (whatsapp inbound — any agent watching
 * the inbox should see the conversation row update live).
 *
 * The `data` payload is intentionally minimal — clients use it as a
 * cache-invalidation hint and re-fetch the canonical record over
 * REST. That keeps the event envelope small enough to write straight
 * to the wire without sweat about leaking row data the client isn't
 * authorised to see.
 *
 * Phase D5 — D5.13 hardening:
 *   The realtime channel is a NOTIFICATION channel, not a data
 *   channel. Sensitive identifiers that the REST surface gates via
 *   field permissions (previous-owner identity in particular) are
 *   NEVER carried on realtime events. Clients re-fetch the
 *   canonical record via the (already-redacted) REST endpoints
 *   when they need the identity. See `RealtimeLeadAssigned.fromUserId`
 *   below — typed as `null` so a future emitter trying to set it
 *   surfaces at compile time.
 */

export interface RealtimeNotificationCreated {
  type: 'notification.created';
  notificationId: string;
  recipientUserId: string;
  kind: string;
}

export interface RealtimeWhatsAppMessage {
  type: 'whatsapp.message';
  conversationId: string;
  messageId: string;
  direction: 'inbound' | 'outbound';
}

export interface RealtimeLeadAssigned {
  type: 'lead.assigned';
  leadId: string;
  toUserId: string;
  /**
   * Phase D5 — D5.13: ALWAYS `null` on realtime events. The
   * previous-owner identity is gated by `lead.previousOwner` /
   * `rotation.fromUser` field permissions on the REST surface
   * (see D5.7 + D5.12-B). Clients receive this notification as a
   * cache-invalidation hint and re-fetch via the (already-redacted)
   * `/leads/:id` / `/leads/:id/rotations` endpoints to render the
   * correct view for the recipient's role.
   *
   * Typed as the literal `null` so a future emitter cannot
   * accidentally re-introduce a previous-owner leak via the
   * realtime channel.
   */
  fromUserId: null;
  /** sla_breach reassignments use this so clients can show a banner. */
  reason: 'manual' | 'auto' | 'sla_breach';
}

/** Discriminated union — clients switch on `type`. */
export type RealtimeEvent =
  | RealtimeNotificationCreated
  | RealtimeWhatsAppMessage
  | RealtimeLeadAssigned;
