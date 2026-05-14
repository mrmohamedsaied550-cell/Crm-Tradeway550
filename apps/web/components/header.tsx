import { BrandIdentity } from './brand-identity';
import { LanguageSwitch } from './language-switch';
import { RoleBadge } from './role-badge';
import { UserMenu } from './user-menu';

/**
 * Global header rendered by the root layout.
 * Composes brand + language switch + role badge placeholder + user menu placeholder.
 *
 * Sprint 15 (D15) — the brand block is delegated to <BrandIdentity>, a
 * client component that subscribes to tenant branding and falls back
 * to the i18n defaults when no tenant logo / system name is set.
 */
export function Header() {
  return (
    <header className="sticky top-0 z-30 border-b border-surface-border bg-surface-card">
      <div className="mx-auto flex h-14 w-full max-w-screen-2xl items-center justify-between gap-4 px-4 sm:px-6">
        <BrandIdentity />

        <div className="flex items-center gap-3">
          <RoleBadge className="hidden sm:inline-flex" />
          <LanguageSwitch />
          <UserMenu />
        </div>
      </div>
    </header>
  );
}
