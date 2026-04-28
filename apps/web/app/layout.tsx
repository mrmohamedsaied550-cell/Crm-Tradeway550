import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages, getTranslations } from 'next-intl/server';
import { htmlDirFor, type Locale } from '@/i18n/locale';
import { Header } from '@/components/header';
import '@/styles/globals.css';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('app');
  return {
    title: t('name'),
    description: t('tagline'),
  };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = (await getLocale()) as Locale;
  const messages = await getMessages();
  const dir = htmlDirFor(locale);

  return (
    <html lang={locale} dir={dir}>
      <body className="min-h-full">
        <NextIntlClientProvider locale={locale} messages={messages}>
          <Header />
          <main className="mx-auto w-full max-w-screen-2xl px-4 py-6 sm:px-6">{children}</main>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
