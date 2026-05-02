/**
 * P3-01 — minimal service worker.
 *
 * Strategy is deliberately conservative — we want PWA install-ability
 * + a usable "you're offline" experience, NOT an aggressive cache
 * that risks serving stale auth tokens or stale CRM data.
 *
 *   - install: pre-cache the offline shell only (one tiny HTML).
 *   - fetch:
 *       - never intercept API calls (`/api/...`) — those need fresh
 *         data + auth headers; the SW would only get in the way.
 *       - never intercept POST/PUT/PATCH/DELETE — never cache writes.
 *       - for navigation requests (HTML), try network first and fall
 *         back to the cached offline shell when offline.
 *       - for static assets (`/_next/static/...`), serve cache-first.
 *   - activate: claim clients immediately so updates apply on next
 *     navigation without a hard reload.
 *
 * Bumping `CACHE_VERSION` invalidates every previously-cached entry
 * — bump it whenever the offline-shell HTML or this SW changes.
 */

const CACHE_VERSION = 'v1';
const SHELL_CACHE = `tw-shell-${CACHE_VERSION}`;
const STATIC_CACHE = `tw-static-${CACHE_VERSION}`;
const OFFLINE_URL = '/offline.html';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll([OFFLINE_URL, '/icon.svg', '/apple-touch-icon.svg'])),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k !== SHELL_CACHE && k !== STATIC_CACHE).map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Never cache or intercept the API surface — auth headers + fresh
  // data trump everything else.
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/auth/') ||
    url.pathname.includes('/realtime/')
  ) {
    return;
  }

  // Static Next.js bundle assets — cache-first, opaque-compatible.
  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(
      caches.open(STATIC_CACHE).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        try {
          const res = await fetch(req);
          if (res.ok) cache.put(req, res.clone());
          return res;
        } catch (err) {
          if (hit) return hit;
          throw err;
        }
      }),
    );
    return;
  }

  // Navigation requests (HTML pages) — network first, fall back to
  // the offline shell when the user is offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          return await fetch(req);
        } catch (err) {
          const cache = await caches.open(SHELL_CACHE);
          const offline = await cache.match(OFFLINE_URL);
          return offline ?? Response.error();
        }
      })(),
    );
  }
});
