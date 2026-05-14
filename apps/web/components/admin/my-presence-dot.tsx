'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import { presenceApi, type OwnPresenceRow, type PresenceStatus } from '@/lib/api';
import { getAccessToken } from '@/lib/auth';
import { cn } from '@/lib/utils';

/**
 * Sprint 10 (D10) — caller's own presence dot.
 *
 * Sits next to the user's name in the auth bar so the operator
 * can see at a glance what status the server thinks they're in.
 * Polls `GET /presence/me` every POLL_MS (60 s) — the same cadence
 * as the heartbeat — so the dot stays in sync with the chip the
 * Organization page shows to other users.
 *
 * Renders nothing pre-hydration / when unauthenticated to avoid
 * SSR mismatches.
 */

const POLL_MS = 60_000;

const TONE: Record<PresenceStatus, string> = {
  online: 'bg-status-healthy',
  away: 'bg-status-warning',
  busy: 'bg-status-info',
  offline: 'bg-ink-tertiary',
};

export function MyPresenceDot(): JSX.Element | null {
  const t = useTranslations('admin.organization.people.presence');
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [presence, setPresence] = useState<OwnPresenceRow | null>(null);

  useEffect(() => {
    setAuthed(Boolean(getAccessToken()));
  }, []);

  useEffect(() => {
    if (!authed) return;
    let cancelled = false;
    const load = () => {
      presenceApi
        .me()
        .then((row) => {
          if (!cancelled) setPresence(row);
        })
        .catch(() => {
          /* swallow — outage must not break the bar */
        });
    };
    load();
    const id = window.setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [authed]);

  if (!authed || !presence) return null;
  const status = presence.status;
  const label = t(status as 'online');
  return (
    <span
      aria-label={label}
      title={label}
      className={cn('inline-block h-2 w-2 shrink-0 rounded-full', TONE[status])}
    />
  );
}
