'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ExternalLink, IdCard, Link2, Phone } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { conversationTitle } from '@/lib/whatsapp';
import type { WhatsAppConversation } from '@/lib/api-types';

import { CaptainBadge, HasOpenLeadBadge } from './badges';

/**
 * D1.2 — side panel placeholder.
 *
 * D1.4 will replace this with the full Contact + Lead side panel
 * (inline edit, follow-up actions, audit). For D1.2 we render the
 * lightweight read-only summary the page already has via the
 * `findConversationById` include — no extra fetches.
 *
 * Visible content:
 *   - Contact card: displayName / phone / language / flags
 *   - Linked Lead card: name / stage / "Open lead" link
 *   - "More details land in the next chunk" footnote
 *
 * NEVER renders rawProfile / originalPhone / originalDisplayName —
 * the safe projection from the backend already strips them.
 */
export function SidePanelPlaceholder({
  conversation,
}: {
  conversation: WhatsAppConversation;
}): JSX.Element {
  const t = useTranslations('admin.whatsapp.sidePanel');
  const contact = conversation.contact;
  const lead = conversation.lead;
  const title = conversationTitle(conversation);

  return (
    <aside className="flex h-full flex-col gap-3 overflow-y-auto border-s border-surface-border bg-surface p-4">
      {/* Contact card */}
      <section className="flex flex-col gap-2 rounded-lg border border-surface-border bg-surface-card p-3 shadow-sm">
        <header className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-tertiary">
            {t('contact.title')}
          </h3>
          <IdCard className="h-3.5 w-3.5 text-ink-tertiary" aria-hidden="true" />
        </header>
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium text-ink-primary">{title}</span>
          <span className="inline-flex items-center gap-1 font-mono text-xs text-ink-tertiary">
            <Phone className="h-3 w-3" aria-hidden="true" />
            {conversation.phone}
          </span>
          {contact?.language ? (
            <span className="text-xs text-ink-tertiary">
              {t('contact.language', { language: contact.language })}
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-1.5">
          <CaptainBadge visible={contact?.isCaptain ?? false} />
          <HasOpenLeadBadge
            visible={(contact?.hasOpenLead ?? false) && !(contact?.isCaptain ?? false)}
          />
        </div>
      </section>

      {/* Linked lead card */}
      <section className="flex flex-col gap-2 rounded-lg border border-surface-border bg-surface-card p-3 shadow-sm">
        <header className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-tertiary">
            {t('lead.title')}
          </h3>
          <Link2 className="h-3.5 w-3.5 text-ink-tertiary" aria-hidden="true" />
        </header>
        {lead ? (
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium text-ink-primary">{lead.name}</span>
            <div className="flex flex-wrap items-center gap-1.5">
              {lead.stage ? <Badge tone="info">{lead.stage.name}</Badge> : null}
              <Badge tone={lead.lifecycleState === 'won' ? 'healthy' : 'inactive'}>
                {t(`lead.lifecycle.${lead.lifecycleState}` as 'lead.lifecycle.open')}
              </Badge>
            </div>
            <Link
              href={`/admin/leads/${lead.id}`}
              className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-surface-border bg-surface-card px-3 text-xs font-medium text-ink-primary hover:border-brand-200 hover:bg-brand-50"
            >
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              {t('lead.openCta')}
            </Link>
          </div>
        ) : (
          <p className="text-xs text-ink-tertiary">{t('lead.notLinked')}</p>
        )}
      </section>

      <p className="text-[11px] text-ink-tertiary">{t('comingSoon')}</p>
    </aside>
  );
}
