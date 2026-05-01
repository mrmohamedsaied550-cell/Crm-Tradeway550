'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { getAccessToken } from '@/lib/auth';

/**
 * Admin auth guard.
 *
 * Wraps the admin shell so an unauthenticated visitor is redirected to
 * `/login?next=<current>` before any child page tries to fetch data.
 *
 * Without this guard, navigating to `/admin/leads` (or any deep link)
 * without a stored token causes the page's mount-time `apiFetch` to
 * fire with no Authorization header — the server replies 401
 * ("Missing or malformed Authorization header") and the user sees a
 * data-load error even though the right answer is "you're not signed in".
 *
 * Implementation notes:
 *   - localStorage is browser-only, so the token check runs in
 *     `useEffect` after hydration. `checked` flips true on the first
 *     check; until then we render a neutral placeholder so the SSR HTML
 *     and the first client paint match.
 *   - This is a defence-in-depth gate. The server is still the
 *     authoritative auth check via `JwtAuthGuard` on every protected
 *     route. The guard just keeps the UX clean.
 */
export function AdminAuthGuard({ children }: { children: ReactNode }): JSX.Element {
  const router = useRouter();
  const pathname = usePathname();
  const [checked, setChecked] = useState<boolean>(false);
  const [hasToken, setHasToken] = useState<boolean>(false);

  useEffect(() => {
    const token = getAccessToken();
    if (!token) {
      const next = pathname && pathname !== '/login' ? `?next=${encodeURIComponent(pathname)}` : '';
      router.replace(`/login${next}`);
      return;
    }
    setHasToken(true);
    setChecked(true);
  }, [pathname, router]);

  if (!checked || !hasToken) {
    return <div className="h-32" aria-hidden="true" />;
  }
  return <>{children}</>;
}
