'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Database, Download, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { useToast } from '@/components/ui/toast';
import { ApiError, backupApi } from '@/lib/api';
import { hasCapability } from '@/lib/auth';

/**
 * P3-07 — admin backup + export page.
 *
 * Single button: "Download tenant export". Calls the server endpoint
 * (gated on `tenant.export`) and saves the response as a JSON file.
 * Sensitive fields are stripped server-side.
 *
 * Capability check is best-effort on the client (the server is the
 * authoritative gate); when the user lacks the capability we still
 * render the page but disable the button + show a hint.
 */
export default function AdminBackupPage(): JSX.Element {
  const t = useTranslations('admin.backup');
  const { toast } = useToast();
  const [busy, setBusy] = useState<boolean>(false);
  const [summary, setSummary] = useState<{
    exportedAt: string;
    counts: Record<string, number>;
  } | null>(null);

  const allowed = hasCapability('tenant.export');

  async function onDownload(): Promise<void> {
    setBusy(true);
    try {
      const dump = await backupApi.exportTenant();
      // Trigger a browser download. We use a Blob URL so the JSON
      // never hits a server-rendered file path.
      const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `crm-tradeway-${dump.tenant.code}-${dump.exportedAt.replace(/[:.]/g, '-')}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setSummary({ exportedAt: dump.exportedAt, counts: dump.counts });
      toast({ tone: 'success', title: t('downloaded') });
    } catch (err) {
      toast({
        tone: 'error',
        title: err instanceof ApiError ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  }

  const totalRows = summary ? Object.values(summary.counts).reduce((a, b) => a + b, 0) : 0;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={t('title')} subtitle={t('subtitle')} />

      {!allowed ? <Notice tone="error">{t('forbidden')}</Notice> : null}

      <section className="flex flex-col gap-3 rounded-lg border border-surface-border bg-surface-card p-4 shadow-card">
        <header className="flex items-center gap-2">
          <span className="inline-flex h-9 w-9 items-center justify-center rounded-md bg-brand-600/10 text-brand-700">
            <Database className="h-5 w-5" aria-hidden="true" />
          </span>
          <div className="flex flex-col leading-tight">
            <h2 className="text-sm font-semibold text-ink-primary">{t('cardTitle')}</h2>
            <p className="text-xs text-ink-secondary">{t('cardBody')}</p>
          </div>
        </header>
        <ul className="ms-2 list-disc space-y-0.5 text-xs text-ink-secondary">
          <li>{t('includes.leads')}</li>
          <li>{t('includes.captains')}</li>
          <li>{t('includes.whatsapp')}</li>
          <li>{t('includes.bonuses')}</li>
        </ul>
        <p className="text-xs text-ink-tertiary">{t('stripped')}</p>
        <div>
          <Button onClick={() => void onDownload()} disabled={!allowed || busy}>
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Download className="h-4 w-4" aria-hidden="true" />
            )}
            {t('downloadButton')}
          </Button>
        </div>
        {summary ? (
          <div className="mt-2 rounded-md border border-surface-border bg-surface p-3 text-xs">
            <p className="font-semibold text-ink-primary">
              {t('lastSummary', {
                rows: totalRows,
                at: new Date(summary.exportedAt).toLocaleString(),
              })}
            </p>
            <ul className="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5 text-ink-secondary sm:grid-cols-3">
              {Object.entries(summary.counts).map(([k, v]) => (
                <li key={k}>
                  <span className="font-mono">{k}</span>: {v}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <Notice tone="info">{t('opsHint')}</Notice>
    </div>
  );
}
