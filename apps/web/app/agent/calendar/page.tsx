'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import {
  ArrowLeft,
  ArrowRight,
  Calendar as CalendarIcon,
  CheckCircle2,
  Clock,
  Loader2,
  MessageCircle,
  Phone,
  RotateCcw,
  Users2,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Notice } from '@/components/ui/notice';
import { useToast } from '@/components/ui/toast';
import { SnoozeModal } from '@/components/agent/snooze-modal';
import { ApiError, followUpsApi } from '@/lib/api';
import type { FollowUpActionType, LeadFollowUp } from '@/lib/api-types';
import { cn } from '@/lib/utils';

/**
 * P3-04 — calendar of pending follow-ups.
 *
 * Month grid (Sun–Sat) with each day cell showing up to three
 * follow-up bullets and a "+N more" overflow. Selecting a day opens
 * a side panel with the day's full list, each row linking back to
 * the lead detail. Toggle "All assignees" lifts the personal filter
 * for managers (the API gates that on `followup.read`, which TLs
 * already hold).
 *
 * Reload triggers:
 *   - month change (prev / next / today),
 *   - "All assignees" toggle,
 *   - completing a follow-up from the day panel.
 */

const WEEK_START = 0; // Sunday — matches the rest of the CRM (see /admin/reports).

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
}
function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
function isSameMonth(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}
function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

/**
 * Build the 6×7 grid of dates that visually represents the month —
 * pads with the trailing days of the prior month and leading days of
 * the next so every row is full and the grid never reflows when the
 * month changes width.
 */
function buildGrid(month: Date): Date[] {
  const first = startOfMonth(month);
  const offset = (first.getDay() - WEEK_START + 7) % 7;
  const start = new Date(first);
  start.setDate(first.getDate() - offset);
  const cells: Date[] = [];
  for (let i = 0; i < 42; i += 1) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    cells.push(d);
  }
  return cells;
}

function actionTone(type: FollowUpActionType): string {
  switch (type) {
    case 'call':
      return 'bg-brand-100 text-brand-800';
    case 'whatsapp':
      return 'bg-emerald-100 text-emerald-800';
    case 'visit':
      return 'bg-amber-100 text-amber-800';
    default:
      return 'bg-surface text-ink-secondary';
  }
}

function ActionIcon({ type }: { type: FollowUpActionType }): JSX.Element {
  if (type === 'call') return <Phone className="h-3 w-3" aria-hidden="true" />;
  if (type === 'whatsapp') return <MessageCircle className="h-3 w-3" aria-hidden="true" />;
  if (type === 'visit') return <Users2 className="h-3 w-3" aria-hidden="true" />;
  return <CalendarIcon className="h-3 w-3" aria-hidden="true" />;
}

