'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Notice } from '@/components/ui/notice';
import { ApiError } from '@/lib/api';

/**
 * Phase A — A7: snooze picker for follow-ups.
 *
 * Returns the chosen `snoozedUntil` (ISO timestamp, in the future) via
 * `onConfirm` so the caller owns the API call + re-render. Pass
 * `null` to clear an existing snooze.
 *
 * Presets cover the common "push it forward" durations (1h, 3h,
 * tomorrow 9 AM); a custom date+time falls back to the native pickers
 * for everything else. The modal validates `> now` before firing the
 * callback so we never round-trip to the server with a known-bad
 * timestamp.
 */
type Preset = '1h' | '3h' | 'tomorrow9' | 'custom';

interface SnoozeModalProps {
  open: boolean;
  /** Display name of the lead the follow-up belongs to (modal title). */
  leadName?: string;
  /** Current snoozedUntil — drives the "Clear snooze" button. */
  currentlySnoozed?: boolean;
  onConfirm: (snoozedUntil: string | null) => Promise<void> | void;
  onClose: () => void;
}

function plusHours(n: number): Date {
  return new Date(Date.now() + n * 60 * 60 * 1000);
}

function tomorrowAt9(): Date {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function isoLocalDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function isoLocalTime(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function SnoozeModal({
  open,
  leadName,
  currentlySnoozed = false,
  onConfirm,
  onClose,
}: SnoozeModalProps): JSX.Element {
  const t = useTranslations('agent.snoozeModal');
  const tCommon = useTranslations('admin.common');

  // Default preset: 1 hour. Custom date/time defaults to "tomorrow 9 AM"
  // so opening the picker doesn't dump the user on a past timestamp.
  const [preset, setPreset] = useState<Preset>('1h');
  const [date, setDate] = useState<string>(() => isoLocalDate(tomorrowAt9()));
  const [time, setTime] = useState<string>(() => isoLocalTime(tomorrowAt9()));
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Reset state on open so the picker doesn't carry over from a
  // previous lead.
  useEffect(() => {
    if (!open) return;
    setPreset('1h');
    const d = tomorrowAt9();
    setDate(isoLocalDate(d));
    setTime(isoLocalTime(d));
    setError(null);
  }, [open]);

  const target = useMemo<Date | null>(() => {
    if (preset === '1h') return plusHours(1);
    if (preset === '3h') return plusHours(3);
    if (preset === 'tomorrow9') return tomorrowAt9();
    // custom
    if (!date || !time) return null;
    const d = new Date(`${date}T${time}:00`);
    return Number.isNaN(d.getTime()) ? null : d;
  }, [preset, date, time]);

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (!target) {
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
      await onConfirm(target.toISOString());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function onClear(): Promise<void> {
    setSubmitting(true);
    setError(null);
    try {
      await onConfirm(null);
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
          {currentlySnoozed ? (
            <Button variant="ghost" onClick={() => void onClear()} disabled={submitting}>
              {t('clear')}
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            {tCommon('cancel')}
          </Button>
          <Button type="submit" form="snoozeForm" loading={submitting} disabled={!target}>
            {t('confirm')}
          </Button>
        </>
      }
    >
      <form id="snoozeForm" className="flex flex-col gap-3" onSubmit={onSubmit}>
        {error ? <Notice tone="error">{error}</Notice> : null}
        <p className="text-sm text-ink-secondary">{t('intro')}</p>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-xs font-semibold uppercase tracking-wide text-ink-tertiary">
            {t('preset')}
          </legend>
          {(['1h', '3h', 'tomorrow9', 'custom'] as const).map((p) => (
            <label
              key={p}
              className="flex cursor-pointer items-center gap-2 rounded-md border border-surface-border bg-surface-card px-3 py-2 text-sm hover:bg-brand-50/40"
            >
              <input
                type="radio"
                name="snoozePreset"
                value={p}
                checked={preset === p}
                onChange={() => setPreset(p)}
              />
              <span>{t(`presets.${p}`)}</span>
            </label>
          ))}
        </fieldset>

        {preset === 'custom' ? (
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('date')} required>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
            </Field>
            <Field label={t('time')} required>
              <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} required />
            </Field>
          </div>
        ) : null}

        {target ? (
          <p className="text-xs text-ink-tertiary">
            {t('preview', { when: target.toLocaleString() })}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}
