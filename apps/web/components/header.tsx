import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { LanguageSwitch } from './language-switch';
import { RoleBadge } from './role-badge';
import { UserMenu } from './user-menu';

/**
 * Global header rendered by the root layout.
 * Composes brand + language switch + role badge placeholder + user menu placeholder.
 */
export function Header() {
  const t = useTranslations('app');
  return (
    <header className="sticky top-0 z-30 border-b border-surface-border bg-surface-card">
      <div className="mx-auto flex h-14 w-full max-w-screen-2xl items-center justify-between gap-4 px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2">
          <span
            className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-brand-600 text-sm font-bold text-white"
            aria-hidden="true"
          >
            T
          </span>
          <span className="flex flex-col leading-tight">
            <span className="text-sm font-semibold text-ink-primary">{t('name')}</span>
            <span className="text-xs text-ink-secondary">{t('tagline')}</span>
          </span>
        </Link>

        <div className="flex items-center gap-3">
          <RoleBadge className="hidden sm:inline-flex" />
          <LanguageSwitch />
          <UserMenu />
        </div>
      </div>
    </header>
  );
}
