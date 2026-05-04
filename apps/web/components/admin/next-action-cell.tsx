'use client';

import { useTranslations } from 'next-intl';
import { AlertTriangle, Calendar, Clock } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * Phase B — B3: compact next-action cell shared by /admin/leads and
 * /agent/workspace.
 *
 * Renders one of four states based on a lead's `nextActionDueAt`:
 *   • overdue   — red, with "Overdue Xh"
 *   • dueToday  — amber, with the local time
 *   • tomorrow  — info, with "Tomorrow HH:MM"
 *   • later     — neutral, with the short date
 *   • none      — em-dash placeholder
 *
 * The cell is intentionally small: a leading dot/icon, a single line
 * of text. Drop it into a DataTable column or a Lead row without
 * breaking the layout.
 *
 * No backend changes — uses the lead's existing `nextActionDueAt`
 * column which is already kept in sync server-side (effective-due
 * aware via A5's recomputeNextActionDueAt).
 */

type Tone = 'overdue' | 'today' | 'tomorrow' | 'later' | 'none';

function pickTone(due: Date | null, now: Date): Tone {
  if (!due) return 'none';
  if (due.getTime() < now.getTime()) return 'overdue';
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const tomorrowStart = todayStart + 24 * 60 * 60 * 1000;
  const dayAfterStart = tomorrowStart + 24 * 60 * 60 * 1000;
  if (due.getTime() < tomorrowStart) return 'today';
  if (due.getTime() < dayAfterStart) return 'tomorrow';
  return 'later';
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function shortTime(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function compactDuration(ms: number): string {
  // "Xh Ym" / "Xm" / "Xd Yh" — short and dense for tables.
  const totalMin = Math.max(1, Math.round(ms / 60000));
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h < 24) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const hh = h % 24;
  return hh > 0 ? `${d}d ${hh}h` : `${d}d`;
}

interface NextActionCellProps {
  /** ISO timestamp from `Lead.nextActionDueAt`, or null/undefined. */
  dueAt: string | null | undefined;
  /** "Now" reference. Pass the page's tick state so the cell stays fresh. */
  now: Date;
  /** Compact: hide the icon, only render the label (kanban cards). */
  compact?: boolean;
  className?: string;
}

export function NextActionCell({
  dueAt,
  now,
  compact = false,
  className,
}: NextActionCellProps): JSX.Element {
  const t = useTranslations('admin.leads.nextActionCell');
  const due = dueAt ? new Date(dueAt) : null;
  const tone = pickTone(due, now);

  if (tone === 'none' || !due) {
    return (
      <span className={cn('inline-flex items-center text-xs text-ink-tertiary', className)}>—</span>
    );
  }

  const TONE_CLASS: Record<Exclude<Tone, 'none'>, string> = {
    overdue: 'border-status-breach/30 bg-status-breach/10 text-status-breach',
    today: 'border-status-warning/30 bg-status-warning/10 text-status-warning',
    tomorrow: 'border-brand-200 bg-brand-50 text-brand-800',
    later: 'border-surface-border bg-surface text-ink-secondary',
  };

  const Icon = tone === 'overdue' ? AlertTriangle : tone === 'later' ? Calendar : Clock;

  let label: string;
  switch (tone) {
    case 'overdue':
      label = t('overdueBy', { rel: compactDuration(now.getTime() - due.getTime()) });
      break;
    case 'today':
      label = t('today', { time: shortTime(due) });
      break;
    case 'tomorrow':
      label = t('tomorrow', { time: shortTime(due) });
      break;
    case 'later':
      label = due.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
      });
      break;
  }

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium',
        TONE_CLASS[tone],
        className,
      )}
      title={due.toLocaleString()}
    >
      {compact ? null : <Icon className="h-3 w-3" aria-hidden="true" />}
      <span>{label}</span>
    </span>
  );
}
