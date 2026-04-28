import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';

/**
 * Login placeholder.
 *
 * C4 ships only the static markup for layout review. The real auth flow
 * (form validation, server action calling /api/v1/auth/login, error states,
 * lockout messaging, token cookies) lands in C9 (API auth) and C10 (web).
 */
export default function LoginPage() {
  const t = useTranslations('login');

  return (
    <div className="mx-auto flex min-h-[60vh] max-w-md flex-col justify-center">
      <div className="rounded-lg border border-surface-border bg-surface-card p-6 shadow-card">
        <h1 className="text-xl font-semibold text-ink-primary">{t('title')}</h1>
        <p className="mt-2 text-sm text-ink-secondary">{t('subtitle')}</p>

        <form className="mt-6 flex flex-col gap-4">
          <Field label={t('emailLabel')} type="email" autoComplete="username" />
          <Field label={t('passwordLabel')} type="password" autoComplete="current-password" />

          <button
            type="button"
            disabled
            aria-disabled="true"
            className={cn(
              'mt-2 inline-flex h-10 items-center justify-center rounded-md',
              'bg-brand-600 px-4 text-sm font-medium text-white',
              'opacity-60 cursor-not-allowed',
            )}
          >
            {t('submit')}
          </button>

          <p className="text-center text-xs text-ink-tertiary">{t('disabled')}</p>
        </form>
      </div>
    </div>
  );
}

function Field({
  label,
  type,
  autoComplete,
}: {
  label: string;
  type: 'email' | 'password';
  autoComplete: 'username' | 'current-password';
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-ink-primary">{label}</span>
      <input
        type={type}
        autoComplete={autoComplete}
        disabled
        className={cn(
          'h-10 rounded-md border border-surface-border bg-surface px-3 text-sm text-ink-primary',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-1',
          'disabled:opacity-60 disabled:cursor-not-allowed',
        )}
      />
    </label>
  );
}
