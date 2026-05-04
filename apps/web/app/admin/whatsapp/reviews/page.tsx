'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { CheckCircle2, Filter, RefreshCw, ShieldQuestion } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Select } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { ReviewCard } from '@/components/whatsapp/review-card';
import { ApiError, reviewsApi } from '@/lib/api';
import { hasCapability } from '@/lib/auth';
import type { ReviewReason, WhatsAppConversationReview } from '@/lib/api-types';
import { cn } from '@/lib/utils';

/**
 * D1.5 — WhatsApp Review Queue page.
 *
 * Lives at /admin/whatsapp/reviews. Capability gates:
 *   - whatsapp.review.read    — required to land on the page
 *   - whatsapp.review.resolve — controls whether action buttons
 *                               render. Read-only mode shows the
 *                               cards with a clear "Read-only
 *                               access" hint per card.
 *
 * UX rules of the surface:
 *   - This is a triage page, NOT a data grid. Each item is a
 *     decision-card, not a row.
 *   - Reason filter is local (we already fetch the full list of
 *     unresolved items in scope).
 *   - The Active / Resolved tab toggles a server-side `?resolved`
 *     param so the historical list stays paginated server-side.
 *   - On a successful resolve the page re-fetches to drop the row
 *     out of the active list.
 */

type Tab = 'active' | 'resolved';
type ReasonFilter = 'all' | ReviewReason;

export default function WhatsAppReviewsPage(): JSX.Element {
  const t = useTranslations('admin.whatsappReviews');
  const tCommon = useTranslations('admin.common');

  const canRead = hasCapability('whatsapp.review.read');
  const canResolve = hasCapability('whatsapp.review.resolve');

  const [tab, setTab] = useState<Tab>('active');
  const [reasonFilter, setReasonFilter] = useState<ReasonFilter>('all');
  const [items, setItems] = useState<WhatsAppConversationReview[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    if (!canRead) return;
    setLoading(true);
    setError(null);
    try {
      const page = await reviewsApi.list({
        resolved: tab === 'resolved',
        limit: 100,
      });
      setItems(page.items);
      setTotal(page.total);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      setItems([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [canRead, tab]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const filteredItems = useMemo(
    () => (reasonFilter === 'all' ? items : items.filter((r) => r.reason === reasonFilter)),
    [items, reasonFilter],
  );

  // No-access guard.
  if (!canRead) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title={t('title')} subtitle={t('subtitle')} />
        <Notice tone="error">{t('noAccess')}</Notice>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void reload()}
            disabled={loading}
            aria-label={t('refresh')}
          >
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} aria-hidden="true" />
          </Button>
        }
      />

      {/* Filter bar — Active/Resolved tabs + reason filter */}
      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-surface-border bg-surface-card p-3">
        <div
          className="inline-flex overflow-hidden rounded-md border border-surface-border"
          role="tablist"
          aria-label={t('filter.tabsLabel')}
        >
          <TabButton
            active={tab === 'active'}
            onClick={() => setTab('active')}
            label={t('filter.active')}
          />
          <TabButton
            active={tab === 'resolved'}
            onClick={() => setTab('resolved')}
            label={t('filter.resolved')}
          />
        </div>
        <div className="w-56">
          <Field label={t('filter.reasonLabel')}>
            <Select
              value={reasonFilter}
              onChange={(e) => setReasonFilter(e.target.value as ReasonFilter)}
            >
              <option value="all">{tCommon('all')}</option>
              <option value="captain_active">{t('reason.captain_active')}</option>
              <option value="duplicate_lead">{t('reason.duplicate_lead')}</option>
              <option value="unmatched_after_routing">{t('reason.unmatched_after_routing')}</option>
            </Select>
          </Field>
        </div>
        <div className="ms-auto inline-flex items-center gap-1 text-xs text-ink-tertiary">
          <Filter className="h-3 w-3" aria-hidden="true" />
          {t('count', { n: filteredItems.length, total })}
        </div>
      </div>

      {error ? <Notice tone="error">{error}</Notice> : null}

      {loading && items.length === 0 ? (
        <p className="rounded-lg border border-surface-border bg-surface-card p-8 text-center text-sm text-ink-secondary">
          {tCommon('loading')}
        </p>
      ) : filteredItems.length === 0 ? (
        <EmptyState
          icon={
            tab === 'resolved' ? (
              <CheckCircle2 className="h-7 w-7" aria-hidden="true" />
            ) : (
              <ShieldQuestion className="h-7 w-7" aria-hidden="true" />
            )
          }
          title={tab === 'resolved' ? t('empty.resolved.title') : t('empty.active.title')}
          body={tab === 'resolved' ? t('empty.resolved.body') : t('empty.active.body')}
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {filteredItems.map((review) => (
            <li key={review.id}>
              <ReviewCard
                review={review}
                canResolve={canResolve && tab === 'active'}
                onResolved={() => void reload()}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}): JSX.Element {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'px-3 py-1.5 text-sm transition-colors',
        active
          ? 'bg-brand-600 text-white'
          : 'text-ink-secondary hover:bg-brand-50 hover:text-brand-700',
      )}
    >
      {label}
    </button>
  );
}