export default function AgentCalendarPage(): JSX.Element {
  const t = useTranslations('agent.calendar');
  const tCommon = useTranslations('admin.common');
  const tTypes = useTranslations('agent.workspace.followUps.types');
  const tToast = useTranslations('agent.followUpToast');
  const { toast } = useToast();

  // Anchor of the visible month — first of the month, midnight.
  const [anchor, setAnchor] = useState<Date>(() => startOfMonth(new Date()));
  const [allAssignees, setAllAssignees] = useState<boolean>(false);
  const [items, setItems] = useState<LeadFollowUp[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedDay, setSelectedDay] = useState<string | null>(null); // dayKey or null
  // Phase A — A7: snooze picker.
  const [snoozeFor, setSnoozeFor] = useState<LeadFollowUp | null>(null);
  // Page-load toast: fires once per mount when overdueCount > 0.
  const overdueToastShownRef = useRef<boolean>(false);

  // Fire the overdue toast independent of the calendar window so it
  // surfaces even if the user lands here on a future month.
  useEffect(() => {
    if (overdueToastShownRef.current) return;
    let cancelled = false;
    void followUpsApi
      .meSummary()
      .then((s) => {
        if (cancelled || overdueToastShownRef.current) return;
        if (s.overdueCount > 0) {
          overdueToastShownRef.current = true;
          toast({
            tone: 'warning',
            title: tToast('overdueTitle', { count: s.overdueCount }),
            body: tToast('overdueBody'),
            duration: 7000,
          });
        }
      })
      .catch(() => {
        // Toast is best-effort — silent on network blips.
      });
    return () => {
      cancelled = true;
    };
  }, [toast, tToast]);

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      // Pull the WHOLE 6×7 grid window (not just the calendar month) so
      // the grey-pad days from the previous / next month also light up
      // when they have follow-ups.
      const cells = buildGrid(anchor);
      const from = cells[0]!;
      const lastShown = cells[cells.length - 1]!;
      const to = new Date(
        lastShown.getFullYear(),
        lastShown.getMonth(),
        lastShown.getDate(),
        23,
        59,
        59,
        999,
      );
      const list = await followUpsApi.calendar({
        from: from.toISOString(),
        to: to.toISOString(),
        mine: allAssignees ? '0' : '1',
        limit: 500,
      });
      setItems(list);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [anchor, allAssignees]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const grid = useMemo(() => buildGrid(anchor), [anchor]);

  // Bucket follow-ups by local-day key so day cells render in O(1).
  const byDay = useMemo(() => {
    const m = new Map<string, LeadFollowUp[]>();
    for (const it of items) {
      const k = dayKey(new Date(it.dueAt));
      const list = m.get(k);
      if (list) list.push(it);
      else m.set(k, [it]);
    }
    // Sort each day's bucket by dueAt ascending.
    for (const list of m.values()) list.sort((a, b) => a.dueAt.localeCompare(b.dueAt));
    return m;
  }, [items]);

  const today = new Date();
  const monthLabel = anchor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const weekdayHeaders = useMemo(() => {
    // Build "Sun..Sat" labels in the active locale.
    const base = new Date(2024, 0, 7); // Jan 7 2024 was a Sunday.
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(base);
      d.setDate(base.getDate() + i);
      return d.toLocaleDateString(undefined, { weekday: 'short' });
    });
  }, []);

  function shiftMonth(delta: number): void {
    setAnchor((a) => new Date(a.getFullYear(), a.getMonth() + delta, 1));
    setSelectedDay(null);
  }

  function jumpToToday(): void {
    setAnchor(startOfMonth(new Date()));
    setSelectedDay(dayKey(new Date()));
  }

  async function onComplete(id: string): Promise<void> {
    try {
      await followUpsApi.complete(id);
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  // Phase A — A7: apply or clear a snooze, refresh the grid, toast.
  // Errors propagate to the SnoozeModal which surfaces the message.
  async function onSnoozeConfirm(snoozedUntil: string | null): Promise<void> {
    if (!snoozeFor) return;
    setError(null);
    await followUpsApi.update(snoozeFor.id, { snoozedUntil });
    setSnoozeFor(null);
    await reload();
    toast({
      tone: 'success',
      title: snoozedUntil
        ? tToast('snoozeApplied', { when: new Date(snoozedUntil).toLocaleString() })
        : tToast('snoozeCleared'),
    });
  }

  const dayItems = selectedDay ? (byDay.get(selectedDay) ?? []) : [];

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-ink-primary">
            <CalendarIcon className="h-5 w-5 text-brand-700" aria-hidden="true" />
            {t('title')}
          </h1>
          <p className="mt-1 text-sm text-ink-secondary">{t('subtitle')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => shiftMonth(-1)} aria-label={t('prev')}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <span className="min-w-[10rem] text-center text-sm font-semibold text-ink-primary">
            {monthLabel}
          </span>
          <Button variant="ghost" size="sm" onClick={() => shiftMonth(1)} aria-label={t('next')}>
            <ArrowRight className="h-4 w-4" />
          </Button>
          <Button variant="secondary" size="sm" onClick={jumpToToday}>
            <RotateCcw className="h-3.5 w-3.5" />
            {t('today')}
          </Button>
          <label className="ms-2 inline-flex items-center gap-2 text-xs text-ink-secondary">
            <input
              type="checkbox"
              checked={allAssignees}
              onChange={(e) => setAllAssignees(e.target.checked)}
            />
            {t('allAssignees')}
          </label>
        </div>
      </header>

      {error ? (
        <Notice tone="error">
          <div className="flex items-start justify-between gap-2">
            <span>{error}</span>
            <Button variant="ghost" size="sm" onClick={() => void reload()}>
              {tCommon('retry')}
            </Button>
          </div>
        </Notice>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        {/* Month grid */}
        <div className="rounded-lg border border-surface-border bg-surface-card shadow-card">
          <div className="grid grid-cols-7 border-b border-surface-border bg-surface text-center text-xs font-semibold uppercase tracking-wide text-ink-tertiary">
            {weekdayHeaders.map((label) => (
              <span key={label} className="py-2">
                {label}
              </span>
            ))}
          </div>
          <div className="grid grid-cols-7">
            {grid.map((day) => {
              const k = dayKey(day);
              const inMonth = isSameMonth(day, anchor);
              const isToday = isSameDay(day, today);
              const isSelected = selectedDay === k;
              const dayList = byDay.get(k) ?? [];
              const visible = dayList.slice(0, 3);
              const overflow = Math.max(0, dayList.length - visible.length);
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => setSelectedDay(k)}
                  className={cn(
                    'flex min-h-[5.5rem] flex-col gap-1 border-b border-e border-surface-border p-2 text-start transition-colors',
                    inMonth ? 'bg-surface-card' : 'bg-surface text-ink-tertiary',
                    isSelected ? 'bg-brand-50 ring-2 ring-brand-200' : 'hover:bg-brand-50/40',
                  )}
                >
                  <span
                    className={cn(
                      'inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold',
                      isToday
                        ? 'bg-brand-600 text-white'
                        : inMonth
                          ? 'text-ink-primary'
                          : 'text-ink-tertiary',
                    )}
                  >
                    {day.getDate()}
                  </span>
                  <ul className="flex flex-col gap-0.5">
                    {visible.map((f) => (
                      <li
                        key={f.id}
                        className={cn(
                          'flex items-center gap-1 rounded px-1 py-0.5 text-[11px]',
                          actionTone(f.actionType),
                          f.completedAt ? 'opacity-50 line-through' : '',
                        )}
                        title={f.lead?.name ?? ''}
                      >
                        <ActionIcon type={f.actionType} />
                        <span className="truncate">{f.lead?.name ?? '—'}</span>
                      </li>
                    ))}
                    {overflow > 0 ? (
                      <li className="text-[11px] font-medium text-brand-700">
                        +{overflow} {t('more')}
                      </li>
                    ) : null}
                  </ul>
                </button>
              );
            })}
          </div>
        </div>

        {/* Day panel */}
        <aside className="flex min-h-[20rem] flex-col rounded-lg border border-surface-border bg-surface-card shadow-card">
          <header className="flex items-center justify-between gap-2 border-b border-surface-border px-3 py-2">
            <h2 className="text-sm font-semibold text-ink-primary">
              {selectedDay ? t('dayTitle', { date: selectedDay }) : t('pickADay')}
            </h2>
            {dayItems.length > 0 ? <Badge tone="healthy">{dayItems.length}</Badge> : null}
          </header>
          {loading ? (
            <div className="flex flex-1 items-center justify-center gap-2 p-4 text-sm text-ink-secondary">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              {tCommon('loading')}
            </div>
          ) : !selectedDay ? (
            <p className="flex-1 p-4 text-sm text-ink-tertiary">{t('pickADayHint')}</p>
          ) : dayItems.length === 0 ? (
            <EmptyState title={t('emptyDay')} body={t('emptyDayHint')} />
          ) : (
            <ul className="divide-y divide-surface-border overflow-y-auto">
              {dayItems.map((f) => {
                const due = new Date(f.dueAt);
                return (
                  <li key={f.id} className="flex flex-col gap-1 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="inline-flex items-center gap-1.5 text-sm font-medium text-ink-primary">
                        <span
                          className={cn(
                            'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px]',
                            actionTone(f.actionType),
                          )}
                        >
                          <ActionIcon type={f.actionType} />
                          {tTypes(f.actionType)}
                        </span>
                        {f.lead?.name ?? '—'}
                      </span>
                      <span className="text-xs text-ink-tertiary">
                        {due.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                      </span>
                    </div>
                    {f.note ? <p className="text-xs text-ink-secondary">{f.note}</p> : null}
                    <div className="flex items-center justify-between gap-2 text-xs">
                      {f.lead ? (
                        <Link
                          href={`/admin/leads/${f.lead.id}`}
                          className="font-medium text-brand-700 hover:text-brand-800"
                        >
                          {t('openLead')} →
                        </Link>
                      ) : (
                        <span />
                      )}
                      {f.completedAt ? (
                        <Badge tone="inactive">{t('done')}</Badge>
                      ) : (
                        <div className="flex items-center gap-1">
                          <Button variant="ghost" size="sm" onClick={() => setSnoozeFor(f)}>
                            <Clock className="h-3.5 w-3.5" />
                            {t('snooze')}
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => void onComplete(f.id)}>
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            {t('complete')}
                          </Button>
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>
      </div>

      <SnoozeModal
        open={snoozeFor !== null}
        leadName={snoozeFor?.lead?.name ?? undefined}
        currentlySnoozed={Boolean(
          snoozeFor?.snoozedUntil && Date.parse(snoozeFor.snoozedUntil) > Date.now(),
        )}
        onConfirm={onSnoozeConfirm}
        onClose={() => setSnoozeFor(null)}
      />
    </div>
  );
}
