'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { useBranding } from '@/lib/branding';

/**
 * Sprint 15 (D15) — header brand block.
 *
 * Reads the tenant branding via the cached useBranding() hook and
 * falls back to the i18n `app.name` / `app.tagline` strings when the
 * cache is empty (first render or fetch failure). The header itself
 * remains a server component; this client child is the only piece
 * that needs to subscribe to branding updates.
 */
export function BrandIdentity(): JSX.Element {
  const t = useTranslations('app');
  const branding = useBranding();

  const name = branding?.systemName ?? t('name');
  const tagline = branding?.workspaceName ?? t('tagline');
  const logoUrl = branding?.logoUrl ?? null;
  const initial = (name || 'T').slice(0, 1).toUpperCase();

  return (
    <Link href="/" className="flex items-center gap-2">
      {logoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={logoUrl}
          alt=""
          className="h-7 w-7 rounded-md object-contain"
          // Graceful degradation: a 404/timeout falls back to the
          // initial-letter badge without breaking the whole header.
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.display = 'none';
            const fallback = (e.currentTarget as HTMLImageElement)
              .nextElementSibling as HTMLElement | null;
            if (fallback) fallback.style.display = 'inline-flex';
          }}
        />
      ) : null}
      <span
        className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-brand-600 text-sm font-bold text-white"
        style={logoUrl ? { display: 'none' } : undefined}
        aria-hidden="true"
      >
        {initial}
      </span>
      <span className="flex flex-col leading-tight">
        <span className="text-sm font-semibold text-ink-primary">{name}</span>
        <span className="text-xs text-ink-secondary">{tagline}</span>
      </span>
    </Link>
  );
}
