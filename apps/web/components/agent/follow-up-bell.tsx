'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { CalendarClock } from 'lucide-react';

import { ApiError, followUpsApi } from '@/lib/api';
import type { FollowUpSummary } from '@/lib/api-types';
import { getAccessToken } from '@/lib/auth';
import { cn } from '@/lib/utils';

/**
 * Phase A — A7: follow-up bell.
 *
 * Surfaces `overdueCount` + `dueTodayCount` from
 * `/follow-ups/me/summary` next to the existing notification bell.
 * The badge shows the total of both counts; the link drops the user
 * onto `/agent/calendar` where they can act.
 *
 * Mirrors NotificationBell's reliability stance:
 *   - polls every 60 s,
 *   - silently degrades to no badge on transient failures,
 *   - hides itself entirely until hydration finishes, so SSR / first
 *     client render don't disagree.
 *
 * No realtime channel is wired here — follow-up counts move only
 * when the user creates / completes / snoozes a follow-up, all of
 * which already trigger a route-level reload elsewhere. The 60-s
 * poll is enough to keep the badge fresh between sessions.
 */

const POLL_MS = 60_000;

export function FollowUpBell(): JSX.Element | null {
  const t = useTranslations('agent.followUpBell');

  const [authed, setAuthed] = useState<boolean | null>(null);
  const [summary, setSummary] = useState<FollowUpSummary>({
    overdueCount: 0,
    dueTodayCount: 0,
  });

  useEffect(() => {
    setAuthed(Boolean(getAccessToken()));
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    if (!authed) return;
    try {
      const next = await followUpsApi.meSummary();
      setSummary(next);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setAuthed(false);
      // Other errors are silenced — badge degrades to "no badge".
    }
  }, [authed]);

  useEffect(() => {
    if (!authed) return;
    void refresh();
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [authed, refresh]);

  if (authed === null || authed === false) return null;

  const total = summary.overdueCount + summary.dueTodayCount;
  const hasOverdue = summary.overdueCount > 0;
  const ariaLabel = t('ariaLabel', {
    overdue: summary.overdueCount,
    today: summary.dueTodayCount,
  });

  return (
    <Link
      href="/agent/calendar"
      aria-label={ariaLabel}
      title={ariaLabel}
      className="relative inline-flex h-9 w-9 items-center justify-center rounded-md border border-surface-border bg-surface-card text-ink-secondary hover:bg-brand-50 hover:text-brand-700"
    >
      <CalendarClock className="h-4 w-4" aria-hidden="true" />
      {total > 0 ? (
        <span
          className={cn(
            'absolute -end-1 -top-1 inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full px-1 text-[10px] font-semibold leading-none text-white',
            hasOverdue ? 'bg-status-breach' : 'bg-status-warning',
          )}
        >
          {total > 99 ? '99+' : total}
        </span>
      ) : null}
    </Link>
  );
}
