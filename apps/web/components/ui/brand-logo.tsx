'use client';

import { useState } from 'react';

import { cn } from '@/lib/utils';

/**
 * Sprint 15 (D15) — partner / company brand logo with initials fallback.
 *
 * Mirrors the Avatar pattern but reads `name` + `src` + optional
 * `brandColor` for the fallback disc background. When the URL is set
 * AND loads, the image renders inside a square card. When missing or
 * broken, a rounded-square disc shows the first letters of the name
 * tinted with `brandColor` (or the neutral surface tone if unset).
 *
 * Distinct from <Avatar> (rounded-full + brand-tinted) so partner /
 * company logos read as "brand identity" rather than "person".
 */

type Size = 'sm' | 'md' | 'lg';

const SIZE_CLASS: Record<Size, string> = {
  sm: 'h-6 w-6 text-[10px]',
  md: 'h-8 w-8 text-xs',
  lg: 'h-10 w-10 text-sm',
};

interface BrandLogoProps {
  name: string | null | undefined;
  src?: string | null;
  brandColor?: string | null;
  size?: Size;
  className?: string;
}

export function BrandLogo({
  name,
  src,
  brandColor,
  size = 'md',
  className,
}: BrandLogoProps): JSX.Element {
  const [broken, setBroken] = useState<boolean>(false);
  const showImage = Boolean(src) && !broken;
  const initials = computeBrandInitials(name);
  // Only honour a strict #rrggbb value; anything else falls back to
  // the neutral disc so a bad value never blows up the layout.
  const safeBrandColor = brandColor && /^#[0-9a-f]{6}$/iu.test(brandColor) ? brandColor : null;

  return (
    <span
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-md text-white font-semibold',
        SIZE_CLASS[size],
        safeBrandColor ? '' : 'bg-surface-muted text-ink-secondary',
        className,
      )}
      style={safeBrandColor ? { backgroundColor: safeBrandColor } : undefined}
      aria-hidden="true"
    >
      {showImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src!}
          alt=""
          className="h-full w-full object-contain"
          onError={() => setBroken(true)}
        />
      ) : (
        <span>{initials}</span>
      )}
    </span>
  );
}

export function computeBrandInitials(name: string | null | undefined): string {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/u);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + (parts[1]![0] ?? '')).toUpperCase();
}
