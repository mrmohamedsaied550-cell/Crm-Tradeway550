import type { ReactNode } from 'react';
import type { Metadata, Viewport } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages, getTranslations } from 'next-intl/server';
import { htmlDirFor, type Locale } from '@/i18n/locale';
import { Header } from '@/components/header';
import { ServiceWorkerRegister } from '@/components/sw-register';
import '@/styles/globals.css';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('app');
  return {
    title: t('name'),
    description: t('tagline'),
    manifest: '/manifest.webmanifest',
    /**
     * P3-01 — iOS Safari needs the legacy `apple-mobile-web-app-*`
     * meta tags to treat the site as a standalone web app. Android
     * Chrome reads `manifest.webmanifest` + `theme-color` (the
     * latter lives on Viewport in Next 14+).
     */
    appleWebApp: {
      capable: true,
      statusBarStyle: 'default',
      title: t('name'),
    },
    icons: {
      icon: [{ url: '/icon.svg', type: 'image/svg+xml' }],
      apple: [{ url: '/apple-touch-icon.svg', sizes: '180x180', type: 'image/svg+xml' }],
    },
  };
}

/**
 * P3-01 — viewport + theme-color. The `width=device-width` /
 * `initial-scale=1` pair is required for any sane mobile rendering;
 * without it iOS Safari pretends the document is 980px wide.
 * `themeColor` paints the address bar in standalone mode and matches
 * the brand `--brand-600` from globals.css.
 */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#1f3864',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = (await getLocale()) as Locale;
  const messages = await getMessages();
  const dir = htmlDirFor(locale);

  return (
    <html lang={locale} dir={dir}>
      <body className="min-h-full">
        <NextIntlClientProvider locale={locale} messages={messages}>
          <Header />
          <main className="mx-auto w-full max-w-screen-2xl px-3 py-4 sm:px-6 sm:py-6">
            {children}
          </main>
          <ServiceWorkerRegister />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
