import { redirect } from 'next/navigation';

/**
 * D1.2 — `/agent/inbox` was the agent-only WhatsApp inbox during
 * P2-12 / PL-1. The C10B-4 ownership rewrite unified it with the
 * admin inbox at `/admin/whatsapp`; the destination is the same
 * page for every persona, scope-filtered by the backend.
 *
 * Redirects are server-rendered so existing bookmarks resolve in
 * one hop without a client-side flash. The `agent.inbox` i18n
 * namespace stays in place — D1.6 will dedupe its strings into
 * `admin.whatsapp.*` after Phase D2/D3 land.
 */
export default function AgentInboxRedirectPage(): never {
  redirect('/admin/whatsapp');
}
