import Link from 'next/link';
import { useTranslations } from 'next-intl';
import {
  LayoutDashboard,
  Building2,
  Globe,
  Users2,
  UserCog,
  ScrollText,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface NavItem {
  href: string;
  labelKey: 'dashboard' | 'companies' | 'countries' | 'teams' | 'users' | 'audit';
  icon: LucideIcon;
  /**
   * When true, the link is rendered but disabled — the destination route
   * does not exist yet. Removed when the matching chunk lands.
   */
  pending?: boolean;
}

const ITEMS: readonly NavItem[] = [
  { href: '/admin', labelKey: 'dashboard', icon: LayoutDashboard },
  { href: '/admin/companies', labelKey: 'companies', icon: Building2, pending: true },
  { href: '/admin/countries', labelKey: 'countries', icon: Globe, pending: true },
  { href: '/admin/teams', labelKey: 'teams', icon: Users2, pending: true },
  { href: '/admin/users', labelKey: 'users', icon: UserCog, pending: true },
  { href: '/admin/audit', labelKey: 'audit', icon: ScrollText, pending: true },
];

/**
 * Admin Insight Mode side navigation.
 *
 * C4 ships only the structure. The Companies / Countries / Teams / Users /
 * Audit destinations land in C12–C16 (and matching backend modules earlier).
 * Pending items are styled as disabled and do not navigate.
 */
export function AdminSideNav() {
  const t = useTranslations('admin.sideNav');
  const tCommon = useTranslations('common');

  return (
    <nav
      aria-label="Admin"
      className="hidden w-60 shrink-0 border-e border-surface-border bg-surface-card md:block"
    >
      <ul className="flex flex-col gap-0.5 p-3">
        {ITEMS.map((item) => {
          const Icon = item.icon;
          const className = cn(
            'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
            item.pending
              ? 'cursor-not-allowed text-ink-tertiary'
              : 'text-ink-secondary hover:bg-brand-50 hover:text-brand-700',
          );

          const content = (
            <>
              <Icon className="h-4 w-4" aria-hidden="true" />
              <span className="flex-1">{t(item.labelKey)}</span>
              {item.pending ? (
                <span className="text-[11px] font-medium uppercase text-ink-tertiary">
                  {tCommon('comingSoon')}
                </span>
              ) : null}
            </>
          );

          return (
            <li key={item.href}>
              {item.pending ? (
                <span className={className} aria-disabled="true">
                  {content}
                </span>
              ) : (
                <Link href={item.href} className={className}>
                  {content}
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
