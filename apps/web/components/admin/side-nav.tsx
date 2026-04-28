'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  LayoutDashboard,
  Building2,
  Globe,
  Users2,
  UserCog,
  ScrollText,
  Contact,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface NavItem {
  href: string;
  labelKey: 'dashboard' | 'companies' | 'countries' | 'teams' | 'users' | 'leads' | 'audit';
  icon: LucideIcon;
  /** When true, the link is rendered but disabled — destination doesn't exist. */
  pending?: boolean;
}

const ITEMS: readonly NavItem[] = [
  { href: '/admin', labelKey: 'dashboard', icon: LayoutDashboard },
  { href: '/admin/companies', labelKey: 'companies', icon: Building2 },
  { href: '/admin/countries', labelKey: 'countries', icon: Globe },
  { href: '/admin/teams', labelKey: 'teams', icon: Users2 },
  { href: '/admin/users', labelKey: 'users', icon: UserCog },
  { href: '/admin/leads', labelKey: 'leads', icon: Contact },
  { href: '/admin/audit', labelKey: 'audit', icon: ScrollText, pending: true },
];

/**
 * Admin side navigation. Active route gets brand styling. C13 enabled the
 * Companies / Countries / Teams / Users / Leads links; Audit is still
 * placeholder until C16.
 */
export function AdminSideNav() {
  const t = useTranslations('admin.sideNav');
  const tCommon = useTranslations('common');
  const pathname = usePathname() ?? '';

  return (
    <nav
      aria-label="Admin"
      className="hidden w-60 shrink-0 border-e border-surface-border bg-surface-card md:block"
    >
      <ul className="flex flex-col gap-0.5 p-3">
        {ITEMS.map((item) => {
          const Icon = item.icon;
          const isActive =
            item.href === '/admin' ? pathname === '/admin' : pathname.startsWith(item.href);

          const className = cn(
            'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
            item.pending
              ? 'cursor-not-allowed text-ink-tertiary'
              : isActive
                ? 'bg-brand-50 font-medium text-brand-700'
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
