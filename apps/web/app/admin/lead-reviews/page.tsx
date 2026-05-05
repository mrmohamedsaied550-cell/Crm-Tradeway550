'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Filter, Inbox, RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { LeadReviewCard } from '@/components/admin/lead-reviews/lead-review-card';
import { ApiError, leadReviewsApi } from '@/lib/api';
import { hasCapability } from '@/lib/auth';
import type { LeadReviewReason, LeadReviewRow } from '@/lib/api-types';
import { cn } from '@/lib/utils';

/**
 * Phase D3 — D3.6: TL Review Queue page.
 *
 * Lives at /admin/lead-reviews. Mirrors the D1.5
 * /admin/whatsapp/reviews UX: tabs (Active / Resolved), reason
 * chips, decision-card list. Capability gates:
 *   - lead.review.read    — required to land on the page
 *   - lead.review.resolve — controls whether action buttons render.
 *
 * Sales / activation / driving agents fail the capability check and
 * see a no-access notice.
 */

type Tab = 'active' | 'resolved';
type ReasonFilter = 'all' | LeadReviewReason;

const REASON_VALUES: readonly LeadReviewReason[] = [
  'sla_breach_repeat',
  'rotation_failed',
  'manual_tl_review',
  'bottleneck_flagged',
  'escalated_by_tl',
];

export default function LeadReviewsPage(): JSX.Element {
  const t = useTranslations('admin.leadReviews');
  const tCommon = useTranslations('admin.common');

  const canRead = hasCapability('lead.review.read');
  const canResolve = hasCapability('lead.review.resolve');

  const [tab, setTab] = useState<Tab>('active');
  const [reasonFilter, setReasonFilter] = useState<ReasonFilter>('all');
  const [items, setItems] = useState<LeadReviewRow[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    if (!canRead) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await leadReviewsApi.list({
        resolved: tab === 'resolved',
        ...(reasonFilter !== 'all' && { reason: reasonFilter }),
        limit: 100,
      });
      setItems(result.items);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [canRead, tab, reasonFilter]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const reasonCounts = useMemo(() => {
    const counts = new Map<LeadReviewReason, number>();
    for (const item of items) {
      counts.set(item.reason, (counts.get(item.reason) ?? 0) + 1);
    }
    return counts;
  }, [items]);

  if (!canRead) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title={t('title')} subtitle={t('subtitle')} />
        <EmptyState
          icon={<Inbox className="h-7 w-7" aria-hidden="true" />}
          title={t('noAccessTitle')}
          body={t('noAccessBody')}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          <Button variant="secondary" size="sm" onClick={() => void reload()} loading={loading}>
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            {tCommon('retry')}
          </Button>
        }
      />

      {/* Tabs: Active / Resolved */}
      <div className="flex flex-wrap gap-2">
        {(['active', 'resolved'] as const).map((tabValue) => (
          <button
            key={tabValue}
            type="button"
            onClick={() => setTab(tabValue)}
            className={cn(
              'rounded-md border px-3 py-1.5 text-sm font-medium transition-colors',
              tab === tabValue
                ? 'border-brand-600 bg-brand-50 text-brand-700'
                : 'border-surface-border bg-surface-card text-ink-secondary hover:bg-surface',
            )}
          >
            {t(`tabs.${tabValue}` as 'tabs.active')}
          </button>
        ))}
      </div>

      {/* Reason chips — local filter on the fetched page. */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1 text-xs text-ink-tertiary">
          <Filter className="h-3 w-3" aria-hidden="true" />
          {t('filterLabel')}
        </span>
        <button
          type="button"
          onClick={() => setReasonFilter('all')}
          className={cn(
            'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
            reasonFilter === 'all'
              ? 'border-brand-600 bg-brand-50 text-brand-700'
              : 'border-surface-border bg-surface-card text-ink-secondary hover:bg-surface',
          )}
        >
          {t('chips.all')} ({items.length})
        </button>
        {REASON_VALUES.map((reason) => (
          <button
            key={reason}
            type="button"
            onClick={() => setReasonFilter(reasonFilter === reason ? 'all' : reason)}
            className={cn(
              'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
              reasonFilter === reason
                ? 'border-brand-600 bg-brand-50 text-brand-700'
                : 'border-surface-border bg-surface-card text-ink-secondary hover:bg-surface',
            )}
          >
            {t(`reason.${reason}` as 'reason.sla_breach_repeat')} ({reasonCounts.get(reason) ?? 0})
          </button>
        ))}
      </div>

      {error ? <Notice tone="error">{error}</Notice> : null}

      {!loading && items.length === 0 ? (
        <EmptyState
          icon={<Inbox className="h-7 w-7" aria-hidden="true" />}
          title={t(tab === 'active' ? 'emptyActiveTitle' : 'emptyResolvedTitle')}
          body={t(tab === 'active' ? 'emptyActiveBody' : 'emptyResolvedBody')}
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((row) => (
            <li key={row.id}>
              <LeadReviewCard
                review={row}
                canResolve={canResolve}
                onResolved={() => void reload()}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
