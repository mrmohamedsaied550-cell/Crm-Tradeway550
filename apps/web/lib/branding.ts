'use client';

import { useEffect, useState } from 'react';

import { tenantSettingsApi, type TenantBranding } from '@/lib/api';

/**
 * Sprint 15 (D15) — module-level branding cache for the admin shell.
 *
 * Pattern mirrors `getCachedMe()` in `@/lib/auth`: branding is read
 * once per session and cached at module level. Components that need
 * the branding values call `useBranding()` and re-render when the
 * fetch resolves. Components that mutate branding (the Settings
 * page) call `refreshBranding()` after their save completes so the
 * sidebar / header / login renderer pick up the new values on their
 * next render without a hard reload.
 *
 * Why not a React Context provider:
 *   • the admin shell has no top-level data provider; every component
 *     fetches what it needs.
 *   • branding is rare-write, frequent-read — a module-level cache
 *     plus a subscriber list is simpler than a Context, lighter on
 *     reflows, and easier to test.
 *   • the login page lives outside the /admin tree and would not be
 *     reached by a Context anchored in /admin/layout.
 *
 * Failure mode: if the fetch fails (401, network, missing endpoint),
 * `cached` stays null and every consumer falls back to the approved
 * design defaults. Branding is purely cosmetic — never block UX on it.
 */

let cached: TenantBranding | null = null;
let inFlight: Promise<TenantBranding> | null = null;
const subscribers = new Set<(value: TenantBranding | null) => void>();

export function getCachedBranding(): TenantBranding | null {
  return cached;
}

/** Fetch branding once per session; subsequent callers share the promise. */
export function loadBranding(): Promise<TenantBranding> {
  if (cached) return Promise.resolve(cached);
  if (inFlight) return inFlight;
  inFlight = tenantSettingsApi
    .getBranding()
    .then((branding) => {
      cached = branding;
      inFlight = null;
      for (const cb of subscribers) cb(branding);
      return branding;
    })
    .catch((err) => {
      inFlight = null;
      throw err;
    });
  return inFlight;
}

/** Refresh the cache after a write. Returns the new value. */
export async function refreshBranding(): Promise<TenantBranding> {
  inFlight = null;
  cached = null;
  return loadBranding();
}

/**
 * React hook: subscribes the calling component to branding changes.
 * Triggers a fetch on first mount if the cache is empty. Returns
 * `null` until the first fetch resolves; consumers must handle the
 * null case by rendering the design defaults.
 */
export function useBranding(): TenantBranding | null {
  const [value, setValue] = useState<TenantBranding | null>(cached);

  useEffect(() => {
    let cancelled = false;
    if (!cached) {
      loadBranding().catch(() => {
        /* swallow — branding is cosmetic */
      });
    }
    const cb = (next: TenantBranding | null): void => {
      if (!cancelled) setValue(next);
    };
    subscribers.add(cb);
    return () => {
      cancelled = true;
      subscribers.delete(cb);
    };
  }, []);

  return value;
}
