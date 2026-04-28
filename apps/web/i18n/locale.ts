/**
 * Locale constants shared between client and server.
 *
 * - `en` is LTR; `ar` is RTL. The HTML `dir` attribute is derived from the
 *   active locale in app/layout.tsx so screens never need to know which.
 * - The active locale is stored in a non-HttpOnly cookie so client UI can
 *   hint at the current selection without a server round-trip on hover.
 */

export const SUPPORTED_LOCALES = ['en', 'ar'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';
export const LOCALE_COOKIE = 'NEXT_LOCALE';

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

export function htmlDirFor(locale: Locale): 'ltr' | 'rtl' {
  return locale === 'ar' ? 'rtl' : 'ltr';
}
