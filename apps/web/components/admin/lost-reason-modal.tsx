'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useTranslations, useLocale } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Field, Select, Textarea } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Notice } from '@/components/ui/notice';
import { ApiError, lostReasonsApi } from '@/lib/api';
import type { LostReason } from '@/lib/api-types';

/**
 * Phase A — A6: prompts the agent for a lost reason + optional note
 * before the actual stage move fires.
 *
 * The lost reason picker is loaded on mount from
 * `lostReasonsApi.listActive()` (already capability-gated to
 * `lead.read`). The picker renders the EN or AR label depending on
 * the active locale; the underlying `id` is what gets submitted.
 *
 * The modal does NOT call moveStage itself — it returns the
 * `{ lostReasonId, lostNote }` payload via `onConfirm`. The caller
 * is responsible for the API call so error handling (toast, rollback,
 * etc.) lives at one level.
 */
export interface LostReasonResult {
  lostReasonId: string;
  lostNote?: string;
}

interface LostReasonModalProps {
  open: boolean;
  /** Display name of the lead being lost. Shown in the title. */
  leadName?: string;
  /** Pre-loaded reasons; when omitted the modal fetches them itself. */
  reasons?: readonly LostReason[];
  onConfirm: (result: LostReasonResult) => Promise<void> | void;
  onClose: () => void;
}

export function LostReasonModal({
  open,
  leadName,
  reasons: reasonsProp,
  onConfirm,
  onClose,
}: LostReasonModalProps): JSX.Element {
  const t = useTranslations('admin.leads.lostReasonModal');
  const tCommon = useTranslations('admin.common');
  const locale = useLocale();

  const [reasons, setReasons] = useState<readonly LostReason[]>(reasonsProp ?? []);
  const [loadingReasons, setLoadingReasons] = useState<boolean>(!reasonsProp);
  const [reasonId, setReasonId] = useState<string>('');
  const [note, setNote] = useState<string>('');
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Reset state every time the modal opens.
  useEffect(() => {
    if (!open) return;
    setReasonId('');
    setNote('');
    setError(null);
  }, [open]);

  // Lazily load reasons when not provided. Loading happens on open
  // so closed-but-mounted modals don't fire pointless requests.
  useEffect(() => {
    if (!open || reasonsProp) return;
    setLoadingReasons(true);
    void (async () => {
      try {
        const r = await lostReasonsApi.listActive();
        setReasons(r);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : String(err));
      } finally {
        setLoadingReasons(false);
      }
    })();
  }, [open, reasonsProp]);

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (!reasonId) {
      setError(t('errors.reasonRequired'));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onConfirm({
        lostReasonId: reasonId,
        ...(note.trim().length > 0 && { lostNote: note.trim() }),
      });
      // Caller should close on success; we don't auto-close here so
      // the caller can keep the modal open if it needs to surface
      // a server-side error after onConfirm returns.
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  const labelOf = (r: LostReason): string => (locale === 'ar' ? r.labelAr : r.labelEn);

  return (
    <Modal
      open={open}
      title={leadName ? t('titleNamed', { name: leadName }) : t('title')}
      onClose={onClose}
      width="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {tCommon('cancel')}
          </Button>
          <Button type="submit" form="lostReasonForm" loading={submitting} disabled={!reasonId}>
            {t('confirm')}
          </Button>
        </>
      }
    >
      <form id="lostReasonForm" className="flex flex-col gap-3" onSubmit={onSubmit}>
        {error ? <Notice tone="error">{error}</Notice> : null}
        <p className="text-sm text-ink-secondary">{t('intro')}</p>

        <Field label={t('reason')} required>
          <Select
            value={reasonId}
            onChange={(e) => setReasonId(e.target.value)}
            disabled={loadingReasons || reasons.length === 0}
            required
          >
            <option value="">{loadingReasons ? tCommon('loading') : tCommon('select')}</option>
            {reasons.map((r) => (
              <option key={r.id} value={r.id}>
                {labelOf(r)}
              </option>
            ))}
          </Select>
        </Field>

        <Field label={t('note')} hint={t('noteHint')}>
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
            rows={3}
            placeholder={t('notePlaceholder')}
          />
        </Field>
      </form>
    </Modal>
  );
}
