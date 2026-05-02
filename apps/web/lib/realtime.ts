/**
 * P3-02 — client-side realtime channel.
 *
 * Wraps `EventSource` with:
 *   - JWT-via-query-param auth (EventSource can't set headers).
 *   - Auto-reconnect with bounded exponential backoff (the browser's
 *     own auto-reconnect drops on a 401, so we own it).
 *   - A single shared connection per page (a tab opens one stream;
 *     multiple subscribers fan out from there).
 *   - Type-safe event typing — same discriminated union as the API.
 *
 * The hook (`useRealtime`) is intentionally tolerant: every subscriber
 * also keeps its existing polling fallback. Realtime is a latency
 * optimisation, not a correctness requirement — if the SSE channel
 * never connects (firewall, broken proxy, missing token), the UI still
 * works on its poll cadence.
 */
import { useEffect, useRef } from 'react';

import { API_BASE_URL } from './api-base';
import { getAccessToken } from './auth';

export type RealtimeEvent =
  | {
      type: 'notification.created';
      notificationId: string;
      recipientUserId: string;
      kind: string;
    }
  | {
      type: 'whatsapp.message';
      conversationId: string;
      messageId: string;
      direction: 'inbound' | 'outbound';
    }
  | {
      type: 'lead.assigned';
      leadId: string;
      toUserId: string;
      fromUserId: string | null;
      reason: 'manual' | 'auto' | 'sla_breach';
    };

export type RealtimeEventType = RealtimeEvent['type'];

/** Narrow the union to the event variant whose `type` matches T. */
export type RealtimeEventOf<T extends RealtimeEventType> = Extract<RealtimeEvent, { type: T }>;

type Listener = (event: RealtimeEvent) => void;

interface Channel {
  source: EventSource | null;
  /** Subscribers per event type. */
  listeners: Map<RealtimeEventType, Set<Listener>>;
  /** Tracks reconnect attempts for backoff. */
  attempts: number;
  closed: boolean;
  /** Pending reconnect timer so we can cancel on close. */
  reconnectTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * One channel per page. Subscribing to N event types still uses one
 * underlying EventSource.
 */
let channel: Channel | null = null;

const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;

function streamUrl(token: string): string {
  // The /realtime/stream route is mounted outside the /api/v1 prefix
  // on the API side so the SW shell-cache rules can match it cleanly.
  const base = API_BASE_URL.replace(/\/$/, '');
  return `${base}/realtime/stream?token=${encodeURIComponent(token)}`;
}

function ensureChannel(): Channel {
  if (channel) return channel;
  channel = {
    source: null,
    listeners: new Map(),
    attempts: 0,
    closed: false,
    reconnectTimer: null,
  };
  connect(channel);
  return channel;
}

function connect(c: Channel): void {
  if (c.closed) return;
  if (typeof window === 'undefined' || typeof EventSource === 'undefined') return;
  const token = getAccessToken();
  if (!token) {
    // No token yet — try again shortly, the user is probably logging in.
    scheduleReconnect(c);
    return;
  }

  const src = new EventSource(streamUrl(token));
  c.source = src;

  src.onopen = () => {
    c.attempts = 0;
  };

  src.onmessage = (msg) => {
    try {
      const event = JSON.parse(msg.data) as RealtimeEvent;
      dispatch(c, event);
    } catch {
      // Malformed payload — ignore. The server only emits JSON, so a
      // parse failure means a proxy mangled the line.
    }
  };

  src.onerror = () => {
    // EventSource auto-reconnects on transport errors UNLESS the
    // server returned a 401 (closed permanently). We close + reopen
    // ourselves so a token rotation between the disconnect and the
    // reconnect picks up the new token automatically.
    src.close();
    c.source = null;
    if (!c.closed) scheduleReconnect(c);
  };
}

function scheduleReconnect(c: Channel): void {
  if (c.closed || c.reconnectTimer) return;
  const delay = Math.min(RECONNECT_BASE_MS * 2 ** c.attempts, RECONNECT_MAX_MS);
  c.attempts += 1;
  c.reconnectTimer = setTimeout(() => {
    c.reconnectTimer = null;
    connect(c);
  }, delay);
}

function dispatch(c: Channel, event: RealtimeEvent): void {
  const listeners = c.listeners.get(event.type);
  if (!listeners) return;
  for (const fn of listeners) {
    try {
      fn(event);
    } catch {
      // A throwing subscriber must not stop delivery to peers.
    }
  }
}

/**
 * Subscribe to a single realtime event type. Returns an unsubscribe
 * function. Safe to call from inside a React effect — multiple
 * subscribers across components share the same underlying connection.
 *
 * Generic so the listener signature is narrowed to the matching
 * union variant (e.g. subscribing to `lead.assigned` gives the
 * listener `RealtimeLeadAssigned`, not the broad union).
 */
export function subscribeRealtime<T extends RealtimeEventType>(
  type: T,
  listener: (event: RealtimeEventOf<T>) => void,
): () => void {
  const c = ensureChannel();
  let bucket = c.listeners.get(type);
  if (!bucket) {
    bucket = new Set();
    c.listeners.set(type, bucket);
  }
  // The bucket holds the broad listener; we widen at the boundary
  // here. Dispatch only ever invokes us with an event whose `type`
  // matches `type`, so the cast is sound.
  const widened: Listener = (event) => listener(event as RealtimeEventOf<T>);
  bucket.add(widened);
  return () => {
    bucket!.delete(widened);
    if (bucket!.size === 0) c.listeners.delete(type);
  };
}

/**
 * React hook that registers a listener for the lifetime of the
 * component. The handler ref is updated on every render so callers
 * don't have to memoise theirs.
 */
export function useRealtime<T extends RealtimeEventType>(
  type: T,
  handler: (event: RealtimeEventOf<T>) => void,
): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const off = subscribeRealtime<T>(type, (event) => ref.current(event));
    return off;
  }, [type]);
}

/**
 * Tear down the shared channel — used when the user signs out so
 * subsequent reconnects pick up the next user's token instead of
 * trying to reuse the now-invalid one.
 */
export function closeRealtime(): void {
  if (!channel) return;
  channel.closed = true;
  if (channel.reconnectTimer) clearTimeout(channel.reconnectTimer);
  channel.source?.close();
  channel = null;
}
