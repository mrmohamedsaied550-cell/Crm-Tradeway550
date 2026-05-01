'use client';

import { useEffect, useState } from 'react';
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
  Columns,
  Layers,
  Trophy,
  Award,
  Flag,
  MessagesSquare,
  BarChart3,
  Settings,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { getCachedMe } from '@/lib/auth';

interface NavItem {
  href: string;
  labelKey:
    | 'dashboard'
    | 'companies'
    | 'countries'
    | 'teams'
    | 'users'
    | 'leads'
    | 'pipeline'
    | 'pipelineBuilder'
    | 'captains'
    | 'bonuses'
    | 'competitions'
    | 'whatsapp'
    | 'reports'
    | 'audit'
    | 'tenantSettings';
  icon: LucideIcon;
  /** P2-01 — capability required to see this link. Dashboard / Leads /
   *  Captains / Pipeline are visible to anyone authenticated. */
  cap?: string;
  /** When true, the link is rendered but disabled — destination doesn't exist. */
  pending?: boolean;
}

const ITEMS: readonly NavItem[] = [
  { href: '/admin', labelKey: 'dashboard', icon: LayoutDashboard },
  { href: '/admin/companies', labelKey: 'companies', icon: Building2, cap: 'org.company.read' },
  { href: '/admin/countries', labelKey: 'countries', icon: Globe, cap: 'org.country.read' },
  { href: '/admin/teams', labelKey: 'teams', icon: Users2, cap: 'org.team.read' },
  { href: '/admin/users', labelKey: 'users', icon: UserCog, cap: 'users.read' },
  { href: '/admin/leads', labelKey: 'leads', icon: Contact, cap: 'lead.read' },
  { href: '/admin/pipeline', labelKey: 'pipeline', icon: Columns, cap: 'pipeline.read' },
  {
    href: '/admin/pipeline-builder',
    labelKey: 'pipelineBuilder',
    icon: Layers,
    cap: 'pipeline.read',
  },
  { href: '/admin/captains', labelKey: 'captains', icon: Trophy, cap: 'captain.read' },
  { href: '/admin/bonuses', labelKey: 'bonuses', icon: Award, cap: 'bonus.read' },
  { href: '/admin/competitions', labelKey: 'competitions', icon: Flag, cap: 'competition.read' },
  {
    href: '/admin/whatsapp',
    labelKey: 'whatsapp',
    icon: MessagesSquare,
    cap: 'whatsapp.conversation.read',
  },
  { href: '/admin/reports', labelKey: 'reports', icon: BarChart3, cap: 'report.read' },
  { href: '/admin/audit', labelKey: 'audit', icon: ScrollText, cap: 'audit.read' },
  {
    href: '/admin/tenant-settings',
    labelKey: 'tenantSettings',
    icon: Settings,
    cap: 'tenant.settings.read',
  },
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

  // P2-01 — read capabilities from the cached me payload after
  // hydration. Pre-hydration we render every link; after the effect
  // we filter to those the user can read. This avoids both an SSR
  // mismatch and a flash-of-empty-nav while localStorage loads.
  const [caps, setCaps] = useState<readonly string[] | null>(null);
  useEffect(() => {
    const me = getCachedMe();
    setCaps(me?.capabilities ?? []);
  }, []);

  const visible = ITEMS.filter((item) => {
    if (!item.cap) return true;
    if (caps === null) return true;
    return caps.includes(item.cap);
  });

  return (
    <nav
      aria-label="Admin"
      className="hidden w-60 shrink-0 border-e border-surface-border bg-surface-card md:block"
    >
      <ul className="flex flex-col gap-0.5 p-3">
        {visible.map((item) => {
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
