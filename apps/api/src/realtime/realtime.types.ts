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
  fromUserId: string | null;
  /** sla_breach reassignments use this so clients can show a banner. */
  reason: 'manual' | 'auto' | 'sla_breach';
}

/** Discriminated union — clients switch on `type`. */
export type RealtimeEvent =
  | RealtimeNotificationCreated
  | RealtimeWhatsAppMessage
  | RealtimeLeadAssigned;
