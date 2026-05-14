'use client';

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { CheckCircle2, Circle, FileText, RotateCcw, XCircle } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Input, Textarea, Select } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import { useToast } from '@/components/ui/toast';
import {
  ApiError,
  LEAD_DOCUMENT_DEFAULT_TYPES,
  leadDocumentsApi,
  type LeadDocumentRow,
  type LeadDocumentStatus,
} from '@/lib/api';
import { hasCapability } from '@/lib/auth';
import type { Lead } from '@/lib/api-types';
import { cn } from '@/lib/utils';

/**
 * Sprint 12 (D12) — Lead Documents action panel.
 *
 * Sits inside the Add Action drawer's Documents area. Shows the
 * signup-stage required documents (national ID / driving licence /
 * vehicle licence / profile photo) plus any extra "other" rows
 * the operator added. Metadata-only on Sprint 12 — there is no
 * binary upload yet, so the UI captures a free-text file name to
 * record receipt without faking storage.
 *
 * Status palette mirrors the rest of the admin surface:
 *   missing             = neutral / gray
 *   uploaded            = info / blue
 *   accepted            = healthy / green
 *   rejected            = breach / red
 *   needs_resubmission  = warning / amber
 *
 * Capability gates (server-side enforces; UI hides what the user
 * cannot perform):
 *   lead.document.read   — render the panel rows.
 *   lead.document.write  — record + edit metadata.
 *   lead.document.accept — accept button (status → accepted).
 *   lead.document.reject — reject / needs_resubmission buttons
 *                          (status → rejected | needs_resubmission;
 *                          require non-empty rejection reason).
 */

interface DocumentsActionPanelProps {
  lead: Lead;
  onClose: () => void;
  /** Fired after a successful write so the parent can refresh
   *  Lead Detail counters / timeline. */
  onApplied?: () => void;
}

const STATUS_TONE: Record<
  LeadDocumentStatus,
  'neutral' | 'info' | 'healthy' | 'breach' | 'warning'
> = {
  missing: 'neutral',
  uploaded: 'info',
  accepted: 'healthy',
  rejected: 'breach',
  needs_resubmission: 'warning',
};

const STATUS_ICON: Record<LeadDocumentStatus, typeof CheckCircle2> = {
  missing: Circle,
  uploaded: FileText,
  accepted: CheckCircle2,
  rejected: XCircle,
  needs_resubmission: RotateCcw,
};

