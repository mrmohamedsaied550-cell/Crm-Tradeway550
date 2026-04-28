import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';

/**
 * Static role badge placeholder.
 * Real role data is wired in C9 (auth) + C10 (frontend session).
 */
export function RoleBadge({ className }: { className?: string }) {
  const t = useTranslations('header');
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border border-brand-200 bg-brand-50',
        'px-2.5 py-0.5 text-xs font-medium text-brand-800',
        className,
      )}
    >
      {t('rolePlaceholder')}
    </span>
  );
}
