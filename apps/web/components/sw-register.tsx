'use client';

import { useEffect } from 'react';

/**
 * P3-01 — register the service worker on first paint.
 *
 * Runs once per page load on the client. Idempotent: a re-register
 * call against the same script URL is a no-op. Failures (e.g.
 * non-HTTPS in production, browsers without SW support) are
 * swallowed — the SW is a progressive enhancement, the site works
 * without it.
 *
 * Localhost note: we register in development too because Chrome /
 * Safari treat http://localhost as a secure context for SW
 * registration. That keeps the install-prompt path testable
 * without a deployed environment.
 */
export function ServiceWorkerRegister(): null {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!('serviceWorker' in navigator)) return;
    // Wait until after load to keep the SW registration off the
    // critical-path (navigator.serviceWorker.register has been known
    // to delay the first frame on slow devices).
    const onLoad = (): void => {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
        // Intentionally silent — see the file-level docstring.
      });
    };
    if (document.readyState === 'complete') {
      onLoad();
    } else {
      window.addEventListener('load', onLoad, { once: true });
    }
  }, []);
  return null;
}
