'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Bell, Check, CheckCheck } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  ApiError,
  notificationsApi,
  type NotificationRow,
  type NotificationSeverity,
} from '@/lib/api';
import { getAccessToken } from '@/lib/auth';
import { useRealtime } from '@/lib/realtime';
import { cn } from '@/lib/utils';

/**
 * P2-02 / Sprint 9 (D9) — notification bell.
 *
 * Sprint 9 upgrades:
 *   • Strings flow through next-intl (`admin.notifications.*`) so
 *     the Arabic admin gets a localised inbox + RTL layout.
 *   • Each item carries a severity dot so the operator can scan
 *     priorities at a glance (info → blue, success → green,
 *     warning → amber, danger → red).
 *   • Clicking a row marks it read AND navigates to the row's
 *     `actionUrl` (e.g. `/admin/leads/{id}` or
 *     `/admin/leads?queue=returnedToMe`). Rows without an
 *     actionUrl stay as plain text.
 *
 * Polling + realtime fallback chain unchanged: SSE for instant
 * pushes, 30-s poll as the safety net for environments where SSE
 * can't reach the server. Errors are silenced — the bell
 * gracefully degrades to no badge if the endpoint is unreachable.
 *
 * The component renders nothing pre-hydration (no SSR mismatch).
 */

const POLL_MS = 30_000;

const SEVERITY_DOT: Record<NotificationSeverity | 'unset', string> = {
  info: 'bg-status-info',
  success: 'bg-status-healthy',
  warning: 'bg-status-warning',
  danger: 'bg-status-breach',
  unset: 'bg-ink-tertiary',
};

export function NotificationBell(): JSX.Element | null {
  const t = useTranslations('admin.notifications');
  const router = useRouter();
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [count, setCount] = useState<number>(0);
  const [open, setOpen] = useState<boolean>(false);
  const [rows, setRows] = useState<NotificationRow[] | null>(null);

  // Detect auth on mount + each open.
  useEffect(() => {
    setAuthed(Boolean(getAccessToken()));
  }, []);

  const refreshCount = useCallback(async (): Promise<void> => {
    if (!authed) return;
    try {
      const res = await notificationsApi.unreadCount();
      setCount(res.count);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setAuthed(false);
    }
  }, [authed]);

  useEffect(() => {
    if (!authed) return;
    void refreshCount();
    const tick = setInterval(() => void refreshCount(), POLL_MS);
    return () => clearInterval(tick);
  }, [authed, refreshCount]);

  // P3-02 — bump the count + refresh the list (if open) the moment
  // a new notification lands. The poll above stays in place so we
  // self-heal if SSE drops.
  useRealtime('notification.created', () => {
    if (!authed) return;
    setCount((c) => c + 1);
    if (open) {
      void notificationsApi
        .list({ limit: 50 })
        .then(setRows)
        .catch(() => {
          /* next reopen will retry */
        });
    }
  });

  async function onOpen(): Promise<void> {
    setOpen((o) => !o);
    if (!open) {
      try {
        const list = await notificationsApi.list({ limit: 50 });
        setRows(list);
      } catch {
        setRows([]);
      }
    }
  }

  async function onMarkOne(id: string): Promise<void> {
    try {
      await notificationsApi.markRead(id);
      setRows((prev) =>
        prev
          ? prev.map((r) => (r.id === id ? { ...r, readAt: new Date().toISOString() } : r))
          : prev,
      );
      void refreshCount();
    } catch {
      /* noop */
    }
  }

  async function onMarkAll(): Promise<void> {
    try {
      await notificationsApi.markAllRead();
      setRows((prev) =>
        prev ? prev.map((r) => ({ ...r, readAt: r.readAt ?? new Date().toISOString() })) : prev,
      );
      setCount(0);
    } catch {
      /* noop */
    }
  }

  async function onRowClick(row: NotificationRow): Promise<void> {
    if (!row.readAt) {
      // Fire-and-forget — don't block navigation on the mark-read
      // network round-trip; the next inbox open / count refresh
      // will reconcile if it fails.
      void onMarkOne(row.id);
    }
    if (row.actionUrl) {
      setOpen(false);
      router.push(row.actionUrl);
    }
  }

  if (authed === null || authed === false) return null;

  const ariaLabel = count > 0 ? t('bellWithCount', { n: count }) : t('bell');

  return (
    <div className="relative">
      <button
        type="button"
        aria-label={ariaLabel}
        onClick={() => void onOpen()}
        className="relative inline-flex h-9 w-9 items-center justify-center rounded-md border border-surface-border bg-surface-card text-ink-secondary hover:bg-brand-50 hover:text-brand-700"
      >
        <Bell className="h-4 w-4" aria-hidden="true" />
        {count > 0 ? (
          <span className="absolute -end-1 -top-1 inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-status-breach px-1 text-[10px] font-semibold leading-none text-white">
            {count > 99 ? '99+' : count}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="absolute end-0 z-30 mt-2 w-80 max-w-[90vw] rounded-md border border-surface-border bg-surface-card shadow-lg">
          <header className="flex items-center justify-between gap-2 border-b border-surface-border px-3 py-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-ink-tertiary">
              {t('title')}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void onMarkAll()}
              disabled={count === 0}
              aria-label={t('markAllRead')}
            >
              <CheckCheck className="h-3.5 w-3.5" aria-hidden="true" />
              {t('markAllRead')}
            </Button>
          </header>
          {rows === null ? (
            <p className="p-4 text-center text-xs text-ink-secondary">{t('loading')}</p>
          ) : rows.length === 0 ? (
            <p className="p-4 text-center text-xs text-ink-tertiary">{t('empty')}</p>
          ) : (
            <ul className="max-h-96 divide-y divide-surface-border overflow-y-auto">
              {rows.map((r) => {
                const sevKey = (r.severity ?? 'unset') as keyof typeof SEVERITY_DOT;
                const clickable = Boolean(r.actionUrl);
                return (
                  <li
                    key={r.id}
                    className={cn(
                      'px-3 py-2.5',
                      r.readAt ? '' : 'bg-brand-50/40',
                      clickable ? 'cursor-pointer hover:bg-brand-50/60' : '',
                    )}
                  >
                    <div
                      role={clickable ? 'button' : undefined}
                      tabIndex={clickable ? 0 : undefined}
                      onClick={clickable ? () => void onRowClick(r) : undefined}
                      onKeyDown={
                        clickable
                          ? (e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                void onRowClick(r);
                              }
                            }
                          : undefined
                      }
                      className="flex flex-col gap-1"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span
                            aria-hidden="true"
                            className={cn(
                              'mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full',
                              SEVERITY_DOT[sevKey],
                            )}
                          />
                          <span className="text-xs font-medium text-ink-primary">{r.title}</span>
                        </span>
                        {!r.readAt ? (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              void onMarkOne(r.id);
                            }}
                            className="text-ink-tertiary hover:text-brand-700"
                            aria-label={t('markRead')}
                          >
                            <Check className="h-3.5 w-3.5" aria-hidden="true" />
                          </button>
                        ) : null}
                      </div>
                      {r.body ? <p className="text-[11px] text-ink-secondary">{r.body}</p> : null}
                      <span className="text-[10px] text-ink-tertiary">
                        {new Date(r.createdAt).toLocaleString()}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
