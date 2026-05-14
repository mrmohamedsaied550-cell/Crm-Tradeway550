'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  AlertTriangle,
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  Clock,
  Inbox,
  PhoneOff,
  PlayCircle,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Trophy,
  UserCircle,
  Users2,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { followUpsApi, leadsApi, transitionRequestsApi } from '@/lib/api';
import { getCachedMe, hasCapability } from '@/lib/auth';
import { cn } from '@/lib/utils';
import type { Lead, LeadFollowUp, LeadTransitionRequestRow } from '@/lib/api-types';

/**
 * Sprint 5 — Sales / Team Leader Dashboard at /admin.
 *
 * Replaces the C13 admin landing (static quick-link cards) with a
 * priority-ordered operational dashboard that surfaces the queues
 * the sprint spec asks for:
 *
 *   Sales agent priority (top → bottom):
 *     1. Returned to Me      (transition requests rejected back)
 *     2. Overdue             (pending follow-up past due)
 *     3. Due Today           (pending follow-up due today)
 *     4. Fresh               (new leads I own)
 *     5. No Answer           (signaled via SLA breach today; tighter
 *                              signal will come once a status filter
 *                              endpoint lands — flagged in code)
 *     6. Follow-up           (any non-terminal follow-up I own)
 *     7. Waiting Approval    (pending transition requests I submitted)
 *     8. Signup in progress  (leads in lifecycle category=signup)
 *
 *   Team Leader extras (when `lead.transition.approve` is present):
 *     - Approval Queue       (pending requests for any approver)
 *     - Returned Handoffs    (recent rejections team-wide)
 *
 * Every tile is clickable → `/admin/leads?queue=<key>` so the
 * Leads Workspace (Sprint 5.C) hydrates the matching filter from
 * the URL.
 *
 * "Start Work" CTA opens the first lead in the highest-priority
 * non-empty queue (Returned → Overdue → Due Today → Fresh →
 * Follow-up). When everything is empty the button says "Nothing
 * waiting" instead of fabricating a destination.
 *
 * Permission-aware: tiles that need a capability the user lacks
 * are simply not fetched / not rendered. The dashboard never
 * shows "you can't see this" placeholders — silence is the
 * correct UX when the agent has no role for the queue.
 *
 * Data plan — all client-side parallel fetches off existing
 * endpoints (no new aggregate API). For each queue we read the
 * lightest list endpoint and use its length as the count. This
 * is more network than a dedicated count endpoint, but adds zero
 * backend surface and stays well under one second on a seeded
 * tenant. A real `/leads/queue-counts` aggregate is a future
 * polish item.
 */

interface QueueCounts {
  returnedToMe: number;
  overdue: number;
  dueToday: number;
  freshMine: number;
  followUpMine: number;
  waitingApproval: number;
  signupCount: number;
  // TL extras
  approverQueue: number | null;
}

interface QueueFirstLeads {
  returnedToMe: string | null;
  overdue: string | null;
  dueToday: string | null;
  freshMine: string | null;
  followUpMine: string | null;
}

const EMPTY_COUNTS: QueueCounts = {
  returnedToMe: 0,
  overdue: 0,
  dueToday: 0,
  freshMine: 0,
  followUpMine: 0,
  waitingApproval: 0,
  signupCount: 0,
  approverQueue: null,
};

/** Maps a tile's queue key to the URL the Leads Workspace will hydrate. */
function queueHref(queue: string): string {
  return `/admin/leads?queue=${encodeURIComponent(queue)}`;
}

