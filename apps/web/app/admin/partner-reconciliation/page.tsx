'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardList,
  Download,
  ExternalLink,
  ScanSearch,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Textarea } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { useToast } from '@/components/ui/toast';
import { ApiError, partnerReconciliationApi, partnerSourcesApi } from '@/lib/api';
import type {
  PartnerSourceRow,
  ReconciliationCategory,
  ReconciliationItem,
  ReconciliationResult,
} from '@/lib/api-types';
import { hasCapability } from '@/lib/auth';
import { cn } from '@/lib/utils';

/**
 * Phase D4 — D4.6: Partner Reconciliation page.
 *
 * Read-only derived view comparing CRM truth to the latest partner
 * snapshot. Operators with `partner.reconciliation.read` see the
 * full table + CSV export; `partner.reconciliation.resolve` adds
 * the "Open as review" action that promotes a row into the TL
 * Review Queue (idempotent — second click on the same lead +
 * category returns the already-open review id).
 */

const CATEGORIES: readonly ReconciliationCategory[] = [
  'partner_missing',
  'partner_active_not_in_crm',
  'partner_date_mismatch',
  'partner_dft_mismatch',
  'partner_trips_mismatch',
];

export default function PartnerReconciliationPage(): JSX.Element {
  const t = useTranslations('admin.partnerReconciliation');
  const tCommon = useTranslations('admin.common');
  const { toast } = useToast();

  const canRead = hasCapability('partner.reconciliation.read');
  const canResolve = hasCapability('partner.reconciliation.resolve');

  const [sources, setSources] = useState<PartnerSourceRow[]>([]);
  const [partnerSourceId, setPartnerSourceId] = useState<string>('');
  const [category, setCategory] = useState<ReconciliationCategory | ''>('');
  const [data, setData] = useState<ReconciliationResult | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [featureDisabled, setFeatureDisabled] = useState<boolean>(false);

  // Open-review modal state
  const [openItem, setOpenItem] = useState<ReconciliationItem | null>(null);
  const [openNotes, setOpenNotes] = useState<string>('');
  const [opening, setOpening] = useState<boolean>(false);
  const [openError, setOpenError] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    if (!canRead) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await partnerReconciliationApi.list({
        ...(partnerSourceId && { partnerSourceId }),
        ...(category && { category }),
        limit: 200,
      });
      setData(result);
      setFeatureDisabled(false);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'partner.feature.disabled') {
        setFeatureDisabled(true);
        setData(null);
      } else {
        setError(err instanceof ApiError ? err.message : String(err));
      }
    } finally {
      setLoading(false);
    }
  }, [canRead, partnerSourceId, category]);

  useEffect(() => {
    if (!canRead) return;
    let cancelled = false;
    partnerSourcesApi
      .list({ isActive: true, limit: 100 })
      .then((res) => {
        if (!cancelled) setSources(res.items);
      })
      .catch(() => {
        // Best-effort — without sources the page still works (
        // the source dropdown becomes empty).
      });
    return () => {
      cancelled = true;
    };
  }, [canRead]);

  useEffect(() => {
    void reload();
  }, [reload]);

  function openReviewModal(item: ReconciliationItem): void {
    setOpenItem(item);
    setOpenNotes('');
    setOpenError(null);
  }

  async function onConfirmOpenReview(): Promise<void> {
    if (!openItem || !openItem.leadId) return;
    setOpening(true);
    setOpenError(null);
    try {
      const result = await partnerReconciliationApi.openReview({
        category: openItem.category,
        leadId: openItem.leadId,
        partnerSourceId: openItem.partnerSourceId,
        ...(openNotes.trim().length > 0 ? { notes: openNotes.trim() } : {}),
      });
      toast({
        tone: 'success',
        title: result.alreadyOpen ? t('openReview.alreadyOpenToast') : t('openReview.openedToast'),
      });
      setOpenItem(null);
      setOpenNotes('');
    } catch (err) {
      setOpenError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setOpening(false);
    }
  }

  if (!canRead) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title={t('title')} subtitle={t('subtitle')} />
        <EmptyState
          icon={<ScanSearch className="h-7 w-7" aria-hidden="true" />}
          title={t('noAccessTitle')}
          body={t('noAccessBody')}
        />
      </div>
    );
  }

  const exportHref = partnerReconciliationApi.exportCsvUrl({
    ...(partnerSourceId && { partnerSourceId }),
    ...(category && { category }),
  });
  const items = data?.items ?? [];
  const counts = data?.counts;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          <a href={exportHref} target="_blank" rel="noopener noreferrer">
            <Button variant="secondary" size="sm" disabled={featureDisabled}>
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              {t('exportCsv')}
            </Button>
          </a>
        }
      />

      {featureDisabled ? <Notice tone="info">{t('featureDisabled')}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}

      {/* Filters: source + category chips */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs text-ink-tertiary">{t('filters.source')}</span>
          <select
            value={partnerSourceId}
            onChange={(e) => setPartnerSourceId(e.target.value)}
            className="rounded-md border border-surface-border bg-surface-card px-2 py-1 text-sm text-ink-primary"
          >
            <option value="">{t('filters.allSources')}</option>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.displayName}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-ink-tertiary">{t('filters.category')}</span>
          <button
            type="button"
            onClick={() => setCategory('')}
            className={cn(
              'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
              category === ''
                ? 'border-brand-600 bg-brand-50 text-brand-700'
                : 'border-surface-border bg-surface-card text-ink-secondary hover:bg-surface',
            )}
          >
            {t('filters.allCategories')} ({sumCounts(counts)})
          </button>
          {CATEGORIES.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setCategory(category === c ? '' : c)}
              className={cn(
                'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                category === c
                  ? 'border-brand-600 bg-brand-50 text-brand-700'
                  : 'border-surface-border bg-surface-card text-ink-secondary hover:bg-surface',
              )}
            >
              {t(`categories.${c}` as 'categories.partner_missing')} ({counts?.[c] ?? 0})
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-ink-tertiary">{tCommon('loading')}</p>
      ) : items.length === 0 ? (
        <EmptyState
          icon={<CheckCircle2 className="h-7 w-7" aria-hidden="true" />}
          title={t('emptyTitle')}
          body={t('emptyBody')}
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((item, idx) => (
            <li key={`${item.partnerSourceId}-${item.phone}-${item.category}-${idx}`}>
              <DiscrepancyCard
                item={item}
                t={t}
                canResolve={canResolve}
                onOpenReview={openReviewModal}
              />
            </li>
          ))}
        </ul>
      )}

      {/* Open-as-review modal */}
      <Modal
        open={openItem !== null}
        title={t('openReview.title')}
        onClose={() => (opening ? undefined : setOpenItem(null))}
        width="md"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setOpenItem(null)} disabled={opening}>
              {tCommon('cancel')}
            </Button>
            <Button size="sm" onClick={() => void onConfirmOpenReview()} loading={opening}>
              <ClipboardList className="h-3.5 w-3.5" aria-hidden="true" />
              {t('openReview.cta')}
            </Button>
          </>
        }
      >
        {openItem ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-ink-primary">{t('openReview.body')}</p>
            <dl className="grid grid-cols-1 gap-3 rounded-md border border-surface-border bg-surface px-3 py-2 sm:grid-cols-2">
              <ConfirmField
                label={t('openReview.partnerSource')}
                value={openItem.partnerSourceName}
              />
              <ConfirmField
                label={t('openReview.category')}
                value={t(`categories.${openItem.category}` as 'categories.partner_missing')}
              />
              <ConfirmField label={t('openReview.lead')} value={openItem.crmName} />
              <ConfirmField label={t('openReview.phone')} value={openItem.phone} />
            </dl>
            <Field label={t('openReview.notesLabel')} hint={t('openReview.notesHelper')}>
              <Textarea
                value={openNotes}
                onChange={(e) => setOpenNotes(e.target.value)}
                rows={3}
                maxLength={1000}
              />
            </Field>
            {openError ? <Notice tone="error">{openError}</Notice> : null}
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

function DiscrepancyCard({
  item,
  t,
  canResolve,
  onOpenReview,
}: {
  item: ReconciliationItem;
  t: ReturnType<typeof useTranslations>;
  canResolve: boolean;
  onOpenReview: (item: ReconciliationItem) => void;
}): JSX.Element {
  const tone = item.severity === 'warning' ? 'warning' : 'info';
  return (
    <article
      className={cn(
        'flex flex-col gap-2 rounded-lg border bg-surface-card p-4 shadow-sm',
        item.severity === 'warning' ? 'border-status-warning/40' : 'border-surface-border',
      )}
    >
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <div className="inline-flex flex-wrap items-center gap-2">
            <Badge tone={tone}>
              <AlertTriangle className="me-1 h-3 w-3" aria-hidden="true" />
              {t(`categories.${item.category}` as 'categories.partner_missing')}
            </Badge>
            {/* D4.8 — recommendedAction chip. Translates the raw
                action code into operator-readable copy in EN/AR.
                Falls back to the raw code when an unknown action
                lands (forward-compat with future categories). */}
            {item.recommendedAction ? (
              <Badge tone="neutral">
                {t(
                  `recommendedAction.${item.recommendedAction}` as 'recommendedAction.review_or_convert',
                )}
              </Badge>
            ) : null}
            <span className="text-sm font-semibold text-ink-primary">
              {item.crmName ?? <span className="text-ink-tertiary">{t('unnamedLead')}</span>}
            </span>
            <span className="text-xs text-ink-tertiary">
              · <code className="font-mono">{item.phone}</code>
            </span>
          </div>
          <p className="text-xs text-ink-tertiary">
            {item.partnerSourceName}
            {item.crmStage ? ` · ${item.crmStage}` : ''}
            {item.crmLifecycleState ? ` · ${item.crmLifecycleState}` : ''}
            {item.lastSyncAt
              ? ` · ${t('lastSync')}: ${new Date(item.lastSyncAt).toLocaleString()}`
              : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {item.leadId ? (
            <Link
              href={`/admin/leads/${item.leadId}`}
              className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline"
            >
              {t('openLead')}
              <ExternalLink className="h-3 w-3" aria-hidden="true" />
            </Link>
          ) : null}
          {canResolve && item.leadId ? (
            <Button variant="secondary" size="sm" onClick={() => onOpenReview(item)}>
              <ClipboardList className="h-3.5 w-3.5" aria-hidden="true" />
              {t('openReview.cta')}
            </Button>
          ) : null}
        </div>
      </header>

      <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <ValuePair label={t('values.partner')} value={partnerValueFor(item)} />
        <ValuePair label={t('values.crm')} value={crmValueFor(item)} />
      </dl>
    </article>
  );
}

function ValuePair({ label, value }: { label: string; value: string | null }): JSX.Element {
  return (
    <div className="flex flex-col">
      <dt className="text-[11px] uppercase tracking-wide text-ink-tertiary">{label}</dt>
      <dd className="text-sm text-ink-primary">
        {value ?? <span className="text-ink-tertiary">—</span>}
      </dd>
    </div>
  );
}

function ConfirmField({ label, value }: { label: string; value: string | null }): JSX.Element {
  return (
    <div className="flex flex-col">
      <dt className="text-[11px] uppercase tracking-wide text-ink-tertiary">{label}</dt>
      <dd className="text-sm text-ink-primary">
        {value ?? <span className="text-ink-tertiary">—</span>}
      </dd>
    </div>
  );
}

function partnerValueFor(item: ReconciliationItem): string | null {
  if (item.category === 'partner_date_mismatch') return formatDate(item.partnerActiveDate);
  if (item.category === 'partner_dft_mismatch') return formatDate(item.partnerDftDate);
  if (item.category === 'partner_trips_mismatch') return item.partnerTripCount?.toString() ?? null;
  if (item.category === 'partner_active_not_in_crm') return item.partnerStatus ?? null;
  if (item.category === 'partner_missing') return item.partnerStatus ?? '—';
  return null;
}

function crmValueFor(item: ReconciliationItem): string | null {
  if (item.category === 'partner_date_mismatch') return formatDate(item.crmActiveDate);
  if (item.category === 'partner_dft_mismatch') return formatDate(item.crmDftDate);
  if (item.category === 'partner_trips_mismatch') return item.crmTripCount?.toString() ?? null;
  if (item.category === 'partner_active_not_in_crm') return item.crmLifecycleState ?? null;
  if (item.category === 'partner_missing') return item.crmLifecycleState ?? null;
  return null;
}

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString();
}

function sumCounts(counts: Record<ReconciliationCategory, number> | undefined): number {
  if (!counts) return 0;
  return (Object.values(counts) as number[]).reduce((a, b) => a + b, 0);
}
