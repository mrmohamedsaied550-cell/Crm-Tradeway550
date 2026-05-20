'use client';

import { Activity, Clock, Megaphone, ShieldCheck } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import type {
  AttributionPayload,
  LeadActivity,
  LeadActivityType,
  SlaStatus,
} from '@/lib/api-types';
import { cn } from '@/lib/utils';

/**
 * Phase B — B1: secondary cards on the lead-detail right panel.
 * Redesigned to match the mockup: left border accents with warmer colors.
 */

function slaTone(s: SlaStatus): 'healthy' | 'warning' | 'breach' | 'inactive' {
  if (s === 'breached') return 'breach';
  if (s === 'paused') return 'inactive';
  return 'healthy';
}

interface SlaCardProps {
  status: SlaStatus;
  dueRelative: string | null;
  label: string;
  dueLabel: string;
}

export function SlaCard({ status, dueRelative, label, dueLabel }: SlaCardProps): JSX.Element {
  const borderColor =
    status === 'breached'
      ? 'border-l-red-400'
      : status === 'paused'
        ? 'border-l-gray-400'
        : 'border-l-green-400';

  return (
    <section className={cn('rounded-lg border border-l-4 bg-white p-4 shadow-sm transition-shadow hover:shadow-md', borderColor)}>
      <header className="mb-2 flex items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-brand-700" aria-hidden="true" />
        <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-tertiary">{label}</h3>
      </header>
      <div className="flex items-center gap-2">
        <Badge tone={slaTone(status)}>{status}</Badge>
        {dueRelative ? (
          <span className="text-xs text-ink-secondary">
            {dueLabel} {dueRelative}
          </span>
        ) : null}
      </div>
    </section>
  );
}

interface LastActivityCardProps {
  activity: LeadActivity | null;
  relativeTime: string | null;
  authorLabel: string;
  summary: string | null;
  label: string;
  emptyLabel: string;
  typeLabel: (t: LeadActivityType) => string;
}

export function LastActivityCard({
  activity,
  relativeTime,
  authorLabel,
  summary,
  label,
  emptyLabel,
  typeLabel,
}: LastActivityCardProps): JSX.Element {
  return (
    <section className="rounded-lg border border-l-4 border-l-amber-400 bg-white p-4 shadow-sm transition-shadow hover:shadow-md">
      <header className="mb-2 flex items-center gap-2">
        <Activity className="h-4 w-4 text-amber-600" aria-hidden="true" />
        <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-tertiary">{label}</h3>
      </header>
      {!activity ? (
        <p className="text-sm text-ink-tertiary">{emptyLabel}</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-ink-primary">{typeLabel(activity.type)}</span>
            {relativeTime ? (
              <span
                className="inline-flex items-center gap-1 text-[11px] text-ink-tertiary"
                title={new Date(activity.createdAt).toLocaleString()}
              >
                <Clock className="h-3 w-3" aria-hidden="true" />
                {relativeTime}
              </span>
            ) : null}
          </div>
          {summary ? <p className="text-sm text-ink-primary">{summary}</p> : null}
          {activity.body && (activity.type === 'note' || activity.type === 'call') ? (
            <p className="line-clamp-3 text-sm text-ink-primary">{activity.body}</p>
          ) : null}
          <p className="text-[11px] text-ink-tertiary">{authorLabel}</p>
        </div>
      )}
    </section>
  );
}

interface AttributionCardProps {
  attribution: AttributionPayload | null;
  fallbackSource: string;
  label: string;
  emptyLabel: string;
}

export function AttributionCard({
  attribution,
  fallbackSource,
  label,
  emptyLabel,
}: AttributionCardProps): JSX.Element {
  const rows: Array<{ key: string; value: string }> = [];
  const a = attribution;
  if (a?.source) rows.push({ key: 'source', value: a.source });
  else if (fallbackSource) rows.push({ key: 'source', value: fallbackSource });
  if (a?.subSource) rows.push({ key: 'subSource', value: a.subSource });
  if (a?.campaign?.name || a?.campaign?.id)
    rows.push({ key: 'campaign', value: a.campaign?.name || a.campaign?.id || '' });
  if (a?.adSet?.name || a?.adSet?.id)
    rows.push({ key: 'adSet', value: a.adSet?.name || a.adSet?.id || '' });
  if (a?.ad?.name || a?.ad?.id) rows.push({ key: 'ad', value: a.ad?.name || a.ad?.id || '' });
  if (a?.utm?.source) rows.push({ key: 'utm.source', value: a.utm.source });
  if (a?.utm?.medium) rows.push({ key: 'utm.medium', value: a.utm.medium });
  if (a?.utm?.campaign) rows.push({ key: 'utm.campaign', value: a.utm.campaign });

  return (
    <section className="rounded-lg border border-l-4 border-l-blue-400 bg-white p-4 shadow-sm transition-shadow hover:shadow-md">
      <header className="mb-2 flex items-center gap-2">
        <Megaphone className="h-4 w-4 text-blue-600" aria-hidden="true" />
        <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-tertiary">{label}</h3>
      </header>
      {rows.length === 0 ? (
        <p className="text-sm text-ink-tertiary">{emptyLabel}</p>
      ) : (
        <dl className="flex flex-col gap-1">
          {rows.map((r) => (
            <div key={r.key} className="flex items-baseline justify-between gap-3 text-xs">
              <dt className="font-medium uppercase tracking-wide text-ink-tertiary">{r.key}</dt>
              <dd
                className={cn(
                  'truncate text-ink-primary',
                  r.key === 'source' || r.key === 'subSource' ? 'font-medium' : '',
                )}
                title={r.value}
              >
                {r.value}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
