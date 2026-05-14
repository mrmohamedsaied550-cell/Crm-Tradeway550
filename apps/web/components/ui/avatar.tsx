'use client';

import { useState } from 'react';

import { cn } from '@/lib/utils';

/**
 * Sprint 15 (D15) — reusable Avatar with image-or-initials fallback.
 *
 * Single rule: the consumer hands over a name + optional URL. If the
 * URL is set AND the image loads, render the image. Otherwise render
 * the initials in a brand-tinted disc. On image load error the
 * component flips back to initials automatically.
 *
 * Presence-dot compatibility: the disc is `position: relative` and
 * has stable dimensions per `size`, so callers can absolutely-
 * position a presence dot in the corner without breaking layout.
 *
 * Sizes follow Tailwind's standard scale: 'sm' = 6px square,
 * 'md' = 8px, 'lg' = 10px. The text size scales with the disc so
 * initials read consistently.
 */

type Size = 'xs' | 'sm' | 'md' | 'lg';

const SIZE_CLASS: Record<Size, string> = {
  xs: 'h-5 w-5 text-[10px]',
  sm: 'h-6 w-6 text-[10px]',
  md: 'h-8 w-8 text-xs',
  lg: 'h-10 w-10 text-sm',
};

interface AvatarProps {
  name: string | null | undefined;
  src?: string | null;
  size?: Size;
  className?: string;
  /** When set, the disc gets this background instead of brand-50. */
  toneClass?: string;
}

export function Avatar({ name, src, size = 'md', className, toneClass }: AvatarProps): JSX.Element {
  const [broken, setBroken] = useState<boolean>(false);
  const showImage = Boolean(src) && !broken;
  const initials = computeInitials(name);

  return (
    <span
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-semibold',
        SIZE_CLASS[size],
        toneClass ?? 'bg-brand-50 text-brand-700',
        className,
      )}
      aria-hidden="true"
    >
      {showImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src!}
          alt=""
          className="h-full w-full object-cover"
          onError={() => setBroken(true)}
        />
      ) : (
        <span>{initials}</span>
      )}
    </span>
  );
}

/**
 * Two-letter initials computed from the full name. Falls back to "?"
 * when the name is empty so the disc never collapses or shows blank.
 */
export function computeInitials(name: string | null | undefined): string {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/u);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + (parts[1]![0] ?? '')).toUpperCase();
}
