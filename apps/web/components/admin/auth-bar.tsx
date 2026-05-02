'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { LogOut, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { NotificationBell } from '@/components/admin/notification-bell';
import { ApiError, authApi } from '@/lib/api';
import {
  clearAuth,
  getAccessToken,
  getCachedMe,
  getTenantCode,
  setCachedMe,
  type MeCache,
} from '@/lib/auth';
import { closeRealtime } from '@/lib/realtime';

/**
 * Admin auth bar.
 *
 * Reads the access token + cached `me` payload from localStorage on mount,
 * tries to refresh the cache via `GET /auth/me`, and shows a sign-in CTA
 * when no token is present. The actual token-storage logic lives in
 * `lib/auth.ts` so the dashboard / list pages can reuse it without
 * duplicating localStorage knobs.
 */
export function AuthBar(): JSX.Element {
  const router = useRouter();
  const t = useTranslations('admin.authBar');
  // Initialise from neutral defaults so SSR and the first client render
  // match (localStorage isn't available on the server). The mount
  // effect populates from localStorage right after hydration.
  const [me, setMe] = useState<MeCache | null>(null);
  const [hasToken, setHasToken] = useState<boolean>(false);
  const [hydrated, setHydrated] = useState<boolean>(false);

  useEffect(() => {
    const token = getAccessToken();
    const cachedMe = getCachedMe();
    setHasToken(Boolean(token));
    setMe(cachedMe);
    setHydrated(true);
    if (!token) return;
    let cancelled = false;
    authApi
      .me()
      .then((u) => {
        if (cancelled) return;
        const tenantCode = getTenantCode() ?? '';
        const next: MeCache = {
          userId: u.id,
          email: u.email,
          name: u.name,
          tenantCode,
          roleCode: u.role.code,
          roleNameEn: u.role.nameEn,
          roleNameAr: u.role.nameAr,
          capabilities: u.capabilities,
        };
        setCachedMe(next);
        setMe(next);
      })
      .catch((err: unknown) => {
        // Only clear the token on a definite 401 — that's the one error
        // that proves the token is no longer accepted. Network blips,
        // CORS preflights, transient 5xx etc. must NOT log the user out
        // (the previous behaviour wiped the token on every failure).
        if (err instanceof ApiError && err.status === 401) {
          clearAuth();
          if (!cancelled) {
            setMe(null);
            setHasToken(false);
          }
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function onSignOut(): void {
    // P3-02 — close the realtime channel so the next user that signs in
    // doesn't reuse the previous user's stream (which is about to start
    // returning 401s).
    closeRealtime();
    clearAuth();
    setMe(null);
    setHasToken(false);
    router.push('/login');
  }

  // Until we've read localStorage on the client we don't know whether a
  // token exists — render a placeholder rather than flashing the
  // "not signed in" CTA between the SSR HTML and the mount effect.
  if (!hydrated) {
    return <div className="h-9 rounded-md border border-surface-border bg-surface-card" />;
  }

  if (!hasToken) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-md border border-status-warning/30 bg-status-warning/10 px-3 py-2 text-sm text-status-warning">
        <div className="flex items-center gap-2">
          <ShieldAlert className="h-4 w-4" aria-hidden="true" />
          <span>{t('notSignedIn')}</span>
        </div>
        <Button variant="primary" size="sm" onClick={() => router.push('/login')}>
          {t('signIn')}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-surface-border bg-surface-card px-3 py-2 text-sm">
      <div className="flex flex-col leading-tight">
        <span className="font-medium text-ink-primary">{me?.name ?? me?.email ?? '…'}</span>
        <span className="text-xs text-ink-secondary">
          {me?.email ?? ''} · {me?.roleNameEn ?? me?.roleCode ?? ''}
          {me?.tenantCode ? ` · ${me.tenantCode}` : ''}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <NotificationBell />
        <Button variant="secondary" size="sm" onClick={onSignOut}>
          <LogOut className="h-3.5 w-3.5" />
          {t('signOut')}
        </Button>
      </div>
    </div>
  );
}
