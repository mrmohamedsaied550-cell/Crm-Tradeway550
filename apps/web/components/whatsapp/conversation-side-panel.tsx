'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { MessageSquareWarning } from 'lucide-react';

import { hasCapability } from '@/lib/auth';
import type { WhatsAppConversation } from '@/lib/api-types';

import { AddNoteModal } from './add-note-modal';
import { ContactAttemptsHint } from './contact-attempts-hint';
import { ContactCard } from './contact-card';
import { LeadCard } from './lead-card';
import { OwnershipCard } from './ownership-card';

/**
 * D1.4 — replaces SidePanelPlaceholder with the full operational
 * side panel.
 *
 * Three cards stack top-down (most contextual → most procedural):
 *   1. Contact      — who is this person; inline-edit cleaned identity
 *                     when the actor has whatsapp.contact.write.
 *   2. Linked lead  — pipeline stage / lifecycle / SLA / next action;
 *                     "Open lead" deep link; "Add note" if allowed;
 *                     "Link lead" empty state CTA when no lead is
 *                     attached and the actor has whatsapp.link.lead.
 *   3. Ownership    — current assignee + assignmentSource + status.
 *                     Conversation-vs-lead owner mismatch surfaces
 *                     on the LeadCard (more actionable next to the
 *                     "Open lead" CTA).
 *
 * The "Link lead" CTA delegates to the parent page via `onOpenLink`
 * so D1.3's existing `LinkLeadModal` is reused — no new modal.
 *
 * NEVER renders rawProfile / originalPhone / originalDisplayName.
 */
export function ConversationSidePanel({
  conversation,
  onOpenLink,
  onActionSuccess,
}: {
  conversation: WhatsAppConversation;
  /** Page-level handler that opens the existing D1.3 LinkLeadModal. */
  onOpenLink: () => void;
  /** Called after side-panel actions that may have mutated the lead
   *  or contact (e.g. "Add note"); the page re-fetches detail. */
  onActionSuccess: () => void;
}): JSX.Element {
  const t = useTranslations('admin.whatsapp.sidePanel');
  const [addNoteOpen, setAddNoteOpen] = useState<boolean>(false);

  const canEditContact = hasCapability('whatsapp.contact.write');
  const canLinkLead = hasCapability('whatsapp.link.lead');
  const canAddNote = hasCapability('lead.activity.write');
  // Sprint 14 (D14) — surface a deep link to the review queue when
  // the conversation has an unresolved review. Capability-gated so
  // operators without `whatsapp.review.read` never see the CTA.
  const canReadReviews = hasCapability('whatsapp.review.read');
  const showReviewCta =
    canReadReviews && conversation.review !== null && conversation.review?.resolvedAt === null;

  return (
    <aside
      className="flex h-full flex-col gap-3 overflow-y-auto border-s border-surface-border bg-surface p-4"
      aria-label={t('title')}
    >
      {showReviewCta ? (
        <Link
          href="/admin/whatsapp/reviews"
          className="flex items-start gap-2 rounded-md border border-status-warning/40 bg-status-warning/5 p-3 text-sm transition hover:bg-status-warning/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-status-warning/40"
        >
          <MessageSquareWarning
            className="mt-0.5 h-4 w-4 shrink-0 text-status-warning"
            aria-hidden="true"
          />
          <div className="flex flex-col gap-0.5">
            <span className="font-medium text-ink-primary">{t('reviewCta.title')}</span>
            <span className="text-xs text-ink-secondary">{t('reviewCta.body')}</span>
            <span className="mt-0.5 text-xs font-medium text-status-warning">
              {t('reviewCta.action')}
            </span>
          </div>
        </Link>
      ) : null}

      <ContactCard
        fallbackPhone={conversation.phone}
        initialContact={conversation.contact ?? null}
        contactId={conversation.contactId ?? null}
        canEdit={canEditContact}
      />

      <LeadCard
        conversation={conversation}
        canLinkLead={canLinkLead}
        onOpenLink={onOpenLink}
        onAddNote={() => setAddNoteOpen(true)}
        canAddNote={canAddNote && Boolean(conversation.leadId)}
      />

      {/* D2.5 — supplementary "N attempts on this contact" hint.
          Renders only when the linked lead has multi-attempt
          history; silent on first-attempt and out-of-scope cases. */}
      {conversation.leadId ? <ContactAttemptsHint leadId={conversation.leadId} /> : null}

      <OwnershipCard conversation={conversation} />

      {conversation.leadId ? (
        <AddNoteModal
          open={addNoteOpen}
          leadId={conversation.leadId}
          onClose={() => setAddNoteOpen(false)}
          onSuccess={() => {
            setAddNoteOpen(false);
            onActionSuccess();
          }}
        />
      ) : null}
    </aside>
  );
}
