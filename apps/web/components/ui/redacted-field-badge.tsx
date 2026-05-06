'use client';

import { useLocale, useTranslations } from 'next-intl';
import { EyeOff } from 'lucide-react';

import { getCatalogueLabel } from '@/lib/field-catalogue-mirror';
import { cn } from '@/lib/utils';

/**
 * Phase D5 — D5.9: reusable inline badge that announces "this
 * field is hidden by your role" in a calm, non-alarming way.
 *
 * Behaviour:
 *
 *   • When `field` matches a `lib/field-catalogue-mirror` entry,
 *     the badge renders the field-specific copy, e.g.
 *       EN: "Previous owner is hidden by your role"
 *       AR: "المالك السابق مخفي حسب دورك"
 *
 *   • When the field is unknown to the mirror (or the caller
 *     omits `field`), the badge renders the generic copy:
 *       EN: "Hidden by your role"
 *       AR: "مخفي حسب دورك"
 *
 *   • Visual style is intentionally muted (italic, ink-tertiary,
 *     small icon) — the goal is "you don't have access here" not
 *     "something went wrong".
 *
 *   • RTL-friendly: the icon lives on the leading side via the
 *     `me-1.5` margin which next-intl flips automatically when
 *     `dir="rtl"` is set on the root.
 *
 *   • Mobile-friendly: text wraps; icon stays inline.
 *
 * Server is the source of truth — the badge is UX guidance ONLY.
 * It does NOT decide whether a field is denied; the caller does
 * that via `isFieldDenied(resource, field)` from
 * `lib/permissions`.
 */
export function RedactedFieldBadge({
  resource,
  field,
  className,
  variant = 'inline',
}: {
  /** Catalogue resource (e.g. `'lead'`, `'rotation'`, `'lead.review'`). */
  resource?: string;
  /** Catalogue field key. Optional — generic copy renders without it. */
  field?: string;
  /** Optional extra classes; the badge ships sensible defaults. */
  className?: string;
  /**
   * `'inline'` (default) — small italic span suitable for replacing
   *   a single value inside a row.
   * `'block'` — slightly larger pill-style placeholder for whole
   *   sections (e.g. "Some review context is hidden by your role"
   *   above the missing block).
   */
  variant?: 'inline' | 'block';
}): JSX.Element {
  const t = useTranslations('common');
  const locale = useLocale();

  const label = resource && field ? getCatalogueLabel(resource, field, locale) : null;
  const text = label ? t('fieldHiddenByRole', { field: label }) : t('hiddenByRole');

  const baseClasses =
    variant === 'block'
      ? 'inline-flex items-center gap-1.5 rounded-md border border-surface-border bg-surface px-3 py-1.5 text-xs italic text-ink-tertiary'
      : 'inline-flex items-center gap-1 text-[11px] italic text-ink-tertiary';

  return (
    <span
      role="note"
      aria-label={text}
      data-testid="redacted-field-badge"
      data-resource={resource ?? ''}
      data-field={field ?? ''}
      className={cn(baseClasses, className)}
    >
      <EyeOff className="h-3 w-3 shrink-0" aria-hidden="true" />
      <span>{text}</span>
    </span>
  );
}
