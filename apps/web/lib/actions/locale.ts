'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { LOCALE_COOKIE, isLocale, type Locale } from '@/i18n/locale';

/**
 * Persists the active locale in a cookie and revalidates the layout so the
 * server-rendered HTML re-runs `getRequestConfig` with the new value.
 *
 * No auth call, no API call — purely a cookie write. Real per-user locale
 * preference (stored on the User record) is wired in C17 (Account profile).
 */
export async function setLocaleAction(next: Locale): Promise<void> {
  if (!isLocale(next)) {
    throw new Error(`Unsupported locale: ${String(next)}`);
  }

  cookies().set({
    name: LOCALE_COOKIE,
    value: next,
    path: '/',
    sameSite: 'lax',
    httpOnly: false,
    maxAge: 60 * 60 * 24 * 365, // 1 year
  });

  revalidatePath('/', 'layout');
}
