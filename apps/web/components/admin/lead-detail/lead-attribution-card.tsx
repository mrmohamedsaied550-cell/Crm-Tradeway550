'use client';

import { Megaphone, Target, Sparkles } from 'lucide-react';

import type { Lead } from '@/lib/api-types';

/**
 * Sprint M2 / Phase 3 — Meta attribution card for the Lead Detail
 * sidebar. Renders the six flat columns persisted at ingest time by
 * the OAuth-driven webhook path:
 *
 *   - metaCampaignName  (id: metaCampaignId)  → Megaphone
 *   - metaAdsetName     (id: metaAdsetId)     → Target
 *   - metaAdName        (id: metaAdId)        → Sparkles
 *
 * Returns `null` when none of the six columns are populated so the
 * sidebar stays compact for non-Meta leads and for legacy Meta leads
 * that arrived via the inline-payload path (no OAuth connection →
 * names weren't fetched from Graph).
 *
 * The existing `AttributionCard` continues to render the JSON
 * `attribution` payload (with source / utm / etc.) so this card is
 * additive — both can show at once when both shapes carry data.
 */
export interface LeadAttributionCardProps {
  lead: Pick<
    Lead,
    | 'metaCampaignId'
    | 'metaCampaignName'
    | 'metaAdsetId'
    | 'metaAdsetName'
    | 'metaAdId'
    | 'metaAdName'
  >;
  label: string;
  labels: {
    campaign: string;
    adSet: string;
    ad: string;
    idLabel: string;
  };
}

interface Row {
  key: 'campaign' | 'adSet' | 'ad';
  icon: typeof Megaphone;
  label: string;
  name: string;
  id: string;
}

export function LeadAttributionCard({
  lead,
  label,
  labels,
}: LeadAttributionCardProps): JSX.Element | null {
  const rows: Row[] = [];
  if (lead.metaCampaignName || lead.metaCampaignId) {
    rows.push({
      key: 'campaign',
      icon: Megaphone,
      label: labels.campaign,
      name: lead.metaCampaignName ?? '',
      id: lead.metaCampaignId ?? '',
    });
  }
  if (lead.metaAdsetName || lead.metaAdsetId) {
    rows.push({
      key: 'adSet',
      icon: Target,
      label: labels.adSet,
      name: lead.metaAdsetName ?? '',
      id: lead.metaAdsetId ?? '',
    });
  }
  if (lead.metaAdName || lead.metaAdId) {
    rows.push({
      key: 'ad',
      icon: Sparkles,
      label: labels.ad,
      name: lead.metaAdName ?? '',
      id: lead.metaAdId ?? '',
    });
  }

  if (rows.length === 0) return null;

  return (
    <section className="rounded-lg border border-surface-border bg-surface-card p-4 shadow-card">
      <header className="mb-3 flex items-center gap-2">
        <Megaphone className="h-4 w-4 text-brand-700" aria-hidden="true" />
        <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-tertiary">{label}</h3>
      </header>
      <ul className="flex flex-col gap-3">
        {rows.map((r) => {
          const Icon = r.icon;
          return (
            <li key={r.key} className="flex items-start gap-3">
              <Icon className="mt-0.5 h-4 w-4 flex-shrink-0 text-ink-tertiary" aria-hidden="true" />
              <div className="flex min-w-0 flex-col leading-tight">
                <span className="text-[11px] font-medium uppercase tracking-wide text-ink-tertiary">
                  {r.label}
                </span>
                {r.name ? (
                  <span className="truncate text-sm font-medium text-ink-primary" title={r.name}>
                    {r.name}
                  </span>
                ) : null}
                {r.id ? (
                  <span className="truncate font-mono text-[11px] text-ink-tertiary" title={r.id}>
                    {labels.idLabel}: {r.id}
                  </span>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
