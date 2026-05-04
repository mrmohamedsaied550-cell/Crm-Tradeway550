'use client';

import { useTranslations } from 'next-intl';
import { ArrowRightLeft, Bot, History, Link2, ShieldCheck, User } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import type { AssignmentSource, WhatsAppConversation } from '@/lib/api-types';

/**
 * D1.2 — small badge components shared by the conversation list,
 * the thread header, and (later) the side panel.
 *
 * The product rule: NEVER render a raw enum code. Every badge that
 * surfaces `assignmentSource` / `status` / contact flags goes
 * through the i18n table so the user sees plain language and the
 * Arabic translation is operational, not literal.
 */

const SOURCE_ICON: Record<AssignmentSource, typeof ArrowRightLeft> = {
  inbound_route: Bot,
  manual_handover: ArrowRightLeft,
  outbound_self: User,
  migrated: History,
  lead_propagation: Link2,
};

const SOURCE_TONE: Record<AssignmentSource, 'info' | 'inactive' | 'healthy' | 'warning'> = {
  inbound_route: 'healthy',
  manual_handover: 'info',
  outbound_self: 'info',
  migrated: 'inactive',
  lead_propagation: 'warning',
};

/**
 * Renders the conversation's ownership provenance with a human
 * label and an icon hint. Hidden when no source set.
 */
export function AssignmentSourceBadge({
  source,
}: {
  source: AssignmentSource | null | undefined;
}): JSX.Element | null {
  const t = useTranslations('admin.whatsapp.assignmentSource');
  if (!source) return null;
  const Icon = SOURCE_ICON[source] ?? ArrowRightLeft;
  return (
    <Badge tone={SOURCE_TONE[source] ?? 'info'}>
      <Icon className="me-1 inline h-3 w-3" aria-hidden="true" />
      {t(source as 'inbound_route')}
    </Badge>
  );
}

/**
 * Renders the assigned agent's name, never the raw user id. When
 * unassigned, surfaces a clear "Unassigned" badge instead so the
 * absence is explicit rather than implied.
 */
export function OwnerBadge({
  conversation,
  showUnassigned = true,
}: {
  conversation: WhatsAppConversation;
  /** When false, returns null on unassigned (used in dense list rows). */
  showUnassigned?: boolean;
}): JSX.Element | null {
  const t = useTranslations('admin.whatsapp.owner');
  if (!conversation.assignedToId) {
    if (!showUnassigned) return null;
    return (
      <Badge tone="warning">
        <User className="me-1 inline h-3 w-3" aria-hidden="true" />
        {t('unassigned')}
      </Badge>
    );
  }
  // Fall back to a localised "Unknown owner" rather than the raw uuid
  // when the embedded user object is missing — happens only when the
  // backend `include` is bypassed for some reason.
  const name = conversation.assignedTo?.name ?? t('unknownOwner');
  return (
    <span title={name} className="inline-flex">
      <Badge tone="info">
        <User className="me-1 inline h-3 w-3" aria-hidden="true" />
        <span className="max-w-[10ch] truncate">{name}</span>
      </Badge>
    </span>
  );
}

/**
 * Captain flag — only shown when the contact is a known active
 * captain. Visual weight matches the operational priority: ops
 * needs to spot a captain reaching out fast.
 */
export function CaptainBadge({ visible }: { visible: boolean }): JSX.Element | null {
  const t = useTranslations('admin.whatsapp.contact');
  if (!visible) return null;
  return (
    <Badge tone="warning">
      <ShieldCheck className="me-1 inline h-3 w-3" aria-hidden="true" />
      {t('isCaptain')}
    </Badge>
  );
}

/**
 * Linked-lead flag — quick visual cue when the conversation already
 * has a lead attached (vs. orphan conversations awaiting routing).
 */
export function HasOpenLeadBadge({ visible }: { visible: boolean }): JSX.Element | null {
  const t = useTranslations('admin.whatsapp.contact');
  if (!visible) return null;
  return (
    <Badge tone="info">
      <Link2 className="me-1 inline h-3 w-3" aria-hidden="true" />
      {t('hasOpenLead')}
    </Badge>
  );
}

/**
 * Status pill — Open / Closed. Closed is rendered with the inactive
 * tone so closed threads recede in the list.
 */
export function StatusBadge({ status }: { status: 'open' | 'closed' }): JSX.Element {
  const t = useTranslations('admin.whatsapp.status');
  return <Badge tone={status === 'open' ? 'healthy' : 'inactive'}>{t(status)}</Badge>;
}
