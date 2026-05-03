'use client';

import { useEffect, useState } from 'react';

/**
 * Phase 1 — K1.5: SSR-safe media-query hook.
 *
 * Returns `false` on the server so the first render on every device
 * matches (no hydration mismatch). On the client, syncs to the live
 * result after mount and listens for breakpoint changes.
 *
 * Usage: `const isMobile = useMediaQuery('(max-width: 767px)')`.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(false);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(query);
    const apply = (): void => setMatches(mql.matches);
    apply();
    // `addEventListener` is the modern API; older Safari needs the
    // legacy addListener fallback. Both are wired so the hook works
    // everywhere without warnings.
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', apply);
      return () => mql.removeEventListener('change', apply);
    }
    // Legacy Safari fallback. The `addListener`/`removeListener`
    // methods are deprecated but still functional; we keep the
    // fallback so older iOS browsers don't lose responsive behaviour.
    type LegacyMql = {
      addListener?: (cb: () => void) => void;
      removeListener?: (cb: () => void) => void;
    };
    (mql as unknown as LegacyMql).addListener?.(apply);
    return () => {
      (mql as unknown as LegacyMql).removeListener?.(apply);
    };
  }, [query]);

  return matches;
}

/** Mobile breakpoint (`< 768px`). Matches Tailwind's `md:` boundary. */
export function useIsMobile(): boolean {
  return useMediaQuery('(max-width: 767px)');
}
