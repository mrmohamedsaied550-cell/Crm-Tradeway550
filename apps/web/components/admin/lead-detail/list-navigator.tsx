'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ChevronLeft, ChevronRight } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { NavigatorPosition } from '@/lib/lead-list-context';

/**
 * Phase B — Navigation/Speed: prev / next walk through the cached
 * list of lead ids the user came from on /admin/leads.
 *
 * When the cache is missing (deep link, expired, Kanban view), the
 * chevrons render disabled and the count is hidden — feature is
 * gracefully absent, never broken.
 *
 * Navigation uses `router.push` (client-side); the lead-detail page
 * already swaps content via its existing `reload()` on id change.
 */
interface ListNavigatorProps {
  /** Resolved from `readListContext(currentLeadId)` by the parent. */
  position: NavigatorPosition | null;
}

export function ListNavigator({ position }: ListNavigatorProps): JSX.Element {
  const router = useRouter();
  const t = useTranslations('admin.leads.detail.navigator');

  const prevHref = position?.prevId ? `/admin/leads/${position.prevId}` : null;
  const nextHref = position?.nextId ? `/admin/leads/${position.nextId}` : null;

  function go(href: string | null): void {
    if (!href) return;
    router.push(href);
  }

  return (
    <div
      className="inline-flex items-center gap-1"
      aria-label={position ? t('label', { pos: position.position, total: position.total }) : ''}
    >
      <NavButton ariaLabel={t('prev')} disabled={!prevHref} onClick={() => go(prevHref)}>
        <ChevronLeft className="h-4 w-4" aria-hidden="true" />
      </NavButton>

      {position ? (
        <span className="px-2 text-xs font-medium text-ink-secondary" aria-live="polite">
          {t('label', { pos: position.position, total: position.total })}
        </span>
      ) : null}

      <NavButton ariaLabel={t('next')} disabled={!nextHref} onClick={() => go(nextHref)}>
        <ChevronRight className="h-4 w-4" aria-hidden="true" />
      </NavButton>
    </div>
  );
}

function NavButton({
  children,
  ariaLabel,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  ariaLabel: string;
  disabled: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      className={cn(
        'inline-flex h-7 w-7 items-center justify-center rounded-md border text-ink-secondary',
        disabled
          ? 'cursor-not-allowed border-surface-border bg-surface text-ink-tertiary opacity-60'
          : 'border-surface-border bg-surface-card hover:bg-brand-50 hover:text-brand-700',
      )}
    >
      {children}
    </button>
  );
}
