'use client';

import { useCallback, useEffect, useState } from 'react';
import { Bell, Check, CheckCheck } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ApiError, notificationsApi, type NotificationRow } from '@/lib/api';
import { getAccessToken } from '@/lib/auth';
import { cn } from '@/lib/utils';

/**
 * P2-02 — notification bell.
 *
 * Polls `/notifications/unread-count` every 30 s. Clicking the bell
 * lazy-loads the list (unread first then newest 50), with single +
 * mark-all-read actions. Errors are silenced to console — the bell
 * gracefully degrades to no badge if the endpoint is unreachable.
 *
 * The component renders nothing pre-hydration (no SSR mismatch).
 */

const POLL_MS = 30_000;

export function NotificationBell(): JSX.Element | null {
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
      // Silently degrade — usually 401 / network blip.
      // eslint-disable-next-line no-console
      if (err instanceof ApiError && err.status === 401) setAuthed(false);
    }
  }, [authed]);

  useEffect(() => {
    if (!authed) return;
    void refreshCount();
    const t = setInterval(() => void refreshCount(), POLL_MS);
    return () => clearInterval(t);
  }, [authed, refreshCount]);

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

  if (authed === null || authed === false) return null;

  return (
    <div className="relative">
      <button
        type="button"
        aria-label={`Notifications${count > 0 ? ` (${count} unread)` : ''}`}
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
              Notifications
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void onMarkAll()}
              disabled={count === 0}
            >
              <CheckCheck className="h-3.5 w-3.5" aria-hidden="true" />
              Mark all read
            </Button>
          </header>
          {rows === null ? (
            <p className="p-4 text-center text-xs text-ink-secondary">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="p-4 text-center text-xs text-ink-tertiary">No notifications.</p>
          ) : (
            <ul className="max-h-96 divide-y divide-surface-border overflow-y-auto">
              {rows.map((r) => (
                <li
                  key={r.id}
                  className={cn(
                    'flex flex-col gap-1 px-3 py-2.5',
                    r.readAt ? '' : 'bg-brand-50/40',
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-xs font-medium text-ink-primary">{r.title}</span>
                    {!r.readAt ? (
                      <button
                        type="button"
                        onClick={() => void onMarkOne(r.id)}
                        className="text-ink-tertiary hover:text-brand-700"
                        aria-label="Mark read"
                      >
                        <Check className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    ) : null}
                  </div>
                  {r.body ? <p className="text-[11px] text-ink-secondary">{r.body}</p> : null}
                  <span className="text-[10px] text-ink-tertiary">
                    {new Date(r.createdAt).toLocaleString()}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
