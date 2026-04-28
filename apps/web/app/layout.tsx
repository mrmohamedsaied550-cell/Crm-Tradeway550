import type { ReactNode } from 'react';

/**
 * @crm/web — root layout placeholder.
 *
 * C1 ships an empty Next.js scaffold. The real shell (login, admin layout,
 * agent PWA shell, i18n provider, theme tokens, language switch) lands in C4.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

export const metadata = {
  title: 'Trade Way CRM',
  description: 'Trade Way / Captain Masr CRM',
};