export function DocumentsActionPanel({
  lead,
  onClose,
  onApplied,
}: DocumentsActionPanelProps): JSX.Element {
  const t = useTranslations('admin.leads.detail.addAction.areas.documents');
  const tCommon = useTranslations('admin.common');
  const { toast } = useToast();

  const canRead = hasCapability('lead.document.read');
  const canWrite = hasCapability('lead.document.write');
  const canAccept = hasCapability('lead.document.accept');
  const canReject = hasCapability('lead.document.reject');

  const [rows, setRows] = useState<readonly LeadDocumentRow[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [rejectTarget, setRejectTarget] = useState<{
    row: LeadDocumentRow;
    mode: 'rejected' | 'needs_resubmission';
  } | null>(null);
  const [rejectReason, setRejectReason] = useState<string>('');
  const [addType, setAddType] = useState<string>('national_id');
  const [addFileName, setAddFileName] = useState<string>('');
  const [addLabel, setAddLabel] = useState<string>('');
  const [addPending, setAddPending] = useState<boolean>(false);

  const refresh = useCallback(async (): Promise<void> => {
    if (!canRead) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await leadDocumentsApi.listForLead(lead.id);
      setRows(data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [lead.id, canRead]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Synthesise missing rows for required types so the operator
  // sees a complete signup checklist even before any DB row
  // exists. Real rows take precedence — a `national_id` with
  // status `accepted` replaces the placeholder.
  const merged = useMemo<readonly (LeadDocumentRow | PlaceholderRow)[]>(() => {
    const realByType = new Map<string, LeadDocumentRow>();
    for (const r of rows) {
      // Keep the most recent row per type.
      const existing = realByType.get(r.type);
      if (!existing || new Date(r.createdAt) > new Date(existing.createdAt)) {
        realByType.set(r.type, r);
      }
    }
    const out: (LeadDocumentRow | PlaceholderRow)[] = [];
    for (const type of LEAD_DOCUMENT_DEFAULT_TYPES) {
      out.push(realByType.get(type) ?? { kind: 'placeholder', type });
    }
    for (const r of rows) {
      if (!(LEAD_DOCUMENT_DEFAULT_TYPES as readonly string[]).includes(r.type)) out.push(r);
    }
    return out;
  }, [rows]);

  async function onAddOrMarkUploaded(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (!canWrite || addPending) return;
    setAddPending(true);
    setError(null);
    try {
      await leadDocumentsApi.create(lead.id, {
        type: addType,
        status: addFileName.trim().length > 0 ? 'uploaded' : 'missing',
        ...(addFileName.trim().length > 0 ? { fileName: addFileName.trim() } : {}),
        ...(addLabel.trim().length > 0 ? { label: addLabel.trim() } : {}),
      });
      toast({ tone: 'success', title: t('toast.added') });
      setAddFileName('');
      setAddLabel('');
      await refresh();
      onApplied?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setAddPending(false);
    }
  }

  async function onAccept(row: LeadDocumentRow): Promise<void> {
    if (!canAccept) return;
    setPendingId(row.id);
    setError(null);
    try {
      await leadDocumentsApi.update(lead.id, row.id, { status: 'accepted' });
      toast({ tone: 'success', title: t('toast.accepted') });
      await refresh();
      onApplied?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setPendingId(null);
    }
  }

  async function onMarkUploaded(row: LeadDocumentRow): Promise<void> {
    if (!canWrite) return;
    setPendingId(row.id);
    setError(null);
    try {
      await leadDocumentsApi.update(lead.id, row.id, { status: 'uploaded' });
      toast({ tone: 'success', title: t('toast.uploaded') });
      await refresh();
      onApplied?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setPendingId(null);
    }
  }

  async function onConfirmReject(): Promise<void> {
    if (!rejectTarget || !canReject) return;
    const reason = rejectReason.trim();
    if (reason.length === 0) return;
    setPendingId(rejectTarget.row.id);
    setError(null);
    try {
      await leadDocumentsApi.update(lead.id, rejectTarget.row.id, {
        status: rejectTarget.mode,
        rejectionReason: reason,
      });
      toast({
        tone: 'success',
        title:
          rejectTarget.mode === 'rejected' ? t('toast.rejected') : t('toast.needsResubmission'),
      });
      setRejectTarget(null);
      setRejectReason('');
      await refresh();
      onApplied?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setPendingId(null);
    }
  }

  if (!canRead) {
    return (
      <div className="flex flex-col gap-3">
        <Notice tone="info">
          <p className="text-sm font-medium">{t('noAccess.title')}</p>
          <p className="mt-1 text-xs text-ink-secondary">{t('noAccess.body')}</p>
        </Notice>
        <div className="flex justify-end">
          <Button variant="secondary" onClick={onClose}>
            {tCommon('close')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Notice tone="info">
        <p className="text-sm font-medium">{t('uploadGapTitle')}</p>
        <p className="mt-1 text-xs text-ink-secondary">{t('uploadGapBody')}</p>
      </Notice>

      {error ? <Notice tone="error">{error}</Notice> : null}

      <section className="flex flex-col gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-tertiary">
          {t('listHeading')}
        </h3>
        {loading ? (
          <p className="text-sm text-ink-secondary">{tCommon('loading')}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {merged.map((entry) => {
              const isPlaceholder = 'kind' in entry;
              const type = isPlaceholder ? entry.type : entry.type;
              const status: LeadDocumentStatus = isPlaceholder ? 'missing' : entry.status;
              const Icon = STATUS_ICON[status];
              const tone = STATUS_TONE[status];
              const row = isPlaceholder ? null : (entry as LeadDocumentRow);
              const isBusy = row !== null && pendingId === row.id;
              return (
                <li
                  key={isPlaceholder ? `placeholder:${type}` : entry.id}
                  className={cn(
                    'rounded-md border bg-surface-card p-3 shadow-card',
                    status === 'rejected'
                      ? 'border-status-breach/30'
                      : status === 'needs_resubmission'
                        ? 'border-status-warning/30'
                        : 'border-surface-border',
                  )}
                >
                  <header className="flex flex-wrap items-center gap-2">
                    <Icon
                      className={cn(
                        'h-4 w-4',
                        status === 'accepted'
                          ? 'text-status-healthy'
                          : status === 'rejected'
                            ? 'text-status-breach'
                            : status === 'needs_resubmission'
                              ? 'text-status-warning'
                              : status === 'uploaded'
                                ? 'text-status-info'
                                : 'text-ink-tertiary',
                      )}
                      aria-hidden="true"
                    />
                    <span className="text-sm font-medium text-ink-primary">
                      {labelOf(type, row?.label ?? null, t)}
                    </span>
                    <Badge tone={tone}>{t(`states.${status}`)}</Badge>
                    {row?.fileName ? (
                      <span className="truncate text-xs text-ink-tertiary">{row.fileName}</span>
                    ) : null}
                  </header>
                  {row?.rejectionReason ? (
                    <p className="mt-2 text-xs text-status-breach">
                      <span className="font-semibold">{t('reasonLabel')}: </span>
                      {row.rejectionReason}
                    </p>
                  ) : null}
                  {row?.note ? <p className="mt-1 text-xs text-ink-secondary">{row.note}</p> : null}
                  {row ? (
                    <p className="mt-1 text-[11px] text-ink-tertiary">
                      {row.uploadedBy ? t('uploadedBy', { name: row.uploadedBy.name }) : null}
                      {row.reviewedBy
                        ? ` · ${t('reviewedBy', { name: row.reviewedBy.name })}`
                        : null}
                    </p>
                  ) : null}
                  {/* Action row — only when the user can perform something. */}
                  {row ? (
                    <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
                      {canWrite && status !== 'uploaded' && status !== 'accepted' ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => void onMarkUploaded(row)}
                          disabled={isBusy}
                        >
                          {t('actions.markUploaded')}
                        </Button>
                      ) : null}
                      {canAccept && status !== 'accepted' ? (
                        <Button
                          size="sm"
                          variant="primary"
                          onClick={() => void onAccept(row)}
                          disabled={isBusy}
                        >
                          {t('actions.accept')}
                        </Button>
                      ) : null}
                      {canReject ? (
                        <>
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => {
                              setRejectTarget({ row, mode: 'needs_resubmission' });
                              setRejectReason('');
                            }}
                            disabled={isBusy}
                          >
                            {t('actions.needsResubmission')}
                          </Button>
                          {status !== 'rejected' ? (
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => {
                                setRejectTarget({ row, mode: 'rejected' });
                                setRejectReason('');
                              }}
                              disabled={isBusy}
                            >
                              {t('actions.reject')}
                            </Button>
                          ) : null}
                        </>
                      ) : null}
                      {!canWrite && !canAccept && !canReject ? (
                        <span className="text-[11px] italic text-ink-tertiary">
                          {t('viewOnly')}
                        </span>
                      ) : null}
                    </div>
                  ) : canWrite ? (
                    <p className="mt-2 text-[11px] text-ink-tertiary">{t('placeholderHint')}</p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {canWrite ? (
        <form
          onSubmit={(e) => void onAddOrMarkUploaded(e)}
          className="flex flex-col gap-3 rounded-md border border-dashed border-surface-border bg-surface p-3"
        >
          <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-tertiary">
            {t('addHeading')}
          </h3>
          <Field label={t('form.type')}>
            <Select value={addType} onChange={(e) => setAddType(e.target.value)}>
              {LEAD_DOCUMENT_DEFAULT_TYPES.map((tk) => (
                <option key={tk} value={tk}>
                  {t(`types.${tk}`)}
                </option>
              ))}
              <option value="other">{t('types.other')}</option>
            </Select>
          </Field>
          {addType === 'other' ? (
            <Field label={t('form.label')}>
              <Input value={addLabel} onChange={(e) => setAddLabel(e.target.value)} />
            </Field>
          ) : null}
          <Field label={t('form.fileName')} hint={t('form.fileNameHint')}>
            <Input
              value={addFileName}
              onChange={(e) => setAddFileName(e.target.value)}
              placeholder={t('form.fileNamePlaceholder')}
            />
          </Field>
          <div className="flex items-center justify-end gap-2">
            <Button type="submit" loading={addPending} disabled={!canWrite}>
              {t('actions.add')}
            </Button>
          </div>
        </form>
      ) : null}

      {rejectTarget ? (
        <div className="rounded-md border border-status-warning/40 bg-status-warning/5 p-3">
          <h4 className="text-sm font-semibold text-ink-primary">
            {rejectTarget.mode === 'rejected'
              ? t('rejectModal.titleReject')
              : t('rejectModal.titleNeedsResubmission')}
          </h4>
          <p className="mt-1 text-xs text-ink-secondary">{t('rejectModal.reasonHint')}</p>
          <Textarea
            className="mt-2 w-full"
            rows={3}
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder={t('rejectModal.placeholder')}
          />
          <div className="mt-3 flex items-center justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setRejectTarget(null);
                setRejectReason('');
              }}
            >
              {tCommon('cancel')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => void onConfirmReject()}
              disabled={rejectReason.trim().length === 0}
              loading={pendingId === rejectTarget.row.id}
            >
              {tCommon('save')}
            </Button>
          </div>
        </div>
      ) : null}

      <div className="flex items-center justify-end">
        <Button variant="secondary" onClick={onClose}>
          {tCommon('close')}
        </Button>
      </div>
    </div>
  );
}

interface PlaceholderRow {
  kind: 'placeholder';
  type: string;
}

function labelOf(
  type: string,
  customLabel: string | null,
  t: ReturnType<typeof useTranslations>,
): string {
  if (customLabel) return customLabel;
  if ((LEAD_DOCUMENT_DEFAULT_TYPES as readonly string[]).includes(type)) {
    return t(`types.${type}` as 'types.national_id');
  }
  return t('types.other');
}
