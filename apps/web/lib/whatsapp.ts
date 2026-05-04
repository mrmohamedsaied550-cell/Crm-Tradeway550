/**
 * D1.2 — small utility module for the WhatsApp inbox.
 *
 * Co-locates the "rules of the operations inbox" so the rest of the
 * UI consumes them without sprinkling magic strings:
 *
 *   • assignmentSourceLabel — human-friendly translation of the
 *     denormalised provenance enum. Never expose the raw codes
 *     ('inbound_route', 'manual_handover', etc.) to operators.
 *
 *   • windowState — three-state model for Meta's 24-hour customer-
 *     service window: 'open' | 'closing_soon' | 'closed'. Drives
 *     the composer banner colour + freeform-vs-template gating.
 *
 *   • defaultFilterFor — the persona-aware default for the "Mine /
 *     All" toggle. Agents land on Mine; TL+/ops/admin land on All.
 *     Persisted in localStorage so individual preference sticks.
 *
 *   • timeAgo — relative timestamp formatter that keeps row labels
 *     short ("2m", "3h", "yesterday") and locale-aware.
 */

import type { AssignmentSource, WhatsAppConversation } from './api-types';

// ─── 24h window state ───────────────────────────────────────────────

export type WindowState = 'open' | 'closing_soon' | 'closed';

const HOUR = 60 * 60 * 1000;
const TWENTY_FOUR_HOURS = 24 * HOUR;
const TWO_HOURS = 2 * HOUR;

/**
 * Compute the current window state from the conversation's
 * `lastInboundAt`. Never replied or replied >24h ago → 'closed'
 * (template-only). Replied within the last 22h → 'open'. Last 2h
 * before expiry → 'closing_soon' so the UI can warn before the
 * agent is locked out mid-thread.
 */
export function windowState(
  conversation: WhatsAppConversation,
  now: number = Date.now(),
): WindowState {
  if (!conversation.lastInboundAt) return 'closed';
  const elapsed = now - new Date(conversation.lastInboundAt).getTime();
  if (elapsed >= TWENTY_FOUR_HOURS) return 'closed';
  if (elapsed >= TWENTY_FOUR_HOURS - TWO_HOURS) return 'closing_soon';
  return 'open';
}

/** Remaining ms inside the 24h window (negative when expired). */
export function windowRemainingMs(
  conversation: WhatsAppConversation,
  now: number = Date.now(),
): number {
  if (!conversation.lastInboundAt) return -1;
  const expiry = new Date(conversation.lastInboundAt).getTime() + TWENTY_FOUR_HOURS;
  return expiry - now;
}

/** Format remaining time as "14h 23m" / "47m". */
export function formatRemaining(ms: number): string {
  if (ms <= 0) return '0m';
  const h = Math.floor(ms / HOUR);
  const m = Math.floor((ms % HOUR) / (60 * 1000));
  if (h <= 0) return `${m}m`;
  return `${h}h ${m}m`;
}

// ─── Filter default heuristic ───────────────────────────────────────

export type InboxFilter = 'mine' | 'all';

const FILTER_STORAGE_KEY = 'whatsapp.inbox.filter.mine';

/**
 * Pick the right default filter for a given role code. TLs + admins
 * land on "All in scope" because their daily mental model is "where
 * is my team stuck". Everyone else (agents) lands on "Mine".
 *
 * The role.code lookup is intentionally string-prefix-tolerant
 * (`tl_sales` / `tl_activation` / `tl_driving` all share the `tl_`
 * prefix) so adding a new TL specialty doesn't require a code
 * change here.
 */
export function defaultFilterFor(roleCode: string | null | undefined): InboxFilter {
  if (!roleCode) return 'mine';
  if (roleCode === 'super_admin') return 'all';
  if (roleCode === 'ops_manager' || roleCode === 'account_manager') return 'all';
  if (roleCode.startsWith('tl_')) return 'all';
  return 'mine';
}

/**
 * Read the user's saved preference from localStorage; fall back to
 * the persona-aware default. SSR-safe (returns the default when no
 * `window`).
 */
export function readPreferredFilter(roleCode: string | null | undefined): InboxFilter {
  if (typeof window === 'undefined') return defaultFilterFor(roleCode);
  const stored = window.localStorage.getItem(FILTER_STORAGE_KEY);
  if (stored === 'mine' || stored === 'all') return stored;
  return defaultFilterFor(roleCode);
}

export function writePreferredFilter(filter: InboxFilter): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(FILTER_STORAGE_KEY, filter);
}

// ─── Assignment-source human labels ────────────────────────────────

/**
 * Stable list of all assignment-source codes the backend can emit.
 * The UI never renders these strings directly — it always pipes
 * through the i18n key `admin.whatsapp.assignmentSource.<code>`.
 * Keeping the list here makes the type exhaustive for switches.
 */
export const ASSIGNMENT_SOURCES: readonly AssignmentSource[] = [
  'inbound_route',
  'manual_handover',
  'outbound_self',
  'migrated',
  'lead_propagation',
] as const;

// ─── Time-ago ──────────────────────────────────────────────────────

const ONE_MIN = 60 * 1000;
const ONE_DAY = 24 * HOUR;

/**
 * Compact relative timestamp. Locale-agnostic at the wire level
 * (returns short suffixes the UI then maps via `t(...)`). The UI
 * can call this and prepend its own translated suffix if needed.
 */
export function timeAgo(
  iso: string,
  now: number = Date.now(),
): { value: number; unit: 'now' | 'm' | 'h' | 'd' } {
  const diff = Math.max(0, now - new Date(iso).getTime());
  if (diff < ONE_MIN) return { value: 0, unit: 'now' };
  if (diff < HOUR) return { value: Math.floor(diff / ONE_MIN), unit: 'm' };
  if (diff < ONE_DAY) return { value: Math.floor(diff / HOUR), unit: 'h' };
  return { value: Math.floor(diff / ONE_DAY), unit: 'd' };
}

// ─── Display name ──────────────────────────────────────────────────

/**
 * Conversation title — prefers the contact's curated displayName,
 * falls back to the raw phone. Never returns the rawProfile name —
 * `Contact.displayName` IS the cleaned identity.
 */
export function conversationTitle(conversation: WhatsAppConversation): string {
  return conversation.contact?.displayName ?? conversation.phone;
}

/**
 * Two-letter avatar initials. Falls back to the last two digits of
 * the phone when displayName is empty (matches WhatsApp's own
 * convention).
 */
export function conversationInitials(conversation: WhatsAppConversation): string {
  const title = conversationTitle(conversation);
  const fromName = title
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
  if (fromName.length > 0) return fromName;
  return conversation.phone.replace(/[^\d]/g, '').slice(-2);
}
