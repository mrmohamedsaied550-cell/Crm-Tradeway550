'use client';

import { useTransition } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Languages } from 'lucide-react';
import { setLocaleAction } from '@/lib/actions/locale';
import { cn } from '@/lib/utils';
import type { Locale } from '@/i18n/locale';

/**
 * Toggles the UI between English (LTR) and Arabic (RTL).
 *
 * Calls a server action that writes the NEXT_LOCALE cookie and revalidates
 * the layout — `app/layout.tsx` then renders `<html lang dir>` for the new
 * locale and re-streams the page.
 */
export function LanguageSwitch() {
  const locale = useLocale() as Locale;
  const t = useTranslations('language');
  const [pending, startTransition] = useTransition();

  const next: Locale = locale === 'en' ? 'ar' : 'en';
  const targetLabel = next === 'en' ? t('english') : t('arabic');

  const handleClick = (): void => {
    startTransition(async () => {
      await setLocaleAction(next);
    });
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={pending}
      aria-label={t('switchTo', { target: targetLabel })}
      className={cn(
        'inline-flex items-center gap-2 rounded-md border border-surface-border bg-surface-card px-3 py-1.5',
        'text-sm font-medium text-ink-primary transition-colors',
        'hover:border-brand-300 hover:text-brand-700',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2',
        pending && 'opacity-60 cursor-not-allowed',
      )}
    >
      <Languages className="h-4 w-4" aria-hidden="true" />
      <span>{targetLabel}</span>
    </button>
  );
}
