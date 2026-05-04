'use client';

import { useTranslations } from 'next-intl';
import { Briefcase, UserCircle2 } from 'lucide-react';

import type { WhatsAppConversation } from '@/lib/api-types';

import { AssignmentSourceBadge, OwnerBadge, StatusBadge } from './badges';

/**
 * D1.4 — Conversation ownership card.
 *
 * The TL/ops audience cares about: who owns this conversation right
 * now, how did they end up owning it (assignmentSource), is it
 * still open, and when was it assigned. Each row pairs a label
 * with either a badge or a relative time string — no raw IDs,
 * never the actor user-id alone.
 *
 * The conversation-vs-lead owner-mismatch warning lives on the
 * LeadCard, not here, because the warning is most actionable in
 * the context of the linked-lead block (open lead → fix).
 */
export function OwnershipCard({
  conversation,
}: {
  conversation: WhatsAppConversation;
}): JSX.Element {
  const t = useTranslations('admin.whatsapp.sidePanel.ownership');
  const assignedAt = conversation.assignedAt ?? null;

  return (
    <section className="flex flex-col gap-2 rounded-lg border border-surface-border bg-surface-card p-3 shadow-sm">
      <header className="flex items-center justify-between gap-2">
        <h3 className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-tertiary">
          <Briefcase className="h-3.5 w-3.5" aria-hidden="true" />
          {t('title')}
        </h3>
      </header>

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-xs">
        <dt className="text-ink-tertiary">{t('owner')}</dt>
        <dd className="flex items-center gap-1.5 text-ink-primary">
          <UserCircle2 className="h-3.5 w-3.5 text-ink-tertiary" aria-hidden="true" />
          <OwnerBadge conversation={conversation} />
        </dd>

        <dt className="text-ink-tertiary">{t('source')}</dt>
        <dd>
          <AssignmentSourceBadge source={conversation.assignmentSource} />
        </dd>

        <dt className="text-ink-tertiary">{t('status')}</dt>
        <dd>
          <StatusBadge status={conversation.status} />
        </dd>

        {assignedAt ? (
          <>
            <dt className="text-ink-tertiary">{t('assignedAt')}</dt>
            <dd className="text-ink-primary">{formatDate(assignedAt)}</dd>
          </>
        ) : null}
      </dl>
    </section>
  );
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}
