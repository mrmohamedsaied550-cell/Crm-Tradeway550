'use client';

import { useTranslations } from 'next-intl';
import {
  AlertTriangle,
  Calendar as CalendarIcon,
  CheckCircle2,
  Clock,
  MessageCircle,
  Phone,
  Plus,
  Users2,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import type { FollowUpActionType, LeadFollowUp } from '@/lib/api-types';
import { cn } from '@/lib/utils';

/**
 * Phase B — B1: hero card on the lead detail right panel.
 *
 * Three visual states:
 *   • overdue  — red border + breach tone, "Overdue Xh" headline.
 *   • soon     — amber border (within 24 h), "Due in Xh".
 *   • later    — neutral border, "Due Mon 14:30".
 *   • none     — empty state with a prominent "+ Schedule follow-up" CTA.
 *
 * Inline complete + snooze keep the loop tight — agent doesn't have to
 * jump to the calendar to act.
 */

type Tone = 'overdue' | 'soon' | 'later' | 'none';

function effectiveDueAt(f: LeadFollowUp): Date {
  const due = new Date(f.dueAt);
  if (!f.snoozedUntil) return due;
  const sn = new Date(f.snoozedUntil);
  return sn.getTime() > due.getTime() ? sn : due;
}

function pickTone(f: LeadFollowUp | null, now: Date): Tone {
  if (!f) return 'none';
  const eff = effectiveDueAt(f).getTime();
  const diffMs = eff - now.getTime();
  if (diffMs < 0) return 'overdue';
  if (diffMs < 24 * 60 * 60 * 1000) return 'soon';
  return 'later';
}

function ActionIcon({ type }: { type: FollowUpActionType }): JSX.Element {
  if (type === 'call') return <Phone className="h-4 w-4" aria-hidden="true" />;
  if (type === 'whatsapp') return <MessageCircle className="h-4 w-4" aria-hidden="true" />;
  if (type === 'visit') return <Users2 className="h-4 w-4" aria-hidden="true" />;
  return <CalendarIcon className="h-4 w-4" aria-hidden="true" />;
}

interface NextActionCardProps {
  /** Earliest pending follow-up for this lead (effective-due aware), or null. */
  next: LeadFollowUp | null;
  /** "Now" reference passed in so the parent's tick re-renders the relative time. */
  now: Date;
  busy: boolean;
  onComplete: (id: string) => void | Promise<void>;
  onSnooze: (followUp: LeadFollowUp) => void;
  onAdd: () => void;
}

export function NextActionCard({
  next,
  now,
  busy,
  onComplete,
  onSnooze,
  onAdd,
}: NextActionCardProps): JSX.Element {
  const t = useTranslations('admin.leads.detail.nextAction');
  const tTypes = useTranslations('agent.workspace.followUps.types');
  const locale = (typeof navigator !== 'undefined' ? navigator.language : 'en') || 'en';

  const tone = pickTone(next, now);

  // Empty state — make the CTA obvious.
  if (!next) {
    return (
      <section className="rounded-lg border border-surface-border bg-surface-card p-5 shadow-card">
        <header className="mb-2 flex items-center gap-2">
          <Clock className="h-4 w-4 text-brand-700" aria-hidden="true" />
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-tertiary">
            {t('title')}
          </h2>
        </header>
        <p className="mb-3 text-sm text-ink-secondary">{t('emptyHint')}</p>
        <Button variant="primary" size="md" onClick={onAdd}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          {t('addCta')}
        </Button>
      </section>
    );
  }

  const eff = effectiveDueAt(next);
  const diffMs = eff.getTime() - now.getTime();
  const overdue = tone === 'overdue';
  const isSnoozed = next.snoozedUntil ? new Date(next.snoozedUntil).getTime() > Date.now() : false;

  // Headline timer — biggest piece of text on the card.
  let headline: string;
  if (overdue) {
    headline = t('overdueBy', { rel: formatDuration(-diffMs, locale) });
  } else if (tone === 'soon') {
    headline = t('dueIn', { rel: formatDuration(diffMs, locale) });
  } else {
    headline = t('dueAt', {
      when: eff.toLocaleString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      }),
    });
  }

  return (
    <section
      className={cn(
        'rounded-lg border-2 p-5 shadow-card transition-colors',
        overdue
          ? 'border-status-breach/60 bg-status-breach/5'
          : tone === 'soon'
            ? 'border-status-warning/50 bg-status-warning/5'
            : 'border-brand-200 bg-brand-50/40',
      )}
    >
      <header className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {overdue ? (
            <AlertTriangle className="h-4 w-4 text-status-breach" aria-hidden="true" />
          ) : (
            <Clock className="h-4 w-4 text-brand-700" aria-hidden="true" />
          )}
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-tertiary">
            {t('title')}
          </h2>
        </div>
        {isSnoozed ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-surface-border bg-surface px-2 py-0.5 text-[11px] font-medium text-ink-tertiary">
            <Clock className="h-3 w-3" aria-hidden="true" />
            {t('snoozed')}
          </span>
        ) : null}
      </header>

      <p
        className={cn(
          'mb-1 text-2xl font-bold leading-tight',
          overdue
            ? 'text-status-breach'
            : tone === 'soon'
              ? 'text-status-warning'
              : 'text-ink-primary',
        )}
      >
        {headline}
      </p>

      <p className="mb-3 inline-flex items-center gap-1.5 text-sm font-medium text-ink-primary">
        <span className="inline-flex items-center gap-1 rounded-md bg-surface-card px-2 py-0.5 text-xs">
          <ActionIcon type={next.actionType} />
          {tTypes(next.actionType)}
        </span>
        <span className="text-xs text-ink-tertiary">
          {eff.toLocaleString(undefined, {
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
          })}
        </span>
      </p>

      {next.note ? (
        <p className="mb-3 rounded-md border border-surface-border bg-surface-card px-3 py-2 text-sm text-ink-primary">
          {next.note}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          size="sm"
          onClick={() => void onComplete(next.id)}
          disabled={busy}
        >
          <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
          {t('complete')}
        </Button>
        <Button variant="secondary" size="sm" onClick={() => onSnooze(next)} disabled={busy}>
          <Clock className="h-3.5 w-3.5" aria-hidden="true" />
          {t('snooze')}
        </Button>
        <Button variant="ghost" size="sm" onClick={onAdd} disabled={busy}>
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          {t('addAnother')}
        </Button>
      </div>
    </section>
  );
}

/** Compact "Xh Ym" duration without bringing in date-fns. */
function formatDuration(ms: number, locale: string): string {
  const totalMin = Math.max(1, Math.round(ms / 60000));
  if (totalMin < 60) return new Intl.NumberFormat(locale).format(totalMin) + ' min';
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h < 24) {
    return m > 0
      ? `${new Intl.NumberFormat(locale).format(h)} h ${m} min`
      : `${new Intl.NumberFormat(locale).format(h)} h`;
  }
  const d = Math.floor(h / 24);
  const hh = h % 24;
  return hh > 0
    ? `${new Intl.NumberFormat(locale).format(d)} d ${hh} h`
    : `${new Intl.NumberFormat(locale).format(d)} d`;
}