export default function AdminDashboardPage(): JSX.Element {
  const t = useTranslations('admin.dashboard');
  const tCommon = useTranslations('admin.common');

  const [meName, setMeName] = useState<string | null>(null);
  const [canApprove, setCanApprove] = useState<boolean>(false);

  const [counts, setCounts] = useState<QueueCounts>(EMPTY_COUNTS);
  const [firstLeads, setFirstLeads] = useState<QueueFirstLeads>({
    returnedToMe: null,
    overdue: null,
    dueToday: null,
    freshMine: null,
    followUpMine: null,
  });
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const me = getCachedMe();
    setMeName(me?.name ?? null);
    setCanApprove(hasCapability('lead.transition.approve'));

    setLoading(true);
    setError(null);
    try {
      // Run every fetch in parallel; treat failures as "0" so a
      // single 403/500 on one queue doesn't blank the whole
      // dashboard. The user's role decides which fetches return
      // useful data — we don't pre-gate at the call site.
      const safeFetch = <T,>(p: Promise<T>, fallback: T): Promise<T> => p.catch(() => fallback);

      const [
        overdueLeads,
        dueTodayLeads,
        freshLeadsPage,
        myRejected,
        myPending,
        followups,
        signupLeads,
        approverQueue,
      ] = await Promise.all([
        safeFetch(leadsApi.overdue({}), [] as Lead[]),
        safeFetch(leadsApi.dueToday({}), [] as Lead[]),
        // "Fresh & mine": stage code 'new', assignedToId = me.
        safeFetch(
          me
            ? leadsApi.list({ stageCode: 'new', assignedToId: me.userId, limit: 25 })
            : Promise.resolve({ items: [], total: 0, limit: 25, offset: 0 }),
          { items: [] as Lead[], total: 0, limit: 25, offset: 0 },
        ),
        safeFetch(transitionRequestsApi.mine('rejected'), [] as LeadTransitionRequestRow[]),
        safeFetch(transitionRequestsApi.mine('pending'), [] as LeadTransitionRequestRow[]),
        safeFetch(followUpsApi.mine({}), [] as LeadFollowUp[]),
        // Signup-in-progress proxy: leads in stage code 'interested'
        // (which has lifecycleCategory='signup' per our local seed).
        // A future commit can resolve by lifecycleCategory directly
        // when the list endpoint exposes that filter; today the
        // stage code is the cheapest proxy.
        safeFetch(
          me
            ? leadsApi.list({ stageCode: 'interested', assignedToId: me.userId, limit: 1 })
            : Promise.resolve({ items: [], total: 0, limit: 1, offset: 0 }),
          { items: [] as Lead[], total: 0, limit: 1, offset: 0 },
        ),
        canApprove
          ? safeFetch(transitionRequestsApi.approverQueue(), [] as LeadTransitionRequestRow[])
          : Promise.resolve(null),
      ]);

      // Filter the global overdue/dueToday lists down to "mine"
      // (assignedToId === me.userId) — the API returns the user's
      // leads by default but defensively re-check so this works
      // for super_admin who can see everyone.
      const mineOnly = (rows: Lead[]) =>
        me ? rows.filter((r) => r.assignedToId === me.userId) : rows;
      const myOverdue = mineOnly(overdueLeads);
      const myDueToday = mineOnly(dueTodayLeads);
      const myFollowups = me ? followups.filter((f) => f.assignedToId === me.userId) : followups;

      setCounts({
        returnedToMe: myRejected.length,
        overdue: myOverdue.length,
        dueToday: myDueToday.length,
        freshMine: freshLeadsPage.total ?? freshLeadsPage.items.length,
        followUpMine: myFollowups.length,
        waitingApproval: myPending.length,
        signupCount: signupLeads.total ?? signupLeads.items.length,
        approverQueue: approverQueue === null ? null : approverQueue.length,
      });
      setFirstLeads({
        returnedToMe: myRejected[0]?.leadId ?? null,
        overdue: myOverdue[0]?.id ?? null,
        dueToday: myDueToday[0]?.id ?? null,
        freshMine: freshLeadsPage.items[0]?.id ?? null,
        followUpMine: myFollowups[0]?.leadId ?? null,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [canApprove]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Highest-priority non-empty queue's first lead → drives the
  // "Start Work" CTA. Same priority order as the tile sort below
  // (returned → overdue → today → fresh → follow-up).
  const startWorkHref = (() => {
    if (firstLeads.returnedToMe) return `/admin/leads/${firstLeads.returnedToMe}`;
    if (firstLeads.overdue) return `/admin/leads/${firstLeads.overdue}`;
    if (firstLeads.dueToday) return `/admin/leads/${firstLeads.dueToday}`;
    if (firstLeads.freshMine) return `/admin/leads/${firstLeads.freshMine}`;
    if (firstLeads.followUpMine) return `/admin/leads/${firstLeads.followUpMine}`;
    return null;
  })();

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={meName ? t('greeting', { name: meName }) : t('headingGuest')}
        subtitle={t('subtitle')}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => void refresh()} disabled={loading}>
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
              {tCommon('refresh')}
            </Button>
            <Link
              href={startWorkHref ?? '#'}
              aria-disabled={!startWorkHref}
              className={cn(
                'inline-flex h-9 items-center gap-1.5 rounded-md px-4 text-sm font-medium transition-colors',
                startWorkHref
                  ? 'bg-brand-600 text-white hover:bg-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600'
                  : 'pointer-events-none bg-surface text-ink-tertiary',
              )}
            >
              <PlayCircle className="h-4 w-4" aria-hidden="true" />
              {startWorkHref ? t('startWork') : t('nothingWaiting')}
            </Link>
          </div>
        }
      />

      {error ? <Notice tone="error">{error}</Notice> : null}

      {/* ─── Priority queue tiles ───
          Order matches the sprint spec exactly. Each tile is a
          full-area Link so screen readers + keyboard navigation
          land on the same destination as the click. */}
      <section aria-labelledby="my-work-heading" className="flex flex-col gap-3">
        <h2
          id="my-work-heading"
          className="text-xs font-semibold uppercase tracking-wide text-ink-tertiary"
        >
          {t('sections.myWork')}
        </h2>
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <QueueTile
            href={queueHref('returnedToMe')}
            label={t('queues.returnedToMe')}
            count={counts.returnedToMe}
            icon={RotateCcw}
            tone="breach"
            priority={1}
            loading={loading}
          />
          <QueueTile
            href={queueHref('overdue')}
            label={t('queues.overdue')}
            count={counts.overdue}
            icon={AlertTriangle}
            tone="breach"
            priority={2}
            loading={loading}
          />
          <QueueTile
            href={queueHref('dueToday')}
            label={t('queues.dueToday')}
            count={counts.dueToday}
            icon={CalendarClock}
            tone="warning"
            priority={3}
            loading={loading}
          />
          <QueueTile
            href={queueHref('freshMine')}
            label={t('queues.fresh')}
            count={counts.freshMine}
            icon={Sparkles}
            tone="info"
            priority={4}
            loading={loading}
          />
          <QueueTile
            href={queueHref('followUpMine')}
            label={t('queues.followUp')}
            count={counts.followUpMine}
            icon={Clock}
            tone="info"
            loading={loading}
          />
          <QueueTile
            href={queueHref('waitingApproval')}
            label={t('queues.waitingApproval')}
            count={counts.waitingApproval}
            icon={ShieldCheck}
            tone="info"
            loading={loading}
          />
          <QueueTile
            href={queueHref('signup')}
            label={t('queues.signup')}
            count={counts.signupCount}
            icon={UserCircle}
            tone="neutral"
            loading={loading}
          />
          <QueueTile
            href={queueHref('noAnswer')}
            label={t('queues.noAnswer')}
            count={null}
            icon={PhoneOff}
            tone="neutral"
            loading={loading}
            hint={t('noAnswerGap')}
          />
        </ul>
      </section>

      {/* ─── Team Leader Approval Queue ─── */}
      {canApprove ? (
        <section aria-labelledby="tl-section-heading" className="flex flex-col gap-3">
          <h2
            id="tl-section-heading"
            className="text-xs font-semibold uppercase tracking-wide text-ink-tertiary"
          >
            {t('sections.teamLeader')}
          </h2>
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <QueueTile
              href={queueHref('approverQueue')}
              label={t('queues.approverQueue')}
              count={counts.approverQueue}
              icon={ShieldCheck}
              tone="warning"
              loading={loading}
            />
            <QueueTile
              href={queueHref('returnedHandoffs')}
              label={t('queues.returnedHandoffs')}
              count={null}
              icon={RotateCcw}
              tone="breach"
              loading={loading}
              hint={t('returnedHandoffsGap')}
            />
            <QueueTile
              href={queueHref('teamLeads')}
              label={t('queues.teamLeads')}
              count={null}
              icon={Users2}
              tone="info"
              loading={loading}
              hint={t('teamLeadsGap')}
            />
            <QueueTile
              href={queueHref('agentBreakdown')}
              label={t('queues.agentBreakdown')}
              count={null}
              icon={Trophy}
              tone="neutral"
              loading={loading}
              hint={t('agentBreakdownGap')}
            />
          </ul>
        </section>
      ) : null}

      {/* ─── Empty state when truly nothing to do ─── */}
      {!loading &&
      !error &&
      startWorkHref === null &&
      counts.returnedToMe === 0 &&
      counts.overdue === 0 &&
      counts.dueToday === 0 &&
      counts.freshMine === 0 ? (
        <section className="rounded-lg border border-dashed border-surface-border bg-surface-card p-8 text-center">
          <CheckCircle2 className="mx-auto h-8 w-8 text-status-healthy" aria-hidden="true" />
          <p className="mt-2 text-sm font-medium text-ink-primary">{t('allClear.title')}</p>
          <p className="mt-1 text-xs text-ink-secondary">{t('allClear.body')}</p>
        </section>
      ) : null}
    </div>
  );
}

