import { useTranslations } from 'next-intl';
import { CircleUserRound } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * User menu placeholder.
 * Renders a non-interactive avatar + label until the real menu (with profile,
 * sessions, logout) is wired in C10/C17.
 */
export function UserMenu({ className }: { className?: string }) {
  const t = useTranslations('header');
  return (
    <div
      className={cn(
        'inline-flex items-center gap-2 rounded-md border border-surface-border bg-surface-card px-3 py-1.5',
        'text-sm text-ink-secondary',
        className,
      )}
      aria-label={t('userMenu')}
    >
      <CircleUserRound className="h-5 w-5 text-ink-tertiary" aria-hidden="true" />
      <span className="hidden sm:inline">{t('userMenu')}</span>
    </div>
  );
}
