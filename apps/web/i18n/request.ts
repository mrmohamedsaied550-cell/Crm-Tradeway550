import { cookies } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';
import { DEFAULT_LOCALE, LOCALE_COOKIE, isLocale } from './locale';

/**
 * next-intl request config.
 * Reads the locale from a cookie set by the language switch server action.
 * Falls back to DEFAULT_LOCALE when the cookie is absent or invalid.
 */
export default getRequestConfig(async () => {
  const stored = cookies().get(LOCALE_COOKIE)?.value;
  const locale = isLocale(stored) ? stored : DEFAULT_LOCALE;

  return {
    locale,
    messages: (await import(`./messages/${locale}.json`)).default,
  };
});
