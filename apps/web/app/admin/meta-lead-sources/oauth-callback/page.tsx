'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { CheckCircle2, XCircle } from 'lucide-react';

/**
 * Sprint M2 / Phase 3 — popup landing page for the Meta OAuth flow.
 *
 * The backend's /api/v1/meta/auth/callback route exchanges the code,
 * upserts the MetaOAuthConnection, and 302-redirects here with
 * `?connectionId=<uuid>` when the operator started from a popup.
 *
 * This page:
 *   1. Reads `connectionId` from the URL.
 *   2. `postMessage`s `{ type: 'meta-oauth-complete', connectionId }`
 *      to `window.opener` (constrained to the same origin so a hostile
 *      tab can't intercept it).
 *   3. Auto-closes after a short delay.
 *
 * Falls back to an error message when the URL is missing the param —
 * e.g. when the operator opens this page directly without going
 * through the OAuth dance, or when the backend redirected with
 * `?error=...` because Facebook returned a denial.
 */
export default function MetaOAuthCallbackPage(): JSX.Element {
  const t = useTranslations('admin.metaIntegration.oauthCallback');
  const params = useSearchParams();
  const connectionId = params.get('connectionId');
  const errorParam = params.get('error');

  const [posted, setPosted] = useState<boolean>(false);

  useEffect(() => {
    if (!connectionId || posted) return;
    if (typeof window === 'undefined' || !window.opener) return;
    try {
      window.opener.postMessage(
        { type: 'meta-oauth-complete', connectionId },
        window.location.origin,
      );
    } catch {
      // postMessage to a foreign-origin opener throws — that means the
      // operator's tab navigated away. Nothing to recover.
    }
    setPosted(true);
    const timer = window.setTimeout(() => {
      window.close();
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [connectionId, posted]);

  const ok = typeof connectionId === 'string' && connectionId.length > 0;

  return (
    <main className="flex min-h-screen items-center justify-center bg-surface px-6">
      <section className="flex max-w-md flex-col items-center gap-3 rounded-lg border border-surface-border bg-surface-card p-8 text-center shadow-card">
        {ok ? (
          <>
            <CheckCircle2 className="h-10 w-10 text-status-healthy" aria-hidden="true" />
            <h1 className="text-lg font-semibold text-ink-primary">{t('successTitle')}</h1>
            <p className="text-sm text-ink-secondary">{t('successBody')}</p>
            <p className="text-xs text-ink-tertiary">{t('autoClose')}</p>
          </>
        ) : (
          <>
            <XCircle className="h-10 w-10 text-status-breach" aria-hidden="true" />
            <h1 className="text-lg font-semibold text-ink-primary">{t('errorTitle')}</h1>
            <p className="text-sm text-ink-secondary">
              {errorParam ? t('errorBodyWith', { error: errorParam }) : t('errorBody')}
            </p>
            <button
              type="button"
              className="text-xs font-medium text-brand-700 underline"
              onClick={() => window.close()}
            >
              {t('closeButton')}
            </button>
          </>
        )}
      </section>
    </main>
  );
}
