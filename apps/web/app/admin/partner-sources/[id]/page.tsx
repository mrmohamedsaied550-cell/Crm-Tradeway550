'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowLeft, History, PlayCircle, PlugZap, Power, Upload } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Textarea } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { useToast } from '@/components/ui/toast';
import { PartnerMappingBuilder } from '@/components/admin/partner-sources/partner-mapping-builder';
import { PartnerSourceForm } from '@/components/admin/partner-sources/partner-source-form';
import { ApiError, partnerSourcesApi } from '@/lib/api';
import type {
  PartnerConnectionTestResult,
  PartnerSourceRow,
  PartnerSyncRunResult,
} from '@/lib/api-types';
import { hasCapability } from '@/lib/auth';

/**
 * Phase D4 — D4.3: Partner Source detail page.
 *
 * Sections:
 *   • Status strip — active / credentials / connection status /
 *     last sync timestamp.
 *   • "Test connection" — real adapter probe (D4.3). Updates
 *     connectionStatus + lastTestedAt server-side.
 *   • "Sync now" — triggers a real sync run. For Google Sheets
 *     sources, the adapter is currently a seam and the run will
 *     land as `failed` with `partner.adapter.not_wired`. The UI
 *     surfaces that result truthfully — no fake-success copy.
 *   • "Upload CSV" — opens a paste modal for manual_upload
 *     sources. Reuses the same /sync-upload endpoint.
 *   • Disable, source-config form, mapping builder.
 */
