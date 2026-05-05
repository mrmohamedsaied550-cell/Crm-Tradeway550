'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { CheckCircle2, Database, KeyRound, Plus, ShieldOff } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { ApiError, partnerSourcesApi } from '@/lib/api';
import { hasCapability } from '@/lib/auth';
import type { PartnerSourceRow } from '@/lib/api-types';

/**
 * Phase D4 — D4.2: Partner Sources list page.
 *
 * Configuration index for the Partner Data Hub. Sales / activation
 * / driving agents fail the `partner.source.read` capability gate
 * and see a no-access notice. TLs / Ops / Account Manager / Super
 * Admin land here to configure sources and field mappings.
 *
 * The actual sync engine, snapshot history, verification card,
 * controlled merge, reconciliation, and milestones land in later
 * D4.x chunks (D4.3 — D4.7). D4.2 is configuration only.
 */
export default function PartnerSourcesPage(): JSX.Element {
  const t = useTranslations('admin.partnerSources');

  const canRead = hasCapability('partner.source.read');
  const canWrite = hasCapability('partner.source.write');

  const [items, setItems] = useState<PartnerSourceRow[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [featureDisabled, setFeatureDisabled] = useState<boolean>(false);

  const reload = useCallback(async (): Promise<void> => {
    if (!canRead) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await partnerSourcesApi.list({ limit: 100 });
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

  if (!canRead) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title={t('title')} subtitle={t('subtitle')} />
        <EmptyState
          icon={<Database className="h-7 w-7" aria-hidden="true" />}
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
          canWrite && !featureDisabled ? (
            <Link href="/admin/partner-sources/new">
              <Button size="sm">
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                {t('newCta')}
              </Button>
            </Link>
          ) : null
        }
      />

      {featureDisabled ? <Notice tone="info">{t('featureDisabled')}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}

      {!loading && !featureDisabled && items.length === 0 ? (
        <EmptyState
          icon={<Database className="h-7 w-7" aria-hidden="true" />}
          title={t('emptyTitle')}
          body={t('emptyBody')}
        />
      ) : null}

      {!featureDisabled && items.length > 0 ? (
        <ul className="flex flex-col gap-3">
          {items.map((row) => (
            <li key={row.id}>
              <PartnerSourceCard row={row} t={t} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function PartnerSourceCard({
  row,
  t,
}: {
  row: PartnerSourceRow;
  t: ReturnType<typeof useTranslations>;
}): JSX.Element {
  return (
    <Link
      href={`/admin/partner-sources/${row.id}`}
      className="flex flex-col gap-2 rounded-lg border border-surface-border bg-surface-card p-4 shadow-sm transition-colors hover:border-brand-600/40 hover:bg-brand-50/30"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <div className="inline-flex items-center gap-2">
            <span className="text-base font-semibold text-ink-primary">{row.displayName}</span>
            <Badge tone={row.isActive ? 'info' : 'neutral'}>
              {row.isActive ? t('badges.active') : t('badges.disabled')}
            </Badge>
            <Badge tone="neutral">{row.partnerCode}</Badge>
          </div>
          <p className="text-xs text-ink-tertiary">
            {t(`adapters.${row.adapter}` as 'adapters.google_sheets')} ·{' '}
            {t(`schedules.${row.scheduleKind}` as 'schedules.manual')}
            {row.scheduleKind === 'cron' && row.cronSpec ? (
              <span className="ms-1 font-mono">{row.cronSpec}</span>
            ) : null}
            {' · '}
            {t(`tabModes.${row.tabMode}` as 'tabModes.fixed')}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <span className="inline-flex items-center gap-1 text-xs text-ink-tertiary">
            {row.hasCredentials ? (
              <>
                <KeyRound className="h-3 w-3 text-status-success" aria-hidden="true" />
                {t('credentials.configured')}
              </>
            ) : (
              <>
                <ShieldOff className="h-3 w-3 text-ink-tertiary" aria-hidden="true" />
                {t('credentials.notConfigured')}
              </>
            )}
          </span>
          <span className="text-[11px] text-ink-tertiary">
            {row.lastSyncAt ? (
              <>
                {t('lastSync')}: {new Date(row.lastSyncAt).toLocaleString()}
              </>
            ) : (
              t('lastSyncNever')
            )}
          </span>
        </div>
      </div>
      {row.connectionStatus ? (
        <div className="inline-flex items-center gap-1 text-[11px] text-ink-tertiary">
          <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
          <span>
            {t('connectionStatusLabel')}:{' '}
            {t(
              `connectionStatuses.${row.connectionStatus}` as 'connectionStatuses.untested',
              {} as Record<string, never>,
            )}
          </span>
        </div>
      ) : null}
      <span className="text-xs text-brand-700">{t('openCta')} →</span>
    </Link>
  );
}
