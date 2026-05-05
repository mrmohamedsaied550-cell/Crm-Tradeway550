'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { AlertOctagon, ArrowRightLeft, ClipboardCheck, Phone } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import type { NeedsAttentionResponse } from '@/lib/api-types';

/**
 * Phase D3 — D3.7: agent-workspace "Needs attention now" panel.
 *
 * Three compact lists (rotated-to-me / SLA at risk / open reviews)
 * that share a single read endpoint. Designed to be operational, not
 * forensic:
 *
 *   • NEVER shows previous-owner / actor names.
 *   • NEVER shows blame metadata (rotation reason, SLA breach
 *     attempt index, etc.). Those live on /admin/audit and the lead
 *     detail timeline for TLs/Ops who need them.
 *   • Each row links to the lead detail; that's the agent's next
 *     step.
 *   • Empty all three lists → renders the friendly empty state.
 *   • Mobile: rows stack via flex-wrap; tap targets stay ≥ 44 px.
 */
export function NeedsAttentionSection({
  data,
}: {
  data: NeedsAttentionResponse | null;
}): JSX.Element | null {
  const t = useTranslations('agent.needsAttention');

  if (!data) return null;

  const { rotatedToMe, atRiskSla, openReviews } = data;
  const total = rotatedToMe.length + atRiskSla.length + openReviews.length;

  return (
    <section className="rounded-lg border border-status-warning/30 bg-status-warning/5 shadow-card">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-status-warning/30 px-3 py-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-status-warning">
          <AlertOctagon className="h-4 w-4" aria-hidden="true" />
          {t('title')}
          {total > 0 ? <Badge tone="warning">{total}</Badge> : null}
        </h2>
        <p className="text-xs text-ink-tertiary">{t('subtitle')}</p>
      </header>

      {total === 0 ? (
        <p className="px-3 py-4 text-sm text-ink-tertiary">{t('empty')}</p>
      ) : (
        <div className="flex flex-col divide-y divide-status-warning/20">
          {/* 1. Rotated to me (last 24h) */}
          {rotatedToMe.length > 0 ? (
            <CategoryBlock
              icon={<ArrowRightLeft className="h-3.5 w-3.5" aria-hidden="true" />}
              title={t('rotatedToMe.title')}
              count={rotatedToMe.length}
            >
              <ul className="divide-y divide-status-warning/15">
                {rotatedToMe.map((row) => (
                  <li
                    key={row.rotationId}
                    className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
                  >
                    <div className="flex min-w-0 flex-col leading-tight">
                      <span className="text-sm font-medium text-ink-primary">{row.leadName}</span>
                      <span className="flex flex-wrap items-center gap-1 text-xs text-ink-tertiary">
                        <Phone className="h-3 w-3" aria-hidden="true" />
                        <code className="font-mono">{row.phone}</code>
                        <span className="ms-1">·</span>
                        <span>{row.stage.name}</span>
                        <span className="ms-1">·</span>
                        <span>{t('rotatedToMe.reason')}</span>
                      </span>
                    </div>
                    <Link
                      href={`/admin/leads/${row.leadId}`}
                      className="text-xs font-medium text-brand-700 hover:text-brand-800"
                    >
                      {t('open')} →
                    </Link>
                  </li>
                ))}
              </ul>
            </CategoryBlock>
          ) : null}

          {/* 2. At-risk SLA (t150 / t200) */}
          {atRiskSla.length > 0 ? (
            <CategoryBlock
              icon={<AlertOctagon className="h-3.5 w-3.5" aria-hidden="true" />}
              title={t('atRiskSla.title')}
              count={atRiskSla.length}
            >
              <ul className="divide-y divide-status-warning/15">
                {atRiskSla.map((row) => (
                  <li
                    key={row.leadId}
                    className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
                  >
                    <div className="flex min-w-0 flex-col leading-tight">
                      <span className="flex flex-wrap items-center gap-1 text-sm font-medium text-ink-primary">
                        {row.leadName}
                        <Badge tone={row.threshold === 't200' ? 'breach' : 'warning'}>
                          {row.threshold}
                        </Badge>
                      </span>
                      <span className="flex flex-wrap items-center gap-1 text-xs text-ink-tertiary">
                        <Phone className="h-3 w-3" aria-hidden="true" />
                        <code className="font-mono">{row.phone}</code>
                        <span className="ms-1">·</span>
                        <span>{row.stage.name}</span>
                        <span className="ms-1">·</span>
                        <span>{t('atRiskSla.reason')}</span>
                      </span>
                    </div>
                    <Link
                      href={`/admin/leads/${row.leadId}`}
                      className="text-xs font-medium text-brand-700 hover:text-brand-800"
                    >
                      {t('open')} →
                    </Link>
                  </li>
                ))}
              </ul>
            </CategoryBlock>
          ) : null}

          {/* 3. Open reviews assigned to me */}
          {openReviews.length > 0 ? (
            <CategoryBlock
              icon={<ClipboardCheck className="h-3.5 w-3.5" aria-hidden="true" />}
              title={t('openReviews.title')}
              count={openReviews.length}
            >
              <ul className="divide-y divide-status-warning/15">
                {openReviews.map((row) => (
                  <li
                    key={row.reviewId}
                    className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
                  >
                    <div className="flex min-w-0 flex-col leading-tight">
                      <span className="text-sm font-medium text-ink-primary">{row.leadName}</span>
                      <span className="flex flex-wrap items-center gap-1 text-xs text-ink-tertiary">
                        <Phone className="h-3 w-3" aria-hidden="true" />
                        <code className="font-mono">{row.phone}</code>
                        <span className="ms-1">·</span>
                        <span>{row.stage.name}</span>
                        <span className="ms-1">·</span>
                        <span>{t('openReviews.reason')}</span>
                      </span>
                    </div>
                    <Link
                      href={`/admin/leads/${row.leadId}`}
                      className="text-xs font-medium text-brand-700 hover:text-brand-800"
                    >
                      {t('open')} →
                    </Link>
                  </li>
                ))}
              </ul>
            </CategoryBlock>
          ) : null}
        </div>
      )}
    </section>
  );
}

function CategoryBlock({
  icon,
  title,
  count,
  children,
}: {
  icon: JSX.Element;
  title: string;
  count: number;
  children: JSX.Element;
}): JSX.Element {
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-ink-secondary">
        {icon}
        <span>{title}</span>
        <span className="rounded-full bg-status-warning/20 px-1.5 text-[10px] font-medium text-status-warning">
          {count}
        </span>
      </div>
      {children}
    </div>
  );
}
