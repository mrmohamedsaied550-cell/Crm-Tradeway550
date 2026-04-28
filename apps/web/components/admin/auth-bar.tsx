'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { LogOut, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { authApi } from '@/lib/api';
import {
  clearAuth,
  getAccessToken,
  getCachedMe,
  getTenantCode,
  setCachedMe,
  type MeCache,
} from '@/lib/auth';

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
  const [me, setMe] = useState<MeCache | null>(getCachedMe());
  const [hasToken, setHasToken] = useState<boolean>(Boolean(getAccessToken()));

  useEffect(() => {
    const token = getAccessToken();
    setHasToken(Boolean(token));
    if (!token) {
      setMe(null);
      return;
    }
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
        };
        setCachedMe(next);
        setMe(next);
      })
      .catch(() => {
        // Token expired or invalid — drop it so the UI prompts a re-login.
        clearAuth();
        if (!cancelled) {
          setMe(null);
          setHasToken(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function onSignOut(): void {
    clearAuth();
    setMe(null);
    setHasToken(false);
    router.push('/login');
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
      <Button variant="secondary" size="sm" onClick={onSignOut}>
        <LogOut className="h-3.5 w-3.5" />
        {t('signOut')}
      </Button>
    </div>
  );
}
