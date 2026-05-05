'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertCircle, CheckCircle2, Clock, History, Loader2, XCircle } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { ApiError, partnerSnapshotsApi } from '@/lib/api';
import { hasCapability } from '@/lib/auth';
import type { PartnerSnapshotRow } from '@/lib/api-types';
import { cn } from '@/lib/utils';

/**
 * Phase D4 — D4.3: Partner Snapshots history page.
 *
 * Read-only — every snapshot row in the active tenant ordered
 * newest-first. Filterable by status (all / running / success /
 * partial / failed). Per-row counts (total / imported / skipped /
 * error) and the resolved tab name from `sourceMetadata` are the
 * key forensic fields the operator needs.
 *
 * No record drill-down UI in D4.3 itself — the
 * `/partner-snapshots/:id/records` endpoint exists and the
 * operator can hit it directly via the API. A dedicated drill-down
 * page lands in a follow-up if operators need it.
 */

const STATUSES = ['all', 'running', 'success', 'partial', 'failed'] as const;
type StatusFilter = (typeof STATUSES)[number];

export default function PartnerSnapshotsPage(): JSX.Element {
  const t = useTranslations('admin.partnerSnapshots');
  const tCommon = useTranslations('admin.common');

  const canRead = hasCapability('partner.source.read');

  const [items, setItems] = useState<PartnerSnapshotRow[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [featureDisabled, setFeatureDisabled] = useState<boolean>(false);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  const reload = useCallback(async (): Promise<void> => {
    if (!canRead) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await partnerSnapshotsApi.list({ limit: 100 });
      setItems(result.items);
      setFeatureDisabled(false);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'partner.feature.disabled') {
        setFeatureDisabled(true);
        setItems([]);
      } else {
        setError(err instanceof ApiError ? err.message : String(err));
      }
    } finally {
      setLoading(false);
    }
  }, [canRead]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const filtered = useMemo(
    () => (statusFilter === 'all' ? items : items.filter((r) => r.status === statusFilter)),
    [items, statusFilter],
  );

  if (!canRead) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title={t('title')} subtitle={t('subtitle')} />
        <EmptyState
          icon={<History className="h-7 w-7" aria-hidden="true" />}
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
            {tCommon('retry')}
          </Button>
        }
      />

      {featureDisabled ? <Notice tone="info">{t('featureDisabled')}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}

      {/* Status chip filter (client-side; the API returns the full
          page; this is operator-friendly cohort flipping). */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-ink-tertiary">{t('filterLabel')}</span>
        {STATUSES.map((status) => (
          <button
            key={status}
            type="button"
            onClick={() => setStatusFilter(status)}
            className={cn(
              'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
              statusFilter === status
                ? 'border-brand-600 bg-brand-50 text-brand-700'
                : 'border-surface-border bg-surface-card text-ink-secondary hover:bg-surface',
            )}
          >
            {t(`statuses.${status}` as 'statuses.all')}
          </button>
        ))}
      </div>

      {!loading && !featureDisabled && filtered.length === 0 ? (
        <EmptyState
          icon={<History className="h-7 w-7" aria-hidden="true" />}
          title={t(statusFilter === 'all' ? 'emptyTitle' : 'emptyFilteredTitle')}
          body={t(statusFilter === 'all' ? 'emptyBody' : 'emptyFilteredBody')}
        />
      ) : null}

      {!featureDisabled && filtered.length > 0 ? (
        <ul className="flex flex-col gap-3">
          {filtered.map((row) => (
            <li key={row.id}>
              <SnapshotCard row={row} t={t} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function SnapshotCard({
  row,
  t,
}: {
  row: PartnerSnapshotRow;
  t: ReturnType<typeof useTranslations>;
}): JSX.Element {
  const tabName = (row.sourceMetadata?.['resolvedTabName'] as string | undefined) ?? null;
  const errorName = (row.sourceMetadata?.['errorName'] as string | undefined) ?? null;
  const trigger = (row.sourceMetadata?.['trigger'] as string | undefined) ?? null;
  const durationMs =
    row.completedAt && row.startedAt
      ? Date.parse(row.completedAt) - Date.parse(row.startedAt)
      : null;

  return (
    <article className="flex flex-col gap-2 rounded-lg border border-surface-border bg-surface-card p-4 shadow-sm">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <div className="inline-flex items-center gap-2">
            <StatusBadge status={row.status} t={t} />
            {row.partnerSource ? (
              <Link
                href={`/admin/partner-sources/${row.partnerSource.id}`}
                className="text-sm font-semibold text-ink-primary hover:underline"
              >
                {row.partnerSource.displayName}
              </Link>
            ) : (
              <span className="text-sm font-semibold text-ink-tertiary">{t('sourceRemoved')}</span>
            )}
            {trigger ? (
              <Badge tone="neutral">{t(`triggers.${trigger}` as 'triggers.manual')}</Badge>
            ) : null}
          </div>
          <p className="text-xs text-ink-tertiary">
            {new Date(row.startedAt).toLocaleString()}
            {durationMs !== null ? ` · ${formatDuration(durationMs)}` : ''}
            {tabName ? ` · ${t('resolvedTab')}: ${tabName}` : ''}
            {row.triggeredBy ? ` · ${t('triggeredBy')}: ${row.triggeredBy.name}` : ''}
          </p>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-3 text-xs text-ink-secondary">
        <span>
          {t('counts.total')}: <strong>{row.rowsTotal}</strong>
        </span>
        <span className="text-status-success">
          {t('counts.imported')}: <strong>{row.rowsImported}</strong>
        </span>
        <span className="text-ink-tertiary">
          {t('counts.skipped')}: <strong>{row.rowsSkipped}</strong>
        </span>
        <span className={row.rowsError > 0 ? 'text-status-warning' : 'text-ink-tertiary'}>
          {t('counts.error')}: <strong>{row.rowsError}</strong>
        </span>
      </div>

      {errorName && row.status === 'failed' ? (
        <div className="flex items-start gap-2 rounded-md border border-status-warning/40 bg-status-warning/10 px-3 py-2 text-xs text-status-warning">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>
            {t('errorPrefix')}: <code className="font-mono">{errorName}</code>
          </span>
        </div>
      ) : null}
    </article>
  );
}

function StatusBadge({
  status,
  t,
}: {
  status: string;
  t: ReturnType<typeof useTranslations>;
}): JSX.Element {
  const label = t(`statuses.${status}` as 'statuses.success');
  if (status === 'success') {
    return (
      <Badge tone="info">
        <CheckCircle2 className="me-1 h-3 w-3" aria-hidden="true" />
        {label}
      </Badge>
    );
  }
  if (status === 'partial') {
    return (
      <Badge tone="warning">
        <AlertCircle className="me-1 h-3 w-3" aria-hidden="true" />
        {label}
      </Badge>
    );
  }
  if (status === 'failed') {
    return (
      <Badge tone="breach">
        <XCircle className="me-1 h-3 w-3" aria-hidden="true" />
        {label}
      </Badge>
    );
  }
  if (status === 'running') {
    return (
      <Badge tone="warning">
        <Loader2 className="me-1 h-3 w-3 animate-spin" aria-hidden="true" />
        {label}
      </Badge>
    );
  }
  return (
    <Badge tone="neutral">
      <Clock className="me-1 h-3 w-3" aria-hidden="true" />
      {label}
    </Badge>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}