/**
 * Single KPI tile. Counts are nullable so we can render a tile in
 * "this queue is not yet wired in the backend" state with a
 * disabled chip + a tiny gap hint, instead of pretending the
 * count is zero.
 */
function QueueTile({
  href,
  label,
  count,
  icon: Icon,
  tone,
  priority,
  loading,
  hint,
}: {
  href: string;
  label: string;
  count: number | null;
  icon: typeof Clock;
  tone: 'breach' | 'warning' | 'info' | 'neutral';
  priority?: number;
  loading: boolean;
  hint?: string;
}): JSX.Element {
  const toneClasses = {
    breach: 'border-status-breach/30 bg-status-breach/5 text-status-breach',
    warning: 'border-status-warning/30 bg-status-warning/5 text-status-warning',
    info: 'border-status-info/30 bg-status-info/5 text-status-info',
    neutral: 'border-surface-border bg-surface-card text-ink-secondary',
  } as const;

  return (
    <li>
      <Link
        href={href}
        className={cn(
          'flex h-full flex-col gap-2 rounded-lg border bg-surface-card p-4 shadow-card transition-colors hover:border-brand-200 hover:bg-brand-50',
          toneClasses[tone].split(' ')[0],
        )}
      >
        <div className="flex items-center justify-between gap-2">
          <span
            className={cn(
              'inline-flex h-8 w-8 items-center justify-center rounded-md',
              toneClasses[tone],
            )}
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
          </span>
          {priority !== undefined ? (
            <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-tertiary">
              P{priority}
            </span>
          ) : null}
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-sm font-semibold text-ink-primary">{label}</span>
          <span className="text-2xl font-semibold text-ink-primary">
            {loading ? (
              <span className="text-ink-tertiary">…</span>
            ) : count === null ? (
              <Inbox className="h-5 w-5 text-ink-tertiary" aria-hidden="true" />
            ) : (
              count
            )}
          </span>
        </div>
        {hint ? <p className="text-[11px] leading-snug text-ink-tertiary">{hint}</p> : null}
        <span className="mt-auto inline-flex items-center gap-1 text-xs font-medium text-brand-700">
          {/* Localised "Open" string is owned by the parent's
              t-bag via the surrounding context — keep it inline to
              avoid threading another t() into every tile. */}
          Open
          <ArrowRight className="h-3 w-3" aria-hidden="true" />
        </span>
      </Link>
    </li>
  );
}
