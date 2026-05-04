'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ExternalLink, Phone } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { ApiError, leadsApi } from '@/lib/api';
import type { Lead } from '@/lib/api-types';
import { cn } from '@/lib/utils';

/**
 * D1.5 — candidate-lead mini-card used inside ReviewCard.
 *
 * Lazily fetches the lead via GET /leads/:id when the candidate is
 * inside the actor's scope. Out-of-scope (RLS hides the row) renders
 * the safe "not in your scope" copy instead of a technical 404.
 *
 * The card is interactive: clicking the body triggers `onSelect`,
 * which the parent uses to seed the resolve modal with this lead's
 * id. The "Open" link still navigates to the full lead detail.
 */
export function ReviewCandidateLead({
  leadId,
  selected,
  onSelect,
  selectable,
}: {
  leadId: string;
  selected: boolean;
  onSelect: () => void;
  /** True when the actor has whatsapp.review.resolve and a "Link to
   *  this lead" pick is meaningful. Read-only mode passes false so
   *  the body is non-interactive. */
  selectable: boolean;
}): JSX.Element {
  const t = useTranslations('admin.whatsappReviews.candidate.lead');
  const [lead, setLead] = useState<Lead | null>(null);
  const [error, setError] = useState<'out_of_scope' | 'failed' | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    leadsApi
      .get(leadId)
      .then((row) => {
        if (cancelled) return;
        setLead(row);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) {
          setError('out_of_scope');
        } else {
          setError('failed');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [leadId]);

  const Wrapper: React.ElementType = selectable ? 'button' : 'div';

  return (
    <Wrapper
      type={selectable ? 'button' : undefined}
      onClick={selectable ? onSelect : undefined}
      aria-pressed={selectable ? selected : undefined}
      className={cn(
        'flex w-full flex-col gap-1 rounded-md border px-3 py-2 text-start transition-colors',
        selectable
          ? 'cursor-pointer hover:bg-brand-50/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600'
          : 'cursor-default',
        selected ? 'border-brand-600 bg-brand-50/60' : 'border-surface-border bg-surface-card',
      )}
    >
      {loading ? (
        <p className="text-xs text-ink-tertiary">{t('loading')}</p>
      ) : error === 'out_of_scope' ? (
        <p className="text-xs italic text-ink-tertiary">{t('outOfScope')}</p>
      ) : error === 'failed' ? (
        <p className="text-xs text-status-breach">{t('loadFailed')}</p>
      ) : lead ? (
        <>
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-medium text-ink-primary">{lead.name}</span>
            <Link
              href={`/admin/leads/${lead.id}`}
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-1 text-[11px] text-ink-secondary hover:text-brand-700"
            >
              <ExternalLink className="h-3 w-3" aria-hidden="true" />
              {t('openCta')}
            </Link>
          </div>
          <span className="inline-flex items-center gap-1 font-mono text-[11px] text-ink-tertiary">
            <Phone className="h-3 w-3" aria-hidden="true" />
            {lead.phone}
          </span>
          <div className="flex flex-wrap items-center gap-1.5">
            {lead.stage ? <Badge tone="info">{lead.stage.name}</Badge> : null}
            <Badge tone={lifecycleTone(lead.lifecycleState)}>
              {t(`lifecycle.${lead.lifecycleState}` as 'lifecycle.open')}
            </Badge>
          </div>
        </>
      ) : null}
    </Wrapper>
  );
}

function lifecycleTone(state: string): 'healthy' | 'breach' | 'inactive' | 'info' {
  if (state === 'won') return 'healthy';
  if (state === 'lost') return 'breach';
  if (state === 'archived') return 'inactive';
  return 'info';
}
