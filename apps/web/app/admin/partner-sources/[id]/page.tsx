'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertOctagon, ArrowLeft, PlugZap, Power } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { useToast } from '@/components/ui/toast';
import { PartnerMappingBuilder } from '@/components/admin/partner-sources/partner-mapping-builder';
import { PartnerSourceForm } from '@/components/admin/partner-sources/partner-source-form';
import { ApiError, partnerSourcesApi } from '@/lib/api';
import type { PartnerSourceRow, PartnerTestConnectionResult } from '@/lib/api-types';
import { hasCapability } from '@/lib/auth';

/**
 * Phase D4 — D4.2: Partner Source detail page.
 *
 * Sections:
 *   • Header with status badges + "Test connection" stub + Disable
 *     button
 *   • Source-config form (re-saves on submit)
 *   • Mapping builder
 *
 * The "Test connection" button is a STUB in D4.2 — it validates
 * config shape only and surfaces a clear "real probe lands in D4.3"
 * message. Real adapter probes ship with the sync engine.
 */
export default function PartnerSourceDetailPage(): JSX.Element {
  const params = useParams();
  const router = useRouter();
  const t = useTranslations('admin.partnerSources');
  const tForm = useTranslations('admin.partnerSources.form');
  const { toast } = useToast();

  const canRead = hasCapability('partner.source.read');
  const canWrite = hasCapability('partner.source.write');

  const id = typeof params['id'] === 'string' ? params['id'] : '';

  const [source, setSource] = useState<PartnerSourceRow | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<PartnerTestConnectionResult | null>(null);
  const [testing, setTesting] = useState<boolean>(false);
  const [disabling, setDisabling] = useState<boolean>(false);
  const [disableOpen, setDisableOpen] = useState<boolean>(false);

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
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setTesting(false);
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
          <Link href="/admin/partner-sources">
            <Button variant="ghost" size="sm">
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
              {t('backCta')}
            </Button>
          </Link>
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
            </div>
            <div className="flex items-center gap-2">
              {canWrite ? (
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
                  {source.isActive ? (
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
                </>
              ) : null}
            </div>
          </div>

          {/* Stub "Test connection" result */}
          {testResult ? (
            <Notice tone="info">
              <div className="flex flex-col gap-1">
                <span className="text-sm font-medium text-ink-primary">
                  {t('testConnection.stubTitle')}
                </span>
                <span className="text-xs text-ink-secondary">{testResult.message}</span>
                {testResult.configIssues.length > 0 ? (
                  <ul className="ms-4 mt-1 list-disc text-xs text-status-warning">
                    {testResult.configIssues.map((issue) => (
                      <li key={issue}>
                        <AlertOctagon
                          className="me-1 inline h-3 w-3 align-text-bottom"
                          aria-hidden="true"
                        />
                        {issue}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <span className="text-xs text-ink-tertiary">{t('testConnection.noIssues')}</span>
                )}
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
        </>
      )}
    </div>
  );
}
