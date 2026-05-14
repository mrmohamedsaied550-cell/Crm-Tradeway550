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
  History,
  Network,
  ScanSearch,
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
    | 'pipelineBuilder'
    | 'captains'
    | 'bonuses'
    | 'competitions'
    | 'whatsapp'
    | 'whatsappReviews'
    | 'whatsappTemplates'
    | 'leadReviews'
    | 'metaLeadSources'
    | 'reports'
    | 'audit'
    | 'tenantSettings'
    | 'calendar'
    | 'distribution'
    | 'lostReasons'
    | 'roles'
    | 'backup'
    | 'partnerSources'
    | 'partnerSnapshots'
    | 'partnerReconciliation'
    | 'partnerMilestones';
  icon: LucideIcon;
  /** P2-01 — capability required to see this link. Dashboard / Leads /
   *  Captains are visible to anyone authenticated. */
  cap?: string;
  /** When true, the link is rendered but disabled — destination doesn't exist. */
  pending?: boolean;
}

/**
 * Sprint 0 — primary operational navigation. Legacy Pipeline
 * (`/admin/pipeline`) has been removed from the primary surface;
 * stage/status workflow lives in the Leads workspace + lead detail
 * pages. Pipeline Builder moved to the Advanced group below so the
 * primary list stays focused on day-to-day operational pages.
 */
const PRIMARY_ITEMS: readonly NavItem[] = [
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
  // Phase D3 — D3.6: TL Review Queue (lead reviews). Distinct from
  // WhatsApp Reviews — same proven D1.5 UX pattern but a separate
  // model + page. Visible only to roles with `lead.review.read`
  // (TLs / ops_manager / account_manager / super_admin).
  {
    href: '/admin/lead-reviews',
    labelKey: 'leadReviews',
    icon: ShieldQuestion,
    cap: 'lead.review.read',
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
  // Phase D4 — D4.2: Partner Data Hub admin (sources + mappings).
  // Visible to TL+ via `partner.source.read`. Configuration only —
  // sync engine, snapshots, verification card, merge, milestones
  // ship in D4.3 — D4.7.
  {
    href: '/admin/partner-sources',
    labelKey: 'partnerSources',
    icon: Network,
    cap: 'partner.source.read',
  },
  // Phase D4 — D4.3: snapshot history (read-only). Same capability
  // gate as partner sources — anyone who can configure can audit.
  {
    href: '/admin/partner-snapshots',
    labelKey: 'partnerSnapshots',
    icon: History,
    cap: 'partner.source.read',
  },
  // Phase D4 — D4.6: reconciliation report. Visible with
  // `partner.reconciliation.read` (TL+); the "Open as review"
  // action gates separately on `partner.reconciliation.resolve`.
  {
    href: '/admin/partner-reconciliation',
    labelKey: 'partnerReconciliation',
    icon: ScanSearch,
    cap: 'partner.reconciliation.read',
  },
  // Phase D4 — D4.7: milestone configs + commission CSVs. Read
  // gated on `partner.verification.read` so a TL inspecting can
  // see the configs; write actions on `partner.milestone.write`.
  {
    href: '/admin/partner-milestones',
    labelKey: 'partnerMilestones',
    icon: Flag,
    cap: 'partner.verification.read',
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
];

/**
 * Sprint 0 — Advanced / admin-only tools. These pages are kept
 * reachable for power users (super_admin / ops) but pushed below a
 * section header so they don't compete with the primary day-to-day
 * navigation. Add new "infrequent but important" pages here.
 */
const ADVANCED_ITEMS: readonly NavItem[] = [
  // Pipeline Builder moved from primary nav (Sprint 0). Stage/status
  // configuration is an infrequent admin task; agents and TLs don't
  // need it in their daily flow.
  {
    href: '/admin/pipeline-builder',
    labelKey: 'pipelineBuilder',
    icon: Layers,
    cap: 'pipeline.read',
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
  // D1.5/D1.6 — best-effort count badge for the review queue.
  // Initially fetched once on mount when the actor has
  // whatsapp.review.read; D1.6 also re-fetches whenever the
  // review queue page dispatches `whatsapp.review.count.invalidate`
  // so a resolve action drops the badge live. A failed call is
  // silently dropped so a transient backend issue never blanks
  // the nav.
  const [reviewCount, setReviewCount] = useState<number>(0);
  useEffect(() => {
    const me = getCachedMe();
    const c = me?.capabilities ?? [];
    setCaps(c);
    if (!c.includes('whatsapp.review.read')) return undefined;
    function refreshCount(): void {
      reviewsApi
        .count()
        .then((r) => setReviewCount(r.unresolved))
        .catch(() => {
          /* silent — nav must never break on count fetch */
        });
    }
    refreshCount();
    function onInvalidate(): void {
      refreshCount();
    }
    window.addEventListener('whatsapp.review.count.invalidate', onInvalidate);
    return () => {
      window.removeEventListener('whatsapp.review.count.invalidate', onInvalidate);
    };
  }, []);

  function visible(items: readonly NavItem[]): readonly NavItem[] {
    return items.filter((item) => {
      if (!item.cap) return true;
      if (caps === null) return true;
      return caps.includes(item.cap);
    });
  }

  const primary = visible(PRIMARY_ITEMS);
  const advanced = visible(ADVANCED_ITEMS);

  function renderItem(item: NavItem) {
    const Icon = item.icon;
    const isActive =
      item.href === '/admin' ? pathname === '/admin' : pathname.startsWith(item.href);

    // Sprint 0 — dark sidebar palette. Inactive links sit at slate-300
    // on the navy bg; hover lifts to slate-700 with white text; active
    // route also uses the hover bg with white text plus a subtle
    // emerald accent border on the inline-start edge so the current
    // page reads at a glance.
    const className = cn(
      'group relative flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
      item.pending
        ? 'cursor-not-allowed text-sidebar-textMuted/70'
        : isActive
          ? 'bg-sidebar-hover font-medium text-sidebar-textActive'
          : 'text-sidebar-text hover:bg-sidebar-hover hover:text-sidebar-textActive',
    );

    const showReviewBadge = item.labelKey === 'whatsappReviews' && reviewCount > 0;
    const content = (
      <>
        {isActive ? (
          <span
            aria-hidden="true"
            className="absolute inset-y-1 start-0 w-0.5 rounded-full bg-brand-500"
          />
        ) : null}
        <Icon className="h-4 w-4" aria-hidden="true" />
        <span className="flex-1">{t(item.labelKey)}</span>
        {showReviewBadge ? (
          <span
            className="inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-status-warning/20 px-1.5 text-[11px] font-semibold text-status-warning"
            aria-label={t('whatsappReviewsBadge', { n: reviewCount })}
          >
            {reviewCount > 99 ? '99+' : reviewCount}
          </span>
        ) : null}
        {item.pending ? (
          <span className="text-[11px] font-medium uppercase text-sidebar-textMuted/70">
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
  }

  return (
    <nav
      aria-label="Admin"
      className="hidden w-60 shrink-0 self-stretch border-e border-sidebar-border bg-sidebar-bg md:block"
    >
      <div className="flex h-full flex-col gap-1 p-3">
        <ul className="flex flex-col gap-0.5">{primary.map(renderItem)}</ul>
        {advanced.length > 0 ? (
          <>
            <div className="mt-4 px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-sidebar-textMuted">
              {t('advanced')}
            </div>
            <ul className="flex flex-col gap-0.5">{advanced.map(renderItem)}</ul>
          </>
        ) : null}
      </div>
    </nav>
  );
}
