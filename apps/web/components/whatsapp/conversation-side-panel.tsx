'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { hasCapability } from '@/lib/auth';
import type { WhatsAppConversation } from '@/lib/api-types';

import { AddNoteModal } from './add-note-modal';
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

  return (
    <aside
      className="flex h-full flex-col gap-3 overflow-y-auto border-s border-surface-border bg-surface p-4"
      aria-label={t('title')}
    >
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
