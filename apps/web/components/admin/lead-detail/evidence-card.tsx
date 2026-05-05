'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ClipboardList, FileText, Loader2, Paperclip } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { ApiError, partnerVerificationApi } from '@/lib/api';
import type { LeadEvidenceRow } from '@/lib/api-types';
import { hasCapability } from '@/lib/auth';

/**
 * Phase D4 — D4.8: EvidenceCard on Lead Detail.
 *
 * Read-only list of `LeadEvidence` rows attached to the lead.
 * Surfaces what merges / evidence-only attaches have happened
 * historically — the missing visual loop the UX audit flagged
 * before D4.8. Returns `null` for callers without
 * `partner.verification.read` (sales agents in D4) so the
 * section is invisible to them.
 *
 * NEVER renders raw JSON, snapshot ids, or credentials. Each row
 * shows: kind, captured-by, created time, optional notes excerpt,
 * partner snapshot/record id (compact, monospaced) when available.
 */
export function EvidenceCard({ leadId }: { leadId: string }): JSX.Element | null {
  const t = useTranslations('admin.leads.detail.evidenceCard');
  const tCommon = useTranslations('admin.common');

  const canRead = hasCapability('partner.verification.read');

  const [rows, setRows] = useState<LeadEvidenceRow[]>([]);
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
      const result = await partnerVerificationApi.evidence(leadId);
      setRows(result);
      setFeatureDisabled(false);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'partner.feature.disabled') {
        setFeatureDisabled(true);
        setRows([]);
      } else {
        setError(err instanceof ApiError ? err.message : String(err));
      }
    } finally {
      setLoading(false);
    }
  }, [canRead, leadId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (!canRead) return null;

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-surface-border bg-surface-card p-4 shadow-card">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-base font-semibold text-ink-primary">
          <ClipboardList className="h-4 w-4 text-brand-700" aria-hidden="true" />
          {t('title')}
        </h2>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void reload()}
          disabled={loading || featureDisabled}
        >
          {tCommon('refresh')}
        </Button>
      </header>

      {featureDisabled ? <Notice tone="info">{t('featureDisabled')}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}

      {loading ? (
        <p className="flex items-center gap-2 text-sm text-ink-tertiary">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          {t('loading')}
        </p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-ink-tertiary">{t('emptyBody')}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => (
            <li key={row.id}>
              <EvidenceRow row={row} t={t} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function EvidenceRow({
  row,
  t,
}: {
  row: LeadEvidenceRow;
  t: ReturnType<typeof useTranslations>;
}): JSX.Element {
  const created = new Date(row.createdAt);
  const noteExcerpt =
    row.notes && row.notes.length > 200 ? `${row.notes.slice(0, 200)}…` : row.notes;
  return (
    <article className="flex flex-col gap-2 rounded-md border border-surface-border bg-surface px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex items-center gap-2">
          <Badge tone="info">
            {row.kind === 'partner_record' ? (
              <Paperclip className="me-1 h-3 w-3" aria-hidden="true" />
            ) : (
              <FileText className="me-1 h-3 w-3" aria-hidden="true" />
            )}
            {t(`kind.${row.kind}` as 'kind.partner_record')}
          </Badge>
          {row.capturedBy ? (
            <span className="text-xs text-ink-tertiary">
              {t('byLabel')}: {row.capturedBy.name}
            </span>
          ) : null}
        </div>
        <span className="text-xs text-ink-tertiary" title={created.toISOString()}>
          {created.toLocaleString()}
        </span>
      </div>

      {/* File evidence (manual_upload, screenshots in later phases). */}
      {row.fileName ? (
        <p className="text-xs text-ink-secondary">
          <span className="font-medium">{t('fileLabel')}:</span> {row.fileName}
          {row.sizeBytes !== null ? ` · ${formatBytes(row.sizeBytes)}` : ''}
        </p>
      ) : null}

      {/* Partner snapshot/record references (compact). NEVER renders
          raw JSON or full payloads. */}
      {row.partnerSnapshotId || row.partnerRecordId ? (
        <dl className="grid grid-cols-1 gap-1 text-[11px] sm:grid-cols-2">
          {row.partnerSnapshotId ? (
            <RefField label={t('snapshotIdLabel')} value={row.partnerSnapshotId} />
          ) : null}
          {row.partnerRecordId ? (
            <RefField label={t('recordIdLabel')} value={row.partnerRecordId} />
          ) : null}
        </dl>
      ) : null}

      {noteExcerpt ? (
        <p className="rounded-md bg-surface-card px-2 py-1 text-xs text-ink-secondary">
          <span className="font-medium text-ink-primary">{t('notesLabel')}:</span> {noteExcerpt}
        </p>
      ) : null}
    </article>
  );
}

function RefField({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex flex-col">
      <dt className="uppercase tracking-wide text-ink-tertiary">{label}</dt>
      <dd className="font-mono text-ink-secondary break-all">{value}</dd>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
