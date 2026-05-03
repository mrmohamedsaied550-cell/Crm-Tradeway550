'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Notice } from '@/components/ui/notice';
import { ApiError } from '@/lib/api';
import type { FollowUpActionType } from '@/lib/api-types';

/**
 * Phase B — B1: minimal "+ Follow-up" picker invoked from the lead
 * detail page.
 *
 * Returns `{ actionType, dueAt (ISO), note? }` via `onConfirm` so the
 * caller owns the API call + re-render. The modal validates `> now`
 * before firing the callback so the agent can't schedule a follow-up
 * in the past — server would reject anyway, but failing in the UI
 * keeps the loop fast.
 *
 * Defaults: Call · today · "in 1 hour" (rounded to the nearest 15 min).
 */
const ACTION_TYPES: readonly FollowUpActionType[] = ['call', 'whatsapp', 'visit', 'other'];

export interface FollowUpQuickInput {
  actionType: FollowUpActionType;
  dueAt: string;
  note?: string;
}

interface FollowUpQuickModalProps {
  open: boolean;
  /** Display name of the lead — shown in the modal title. */
  leadName?: string;
  onConfirm: (input: FollowUpQuickInput) => Promise<void> | void;
  onClose: () => void;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function defaultTime(): string {
  const d = new Date(Date.now() + 60 * 60 * 1000);
  d.setMinutes(Math.round(d.getMinutes() / 15) * 15, 0, 0);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function FollowUpQuickModal({
  open,
  leadName,
  onConfirm,
  onClose,
}: FollowUpQuickModalProps): JSX.Element {
  const t = useTranslations('admin.leads.detail.followUpModal');
  const tTypes = useTranslations('agent.workspace.followUps.types');
  const tCommon = useTranslations('admin.common');

  const [actionType, setActionType] = useState<FollowUpActionType>('call');
  const [date, setDate] = useState<string>(todayIso());
  const [time, setTime] = useState<string>(defaultTime());
  const [note, setNote] = useState<string>('');
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Reset on open.
  useEffect(() => {
    if (!open) return;
    setActionType('call');
    setDate(todayIso());
    setTime(defaultTime());
    setNote('');
    setError(null);
  }, [open]);

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (!date || !time) {
      setError(t('errors.invalid'));
      return;
    }
    const target = new Date(`${date}T${time}:00`);
    if (Number.isNaN(target.getTime())) {
      setError(t('errors.invalid'));
      return;
    }
    if (target.getTime() <= Date.now()) {
      setError(t('errors.inPast'));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onConfirm({
        actionType,
        dueAt: target.toISOString(),
        ...(note.trim().length > 0 && { note: note.trim() }),
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      title={leadName ? t('titleNamed', { name: leadName }) : t('title')}
      onClose={onClose}
      width="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            {tCommon('cancel')}
          </Button>
          <Button type="submit" form="followUpQuickForm" loading={submitting}>
            {t('save')}
          </Button>
        </>
      }
    >
      <form id="followUpQuickForm" className="flex flex-col gap-3" onSubmit={onSubmit}>
        {error ? <Notice tone="error">{error}</Notice> : null}
        <p className="text-sm text-ink-secondary">{t('intro')}</p>

        <Field label={t('actionType')} required>
          <Select
            value={actionType}
            onChange={(e) => setActionType(e.target.value as FollowUpActionType)}
            required
          >
            {ACTION_TYPES.map((a) => (
              <option key={a} value={a}>
                {tTypes(a)}
              </option>
            ))}
          </Select>
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label={t('date')} required>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          </Field>
          <Field label={t('time')} required>
            <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} required />
          </Field>
        </div>

        <Field label={t('note')} hint={t('noteHint')}>
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
            rows={2}
            placeholder={t('notePlaceholder')}
          />
        </Field>
      </form>
    </Modal>
  );
}
