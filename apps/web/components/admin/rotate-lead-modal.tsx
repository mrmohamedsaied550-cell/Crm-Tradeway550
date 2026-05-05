'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowRightLeft } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Field, Select, Textarea } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Notice } from '@/components/ui/notice';
import type { AdminUser, HandoverMode } from '@/lib/api-types';
import { cn } from '@/lib/utils';

/**
 * Phase D3 — D3.4: rotate-lead confirmation modal.
 *
 * Three handover modes presented as radio CARDS (not a plain select)
 * because each mode has materially different consequences and a
 * one-line label can't carry the operational nuance:
 *
 *   • Full Transfer    — operational history preserved server-side;
 *                        sales-agent visibility still gated by
 *                        D2.6 rules. Default selection.
 *   • Summary Transfer — TL writes a short note; the new owner sees
 *                        the gist, not the transcript.
 *   • Clean Transfer   — new owner starts fresh. Pending follow-ups
 *                        owned by the prior agent are cancelled with
 *                        a forensic flag.
 *
 * Target picker is a simple dropdown of active users in scope (the
 * parent passes `eligibleUsers`). When omitted, the rotation routes
 * via the distribution engine.
 *
 * Capability gating happens at the parent level (Rotate CTA only
 * renders when `hasCapability('lead.rotate')`); this modal trusts
 * the parent to have made that check and renders only the
 * confirmation UX.
 */
export function RotateLeadModal({
  open,
  leadName,
  currentOwnerName,
  eligibleUsers,
  submitting,
  error,
  onConfirm,
  onClose,
}: {
  open: boolean;
  leadName: string;
  currentOwnerName: string | null;
  /** Active users in scope. Empty list = "Auto via route engine"
   *  is the only option. */
  eligibleUsers: ReadonlyArray<AdminUser>;
  submitting: boolean;
  error: string | null;
  onConfirm: (input: {
    handoverMode: HandoverMode;
    toUserId?: string;
    reasonCode?: string;
    notes?: string;
  }) => void;
  onClose: () => void;
}): JSX.Element {
  const t = useTranslations('admin.leads.detail.rotate');
  const tCommon = useTranslations('admin.common');

  const [mode, setMode] = useState<HandoverMode>('full');
  const [toUserId, setToUserId] = useState<string>(''); // '' = auto via route engine
  const [notes, setNotes] = useState<string>('');
  const [reasonCode, setReasonCode] = useState<string>('');

  useEffect(() => {
    if (!open) {
      setMode('full');
      setToUserId('');
      setNotes('');
      setReasonCode('');
    }
  }, [open]);

  function onSubmit(): void {
    onConfirm({
      handoverMode: mode,
      ...(toUserId && { toUserId }),
      ...(reasonCode.trim() && { reasonCode: reasonCode.trim() }),
      ...(notes.trim() && { notes: notes.trim() }),
    });
  }

  return (
    <Modal
      open={open}
      onClose={submitting ? () => {} : onClose}
      title={t('title')}
      width="lg"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={submitting}>
            {tCommon('cancel')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={onSubmit}
            loading={submitting}
            disabled={submitting}
          >
            <ArrowRightLeft className="h-3.5 w-3.5" aria-hidden="true" />
            {t('confirm')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-sm text-ink-primary">{t('body', { name: leadName })}</p>
        {currentOwnerName ? (
          <p className="text-xs text-ink-tertiary">
            {t('currentOwner', { name: currentOwnerName })}
          </p>
        ) : (
          <p className="text-xs text-ink-tertiary italic">{t('currentOwnerNone')}</p>
        )}

        {/* Handover mode picker — radio cards */}
        <fieldset className="flex flex-col gap-2">
          <legend className="text-xs font-semibold uppercase tracking-wide text-ink-tertiary">
            {t('handoverMode.legend')}
          </legend>
          {(['full', 'summary', 'clean'] as const).map((m) => (
            <label
              key={m}
              className={cn(
                'flex cursor-pointer items-start gap-2 rounded-md border p-3 text-sm',
                mode === m
                  ? 'border-brand-600 bg-brand-50'
                  : 'border-surface-border bg-surface-card hover:bg-surface',
              )}
            >
              <input
                type="radio"
                name="rotate-handover-mode"
                value={m}
                checked={mode === m}
                onChange={() => setMode(m)}
                disabled={submitting}
                className="mt-1"
              />
              <span className="flex flex-col gap-0.5">
                <span className="font-medium text-ink-primary">
                  {t(`handoverMode.${m}.title` as 'handoverMode.full.title')}
                </span>
                <span className="text-[12px] text-ink-secondary">
                  {t(`handoverMode.${m}.help` as 'handoverMode.full.help')}
                </span>
              </span>
            </label>
          ))}
        </fieldset>

        <Field label={t('targetLabel')} hint={t('targetHint')}>
          <Select
            value={toUserId}
            onChange={(e) => setToUserId(e.target.value)}
            disabled={submitting}
          >
            <option value="">{t('targetAuto')}</option>
            {eligibleUsers.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field label={t('reasonLabel')} hint={t('reasonHint')}>
          <input
            type="text"
            value={reasonCode}
            onChange={(e) => setReasonCode(e.target.value)}
            maxLength={64}
            disabled={submitting}
            placeholder="capacity_balance"
            className="w-full rounded-md border border-surface-border bg-surface-card px-3 py-2 text-sm text-ink-primary placeholder:text-ink-tertiary focus:border-brand-600 focus:outline-none"
          />
        </Field>

        <Field label={t('notesLabel')} hint={t('notesHint')}>
          <Textarea
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            maxLength={1000}
            disabled={submitting}
          />
        </Field>

        <Notice tone="info">{t('warning')}</Notice>
        {error ? <Notice tone="error">{error}</Notice> : null}
      </div>
    </Modal>
  );
}
