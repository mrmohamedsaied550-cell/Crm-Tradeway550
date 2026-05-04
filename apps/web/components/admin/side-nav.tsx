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
  MessageSquareDashed,
  ShieldQuestion,
  Megaphone,
  Calendar,
  Database,
  BarChart3,
  Settings,
  Route,
  XCircle,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { reviewsApi } from '@/lib/api';
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
    | 'whatsappReviews'
    | 'whatsappTemplates'
    | 'metaLeadSources'
    | 'reports'
    | 'audit'
    | 'tenantSettings'
    | 'calendar'
    | 'distribution'
    | 'lostReasons'
    | 'roles'
    | 'backup';
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
  // Phase C — C8: dynamic permission system role manager. Visible to
  // anyone with `roles.read` (super_admin / ops_manager / account_manager
  // by default). System roles render read-only with a Duplicate action.
  { href: '/admin/roles', labelKey: 'roles', icon: ShieldCheck, cap: 'roles.read' },
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
  // D1.5 — WhatsApp Review Queue. Visible only to roles with
  // whatsapp.review.read (super_admin / ops_manager / account_manager
  // by default; TLs see read-only). Renders an unresolved-count
  // badge on the link itself when the count endpoint succeeds —
  // a failed count call is silently dropped so the nav never
  // breaks on a transient backend issue.
  {
    href: '/admin/whatsapp/reviews',
    labelKey: 'whatsappReviews',
    icon: ShieldQuestion,
    cap: 'whatsapp.review.read',
  },
  {
    href: '/admin/whatsapp/templates',
    labelKey: 'whatsappTemplates',
    icon: MessageSquareDashed,
    cap: 'whatsapp.template.read',
  },
  // PL-2 + PL-4 — Meta lead-ad sources admin page (was backend-only).
  {
    href: '/admin/meta-lead-sources',
    labelKey: 'metaLeadSources',
    icon: Megaphone,
    cap: 'meta.leadsource.read',
  },
  // PL-4 — Calendar lives at /agent/calendar but is useful to managers
  // too; we link to the same surface from the admin sidebar so TLs and
  // ops can see their team's follow-ups without bouncing into agent mode.
  { href: '/agent/calendar', labelKey: 'calendar', icon: Calendar, cap: 'followup.read' },
  { href: '/admin/reports', labelKey: 'reports', icon: BarChart3, cap: 'report.read' },
  // Phase 1A — A9: distribution-engine admin (rules / capacities / logs).
  // Gated on `distribution.read` so agents never see it.
  {
    href: '/admin/distribution',
    labelKey: 'distribution',
    icon: Route,
    cap: 'distribution.read',
  },
  { href: '/admin/audit', labelKey: 'audit', icon: ScrollText, cap: 'audit.read' },
  {
    href: '/admin/tenant-settings',
    labelKey: 'tenantSettings',
    icon: Settings,
    cap: 'tenant.settings.read',
  },
  // Phase A — A6: per-tenant lost-reason catalogue. Same capability
  // as the rest of tenant-level settings; admins manage which reasons
  // appear in the agent's lost-stage modal.
  {
    href: '/admin/lost-reasons',
    labelKey: 'lostReasons',
    icon: XCircle,
    cap: 'tenant.settings.read',
  },
  // PL-4 — backup page (P3-07) was reachable only via direct URL.
  // Capability is `tenant.export` (super_admin / ops_manager /
  // account_manager only) so agents never see it.
  { href: '/admin/backup', labelKey: 'backup', icon: Database, cap: 'tenant.export' },
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
  // D1.5 — best-effort count badge for the review queue. Fetched
  // once on mount when the actor has whatsapp.review.read; a
  // failed call is silently dropped so a transient backend issue
  // never blanks the nav.
  const [reviewCount, setReviewCount] = useState<number>(0);
  useEffect(() => {
    const me = getCachedMe();
    const c = me?.capabilities ?? [];
    setCaps(c);
    if (c.includes('whatsapp.review.read')) {
      reviewsApi
        .count()
        .then((r) => setReviewCount(r.unresolved))
        .catch(() => {
          /* silent — nav must never break on count fetch */
        });
    }
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

          const showReviewBadge = item.labelKey === 'whatsappReviews' && reviewCount > 0;
          const content = (
            <>
              <Icon className="h-4 w-4" aria-hidden="true" />
              <span className="flex-1">{t(item.labelKey)}</span>
              {showReviewBadge ? (
                <span
                  className="inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-status-warning/15 px-1.5 text-[11px] font-semibold text-status-warning"
                  aria-label={t('whatsappReviewsBadge', { n: reviewCount })}
                >
                  {reviewCount > 99 ? '99+' : reviewCount}
                </span>
              ) : null}
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
