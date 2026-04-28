'use client';

import { useState, useEffect, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import { ApiError, authApi } from '@/lib/api';
import { setAccessToken, setCachedMe, setTenantCode, getAccessToken } from '@/lib/auth';

const DEFAULT_TENANT_CODE = 'trade_way_default';

/**
 * Login page wired to POST /api/v1/auth/login.
 *
 * Stores the access token + a cached `me` snapshot in localStorage so the
 * admin shell can render the current user without a second round-trip.
 * Refresh-token cookie storage + rotation flow land in a later chunk;
 * for the C13 admin surface, the access token alone is enough.
 */
export default function LoginPage() {
  const t = useTranslations('login');
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get('next') ?? '/admin';

  const [email, setEmail] = useState<string>('super@tradeway.com');
  const [password, setPassword] = useState<string>('');
  const [tenantCode, setTenantCodeInput] = useState<string>(DEFAULT_TENANT_CODE);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (getAccessToken()) router.replace(next);
  }, [router, next]);

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = await authApi.login({ email, password, tenantCode });
      setAccessToken(result.accessToken);
      setTenantCode(tenantCode);
      setCachedMe({
        userId: result.user.id,
        email: result.user.email,
        name: result.user.name,
        tenantCode,
        roleCode: result.user.role.code,
        roleNameEn: result.user.role.nameEn,
        roleNameAr: result.user.role.nameAr,
      });
      router.push(next);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : t('failed');
      setError(message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-[60vh] max-w-md flex-col justify-center">
      <form
        onSubmit={onSubmit}
        className="rounded-lg border border-surface-border bg-surface-card p-6 shadow-card"
      >
        <h1 className="text-xl font-semibold text-ink-primary">{t('title')}</h1>
        <p className="mt-2 text-sm text-ink-secondary">{t('subtitleActive')}</p>

        <div className="mt-6 flex flex-col gap-4">
          {error ? <Notice tone="error">{error}</Notice> : null}

          <Field label={t('tenantLabel')} required>
            <Input
              value={tenantCode}
              onChange={(e) => setTenantCodeInput(e.target.value)}
              placeholder="trade_way_default"
              autoComplete="organization"
              required
            />
          </Field>

          <Field label={t('emailLabel')} required>
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
              required
            />
          </Field>

          <Field label={t('passwordLabel')} required>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </Field>

          <Button type="submit" className="mt-2 w-full" loading={submitting}>
            {t('submit')}
          </Button>
        </div>
      </form>
    </div>
  );
}