export default function PartnerSourceDetailPage(): JSX.Element {
  const params = useParams();
  const router = useRouter();
  const t = useTranslations('admin.partnerSources');
  const tForm = useTranslations('admin.partnerSources.form');
  const tSync = useTranslations('admin.partnerSources.sync');
  const tCommon = useTranslations('admin.common');
  const { toast } = useToast();

  const canRead = hasCapability('partner.source.read');
  const canWrite = hasCapability('partner.source.write');
  const canRunSync = hasCapability('partner.sync.run');

  const id = typeof params['id'] === 'string' ? params['id'] : '';

  const [source, setSource] = useState<PartnerSourceRow | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<PartnerConnectionTestResult | null>(null);
  const [testing, setTesting] = useState<boolean>(false);
  const [disabling, setDisabling] = useState<boolean>(false);
  const [disableOpen, setDisableOpen] = useState<boolean>(false);

  const [syncing, setSyncing] = useState<boolean>(false);
  const [lastRun, setLastRun] = useState<PartnerSyncRunResult | null>(null);
  const [uploadOpen, setUploadOpen] = useState<boolean>(false);
  const [uploadCsv, setUploadCsv] = useState<string>('');

  const reload = useCallback(async (): Promise<void> => {
    if (!id || !canRead) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const row = await partnerSourcesApi.get(id);
      setSource(row);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [id, canRead]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function onSave(input: Parameters<typeof partnerSourcesApi.update>[1]): Promise<void> {
    if (!source) return;
    const updated = await partnerSourcesApi.update(source.id, input);
    setSource(updated);
    toast({ tone: 'success', title: tForm('savedToast') });
  }

  async function onEraseCredentials(): Promise<void> {
    if (!source) return;
    const updated = await partnerSourcesApi.update(source.id, { credentials: null });
    setSource(updated);
    toast({ tone: 'success', title: tForm('credentials.erasedToast') });
  }

  async function onTestConnection(): Promise<void> {
    if (!source) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await partnerSourcesApi.testConnection(source.id);
      setTestResult(result);
      // Reload to pick up the server-side connectionStatus +
      // lastTestedAt updates.
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  }

  async function onSyncNow(): Promise<void> {
    if (!source) return;
    setSyncing(true);
    setLastRun(null);
    try {
      const result = await partnerSourcesApi.sync(source.id);
      setLastRun(result);
      const tone =
        result.status === 'success' ? 'success' : result.status === 'failed' ? 'error' : 'info';
      toast({
        tone,
        title: tSync(`toast.${result.status ?? 'skipped'}` as 'toast.success'),
      });
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSyncing(false);
    }
  }

  async function onSyncUpload(): Promise<void> {
    if (!source) return;
    if (uploadCsv.trim().length === 0) return;
    setSyncing(true);
    setLastRun(null);
    try {
      const result = await partnerSourcesApi.syncUpload(source.id, uploadCsv);
      setLastRun(result);
      const tone =
        result.status === 'success' ? 'success' : result.status === 'failed' ? 'error' : 'info';
      toast({
        tone,
        title: tSync(`toast.${result.status ?? 'skipped'}` as 'toast.success'),
      });
      setUploadOpen(false);
      setUploadCsv('');
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSyncing(false);
    }
  }

  async function onDisable(): Promise<void> {
    if (!source) return;
    setDisabling(true);
    try {
      const updated = await partnerSourcesApi.disable(source.id);
      setSource(updated);
      toast({ tone: 'success', title: tForm('disabledToast') });
      setDisableOpen(false);
      router.push('/admin/partner-sources');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setDisabling(false);
    }
  }

  if (!canRead) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title={t('detailTitle')} subtitle={t('detailSubtitle')} />
        <Notice tone="error">{t('noAccessBody')}</Notice>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={source?.displayName ?? t('detailTitle')}
        subtitle={source ? `${source.partnerCode} · ${source.adapter}` : t('detailSubtitle')}
        actions={
          <div className="flex items-center gap-2">
            {source ? (
              <Link href={`/admin/partner-snapshots?partnerSourceId=${source.id}`}>
                <Button variant="ghost" size="sm">
                  <History className="h-3.5 w-3.5" aria-hidden="true" />
                  {tSync('historyCta')}
                </Button>
              </Link>
            ) : null}
            <Link href="/admin/partner-sources">
              <Button variant="ghost" size="sm">
                <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
                {t('backCta')}
              </Button>
            </Link>
          </div>
        }
      />

      {error ? <Notice tone="error">{error}</Notice> : null}

      {loading ? (
        <p className="text-sm text-ink-tertiary">{t('loading')}</p>
      ) : !source ? (
        <Notice tone="error">{t('notFound')}</Notice>
      ) : (
        <>
          {/* Status strip + actions */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-surface-border bg-surface-card p-3 shadow-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={source.isActive ? 'info' : 'neutral'}>
                {source.isActive ? t('badges.active') : t('badges.disabled')}
              </Badge>
              <Badge tone={source.hasCredentials ? 'info' : 'neutral'}>
                {source.hasCredentials
                  ? t('credentials.configured')
                  : t('credentials.notConfigured')}
              </Badge>
              {source.connectionStatus ? (
                <Badge tone="neutral">
                  {t('connectionStatusLabel')}:{' '}
                  {t(
                    `connectionStatuses.${source.connectionStatus}` as 'connectionStatuses.untested',
                  )}
                </Badge>
              ) : null}
              {source.lastSyncStatus ? (
                <Badge tone="neutral">
                  {tSync('lastSyncLabel')}:{' '}
                  {t(
                    `connectionStatuses.${source.lastSyncStatus}` as 'connectionStatuses.untested',
                  )}
                </Badge>
              ) : null}
              {source.lastSyncAt ? (
                <span className="text-[11px] text-ink-tertiary">
                  {t('lastSync')}: {new Date(source.lastSyncAt).toLocaleString()}
                </span>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              {canRunSync ? (
                <>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void onTestConnection()}
                    loading={testing}
                  >
                    <PlugZap className="h-3.5 w-3.5" aria-hidden="true" />
                    {t('testConnectionCta')}
                  </Button>
                  {source.adapter === 'manual_upload' ? (
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => setUploadOpen(true)}
                      disabled={syncing}
                    >
                      <Upload className="h-3.5 w-3.5" aria-hidden="true" />
                      {tSync('uploadCta')}
                    </Button>
                  ) : (
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => void onSyncNow()}
                      loading={syncing}
                      disabled={!source.isActive}
                    >
                      <PlayCircle className="h-3.5 w-3.5" aria-hidden="true" />
                      {tSync('syncNowCta')}
                    </Button>
                  )}
                </>
              ) : null}
              {canWrite && source.isActive ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setDisableOpen(true)}
                  disabled={disabling}
                >
                  <Power className="h-3.5 w-3.5" aria-hidden="true" />
                  {t('disableCta')}
                </Button>
              ) : null}
            </div>
          </div>

          {/* Test connection result */}
          {testResult ? (
            <Notice
              tone={
                testResult.status === 'ok'
                  ? 'success'
                  : testResult.status === 'auth_failed' || testResult.status === 'sheet_not_found'
                    ? 'error'
                    : 'info'
              }
            >
              <div className="flex flex-col gap-1">
                <span className="text-sm font-medium text-ink-primary">
                  {tSync('testResultTitle')}:{' '}
                  {t(`connectionStatuses.${testResult.status}` as 'connectionStatuses.untested')}
                </span>
                <span className="text-xs text-ink-secondary">{testResult.message}</span>
              </div>
            </Notice>
          ) : null}

          {/* Last sync result (manual run / upload). */}
          {lastRun && lastRun.snapshotId ? (
            <Notice
              tone={
                lastRun.status === 'success'
                  ? 'success'
                  : lastRun.status === 'failed'
                    ? 'error'
                    : 'info'
              }
            >
              <div className="flex flex-col gap-1">
                <span className="text-sm font-medium text-ink-primary">
                  {tSync(`lastRunTitle.${lastRun.status ?? 'partial'}` as 'lastRunTitle.success')}
                </span>
                <span className="text-xs text-ink-secondary">
                  {tSync('lastRunCounts', {
                    total: lastRun.total ?? 0,
                    imported: lastRun.imported ?? 0,
                    skipped: lastRun.skipped ?? 0,
                    errors: lastRun.errors ?? 0,
                  })}
                </span>
                {lastRun.resolvedTabName ? (
                  <span className="text-xs text-ink-tertiary">
                    {tSync('resolvedTab')}: {lastRun.resolvedTabName}
                  </span>
                ) : null}
                <Link
                  href={`/admin/partner-snapshots`}
                  className="text-xs font-medium text-brand-700 hover:underline"
                >
                  {tSync('openHistory')} →
                </Link>
              </div>
            </Notice>
          ) : null}

          {/* Edit form */}
          <PartnerSourceForm
            mode="edit"
            initial={source}
            onSubmit={onSave}
            onEraseCredentials={onEraseCredentials}
          />

          {/* Mapping builder — only meaningful after the source exists */}
          <PartnerMappingBuilder partnerSourceId={source.id} />

          {/* Disable confirmation */}
          <Modal
            open={disableOpen}
            title={t('disableConfirm.title')}
            onClose={() => (disabling ? undefined : setDisableOpen(false))}
            width="md"
            footer={
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setDisableOpen(false)}
                  disabled={disabling}
                >
                  {t('disableConfirm.cancel')}
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => void onDisable()}
                  loading={disabling}
                >
                  {t('disableConfirm.cta')}
                </Button>
              </>
            }
          >
            <p className="text-sm text-ink-primary">{t('disableConfirm.body')}</p>
          </Modal>

          {/* Upload CSV modal — only used when adapter='manual_upload' */}
          <Modal
            open={uploadOpen}
            title={tSync('upload.title')}
            onClose={() => (syncing ? undefined : setUploadOpen(false))}
            width="lg"
            footer={
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setUploadOpen(false)}
                  disabled={syncing}
                >
                  {tCommon('cancel')}
                </Button>
                <Button
                  size="sm"
                  onClick={() => void onSyncUpload()}
                  loading={syncing}
                  disabled={uploadCsv.trim().length === 0}
                >
                  <Upload className="h-3.5 w-3.5" aria-hidden="true" />
                  {tSync('upload.cta')}
                </Button>
              </>
            }
          >
            <div className="flex flex-col gap-2">
              <p className="text-sm text-ink-secondary">{tSync('upload.body')}</p>
              <Field label={tSync('upload.csvLabel')} hint={tSync('upload.csvHelper')} required>
                <Textarea
                  value={uploadCsv}
                  onChange={(e) => setUploadCsv(e.target.value)}
                  rows={12}
                  placeholder={tSync('upload.csvPlaceholder')}
                  required
                />
              </Field>
            </div>
          </Modal>
        </>
      )}
    </div>
  );
}
