'use client';

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';

import { presenceApi } from '@/lib/api';
import { getAccessToken } from '@/lib/auth';

/**
 * Sprint 10 (D10) — client-side presence heartbeat.
 *
 * Lives in the admin shell so every admin page benefits without
 * having to wire its own hook. Renders nothing — it is purely an
 * effect-driving component.
 *
 * Behaviour:
 *   • Sends `POST /presence/heartbeat` every HEARTBEAT_MS while
 *     authenticated AND the tab is visible.
 *   • Skips the heartbeat when `document.visibilityState !==
 *     'visible'` (hidden tabs don't spam the API).
 *   • Sends an `activity` event on:
 *       - first mount after auth (initial "I just opened admin"),
 *       - tab-focus transitions from hidden → visible,
 *       - admin route changes (next/navigation `pathname` change).
 *   • Best-effort `sendBeacon` on `pagehide` to mark a final
 *     heartbeat without blocking page unload — useful so the chip
 *     doesn't linger online for the full 2-minute window after a
 *     tab close.
 *
 * Errors are swallowed — a presence outage MUST NOT degrade the
 * admin UX. The server-side write-throttle protects the DB from
 * any client misbehaviour.
 */

const HEARTBEAT_MS = 60_000;

export function PresenceHeartbeat(): null {
  const pathname = usePathname();
  const lastBeatRef = useRef<number>(0);

  // Helper — fire a heartbeat unless the tab is hidden.
  function beat(reason: 'tick' | 'visibility' | 'mount' | 'route'): void {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    const token = getAccessToken();
    if (!token) return;
    lastBeatRef.current = Date.now();
    void presenceApi.heartbeat({}).catch(() => {
      /* swallow — outage must not break the UX */
    });
    // 'mount' and 'route' double as activity signals; this lets the
    // server bump lastActiveAt so the chip stays online instead of
    // sliding into "away" on a focused but idle tab.
    if (reason === 'mount' || reason === 'route' || reason === 'visibility') {
      void presenceApi.activity({}).catch(() => {
        /* swallow */
      });
    }
  }

  // Mount-time heartbeat + interval + visibility listener.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    beat('mount');
    const intervalId = window.setInterval(() => beat('tick'), HEARTBEAT_MS);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') beat('visibility');
    };
    document.addEventListener('visibilitychange', onVisibility);

    // Best-effort offline marker on tab close. We use `sendBeacon`
    // so the request fires even after the JS context tears down.
    // The server's write-throttle keeps this from blowing up the
    // DB if a user F5's repeatedly.
    const onPageHide = () => {
      const token = getAccessToken();
      if (!token) return;
      try {
        const url = '/api/v1/presence/heartbeat';
        const blob = new Blob([JSON.stringify({})], { type: 'application/json' });
        // navigator.sendBeacon doesn't carry an Authorization header,
        // so it relies on the existing session cookie when present.
        // If the API requires Bearer-only auth, this beacon will
        // simply 401 — that's fine; the next page load's heartbeat
        // re-establishes presence.
        if ('sendBeacon' in navigator) navigator.sendBeacon(url, blob);
      } catch {
        /* swallow */
      }
    };
    window.addEventListener('pagehide', onPageHide);

    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Route changes → activity bump.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!pathname) return;
    // Skip the very first effect — the mount-time beat already
    // covered it; this protects against a double-beat on first
    // render.
    if (lastBeatRef.current === 0) return;
    beat('route');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  return null;
}
