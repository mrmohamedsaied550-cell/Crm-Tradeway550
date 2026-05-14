'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import {
  AlertTriangle,
  ArrowRight,
  CalendarClock,
  Clock,
  Inbox,
  PhoneOff,
  RotateCcw,
  ShieldCheck,
  Users2,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Notice } from '@/components/ui/notice';
import { ApiError, followUpsApi, leadsApi, transitionRequestsApi } from '@/lib/api';
import { getCachedMe } from '@/lib/auth';
import { cn } from '@/lib/utils';
import type { Lead, LeadFollowUp, LeadTransitionRequestRow } from '@/lib/api-types';

/**
 * Sprint 5.2 — status-prefix that drives the "No Answer" queue.
 * Every status code starting with this prefix counts as
 * "no answer" (e.g. `no_answer_1`, `no_answer_2`, future
 * `no_answer_n`). Centralised here so the dashboard tile count
 * + the queue list call the same filter and stay in sync.
 */
export const NO_ANSWER_STATUS_PREFIX = 'no_answer';

/**
 * Sprint 5.1 — Queue-specific list views.
 *
 * The /admin/leads page can't show "Due Today", "Returned to me",
 * etc. through its existing Lead DataTable because each queue's
 * data source is different:
 *
 *   dueToday        ← followUpsApi.mine, filtered to today's bucket
 *   followUpMine    ← followUpsApi.mine (all pending)
 *   returnedToMe    ← transitionRequestsApi.mine('rejected')
 *   waitingApproval ← transitionRequestsApi.mine('pending')
 *   approverQueue   ← transitionRequestsApi.approverQueue()
 *
 * Each view renders a queue-specific card list (not the lead
 * DataTable), with the right context per row:
 *   - Follow-up rows: lead name, due/snooze, action type, note.
 *   - Transition rows: lead name, from→to stage, requested
 *     status, approval state, rejection reason when relevant.
 *
 * Every row links to /admin/leads/<leadId>. Empty states say
 * "no records for this queue" — never "all leads with a notice".
 *
 * For queues that still don't have a clean data source (today:
 * `noAnswer`, `teamLeads`, `agentBreakdown`, `returnedHandoffs`)
 * the component renders an explicit "coming next" notice with
 * the missing endpoint surfaced in the body. No fake data, no
 * fallback to "all leads".
 *
 * Permission notes:
 *   - `transitionRequestsApi.approverQueue` is gated by
 *     `lead.transition.approve` on the server. We catch 403 and
 *     render the no-access notice so a viewer without the cap
 *     sees an explanation, not a blank list.
 *   - `followUpsApi.mine` + `transitionRequestsApi.mine` are
 *     scoped to the caller; no extra UI gating needed.
 */

export type SpecializedQueueKey =
  | 'dueToday'
  | 'followUpMine'
  | 'returnedToMe'
  | 'waitingApproval'
  | 'approverQueue'
  | 'noAnswer'
  | 'teamLeads'
  | 'agentBreakdown'
  | 'returnedHandoffs';

interface QueueListViewProps {
  queue: SpecializedQueueKey;
}

/** True for queues this component renders with real, queue-specific
 *  data. Other keys fall through to a "coming next" notice. */
export function isWiredQueue(q: string | null | undefined): q is SpecializedQueueKey {
  return (
    q === 'dueToday' ||
    q === 'followUpMine' ||
    q === 'returnedToMe' ||
    q === 'waitingApproval' ||
    q === 'approverQueue' ||
    q === 'noAnswer'
  );
}

export function QueueListView({ queue }: QueueListViewProps): JSX.Element {
  if (queue === 'dueToday' || queue === 'followUpMine') {
    return <FollowUpQueue queue={queue} />;
  }
  if (queue === 'returnedToMe' || queue === 'waitingApproval' || queue === 'approverQueue') {
    return <TransitionRequestQueue queue={queue} />;
  }
  if (queue === 'noAnswer') {
    return <NoAnswerQueue />;
  }
  // Honest gap state for the queues that still need backend work.
  return <PendingQueue queue={queue} />;
}

// ─────────────────────────────────────────────────────────────────
//  Follow-up queues
// ─────────────────────────────────────────────────────────────────

function FollowUpQueue({ queue }: { queue: 'dueToday' | 'followUpMine' }): JSX.Element {
  const t = useTranslations('admin.leads.queueViews');
  const locale = useLocale();

  const [items, setItems] = useState<readonly LeadFollowUp[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const all = await followUpsApi.mine({ status: 'pending', limit: 100 });
      const me = getCachedMe();
      const mine = me ? all.filter((f) => f.assignedToId === me.userId) : all;
      const filtered =
        queue === 'dueToday' ? mine.filter((f) => isDueToday(f.dueAt, f.snoozedUntil)) : mine;
      // Sort soonest-due first; same convention as the existing
      // calendar / inbox surfaces.
      const sorted = [...filtered].sort((a, b) => {
        const ad = new Date(effectiveDueAt(a)).getTime();
        const bd = new Date(effectiveDueAt(b)).getTime();
        return ad - bd;
      });
      setItems(sorted);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [queue]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (loading) {
    return (
      <QueueCard>
        <p className="text-sm text-ink-tertiary">{t('loading')}</p>
      </QueueCard>
    );
  }
  if (error) {
    return <Notice tone="error">{error}</Notice>;
  }
  if (items.length === 0) {
    return (
      <QueueEmpty
        icon={
          queue === 'dueToday' ? (
            <CalendarClock className="h-8 w-8" aria-hidden="true" />
          ) : (
            <Clock className="h-8 w-8" aria-hidden="true" />
          )
        }
        title={t(`empty.${queue}.title` as 'empty.dueToday.title')}
        body={t(`empty.${queue}.body` as 'empty.dueToday.body')}
      />
    );
  }

  return (
    <QueueCard>
      <QueueHeader count={items.length} label={t(`heading.${queue}` as 'heading.dueToday')} />
      <ul className="flex flex-col divide-y divide-surface-border">
        {items.map((f) => (
          <FollowUpRow key={f.id} followUp={f} locale={locale} t={t} />
        ))}
      </ul>
    </QueueCard>
  );
}

function FollowUpRow({
  followUp,
  locale,
  t,
}: {
  followUp: LeadFollowUp;
  locale: string;
  t: ReturnType<typeof useTranslations>;
}): JSX.Element {
  const due = new Date(effectiveDueAt(followUp));
  const now = new Date();
  const overdue = due.getTime() < now.getTime();
  const tone = overdue
    ? 'breach'
    : isDueToday(followUp.dueAt, followUp.snoozedUntil)
      ? 'warning'
      : 'info';
  const leadName = followUp.lead?.name ?? t('unknownLead');
  return (
    <li>
      <Link
        href={`/admin/leads/${followUp.leadId}`}
        className="flex items-start gap-3 p-3 transition-colors hover:bg-brand-50"
      >
        <span
          className={cn(
            'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md',
            tone === 'breach'
              ? 'bg-status-breach/10 text-status-breach'
              : tone === 'warning'
                ? 'bg-status-warning/10 text-status-warning'
                : 'bg-status-info/10 text-status-info',
          )}
        >
          {overdue ? (
            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
          ) : (
            <Clock className="h-4 w-4" aria-hidden="true" />
          )}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-ink-primary">{leadName}</span>
            <Badge tone={tone}>
              {overdue
                ? t('chip.overdue')
                : isDueToday(followUp.dueAt, followUp.snoozedUntil)
                  ? t('chip.dueToday')
                  : t('chip.upcoming')}
            </Badge>
            <Badge tone="neutral">{followUp.actionType}</Badge>
          </div>
          <p className="text-xs text-ink-secondary">
            {t('dueAt', { when: due.toLocaleString(locale === 'ar' ? 'ar' : 'en') })}
          </p>
          {followUp.note ? (
            <p className="truncate text-xs text-ink-secondary">{followUp.note}</p>
          ) : null}
        </div>
        <ArrowRight className="mt-1 h-4 w-4 shrink-0 text-ink-tertiary" aria-hidden="true" />
      </Link>
    </li>
  );
}

// ─────────────────────────────────────────────────────────────────
//  Transition-request queues
// ─────────────────────────────────────────────────────────────────

function TransitionRequestQueue({
  queue,
}: {
  queue: 'returnedToMe' | 'waitingApproval' | 'approverQueue';
}): JSX.Element {
  const t = useTranslations('admin.leads.queueViews');
  const locale = useLocale();

  const [items, setItems] = useState<readonly LeadTransitionRequestRow[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [forbidden, setForbidden] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    setForbidden(false);
    try {
      const fetcher =
        queue === 'returnedToMe'
          ? transitionRequestsApi.mine('rejected')
          : queue === 'waitingApproval'
            ? transitionRequestsApi.mine('pending')
            : transitionRequestsApi.approverQueue();
      const all = await fetcher;
      setItems(all);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setForbidden(true);
      } else {
        setError(err instanceof ApiError ? err.message : String(err));
      }
    } finally {
      setLoading(false);
    }
  }, [queue]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (loading) {
    return (
      <QueueCard>
        <p className="text-sm text-ink-tertiary">{t('loading')}</p>
      </QueueCard>
    );
  }
  if (forbidden) {
    return (
      <Notice tone="info">
        <p className="text-sm font-medium">{t('noAccess.title')}</p>
        <p className="mt-1 text-xs text-ink-secondary">
          {t(`noAccess.${queue}` as 'noAccess.approverQueue')}
        </p>
      </Notice>
    );
  }
  if (error) {
    return <Notice tone="error">{error}</Notice>;
  }
  if (items.length === 0) {
    const icon =
      queue === 'returnedToMe' ? (
        <RotateCcw className="h-8 w-8" aria-hidden="true" />
      ) : (
        <ShieldCheck className="h-8 w-8" aria-hidden="true" />
      );
    return (
      <QueueEmpty
        icon={icon}
        title={t(`empty.${queue}.title` as 'empty.returnedToMe.title')}
        body={t(`empty.${queue}.body` as 'empty.returnedToMe.body')}
      />
    );
  }

  return (
    <QueueCard>
      <QueueHeader count={items.length} label={t(`heading.${queue}` as 'heading.returnedToMe')} />
      <ul className="flex flex-col divide-y divide-surface-border">
        {items.map((r) => (
          <TransitionRow key={r.id} request={r} locale={locale} t={t} />
        ))}
      </ul>
    </QueueCard>
  );
}

function TransitionRow({
  request,
  locale,
  t,
}: {
  request: LeadTransitionRequestRow;
  locale: string;
  t: ReturnType<typeof useTranslations>;
}): JSX.Element {
  // Lead name lives in the optional `lead` join on the service
  // response; gracefully fall back to the leadId when it's not
  // present (e.g. older payloads).
  // Cast to access optional join field added by Sprint 5.A.
  const leadName =
    (request as unknown as { lead?: { name: string; phone: string } }).lead?.name ??
    t('unknownLead');
  const isRejected = request.state === 'rejected';
  const tone = isRejected ? 'breach' : 'warning';
  const submittedAt = new Date(request.createdAt);
  return (
    <li>
      <Link
        href={`/admin/leads/${request.leadId}`}
        className="flex items-start gap-3 p-3 transition-colors hover:bg-brand-50"
      >
        <span
          className={cn(
            'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md',
            tone === 'breach'
              ? 'bg-status-breach/10 text-status-breach'
              : 'bg-status-warning/10 text-status-warning',
          )}
        >
          {isRejected ? (
            <RotateCcw className="h-4 w-4" aria-hidden="true" />
          ) : (
            <Clock className="h-4 w-4" aria-hidden="true" />
          )}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-ink-primary">{leadName}</span>
            <Badge tone={tone}>{t(`chip.${request.state}` as 'chip.rejected')}</Badge>
          </div>
          <p className="text-xs text-ink-secondary">
            {request.fromStage.name} <ArrowRight className="inline h-3 w-3" aria-hidden="true" />{' '}
            {request.toStage.name}
            {request.requestedStatusCode ? ` · ${request.requestedStatusCode}` : ''}
          </p>
          <p className="text-[11px] text-ink-tertiary">
            {t('submittedAt', { when: submittedAt.toLocaleString(locale === 'ar' ? 'ar' : 'en') })}
          </p>
          {isRejected && request.decisionReason ? (
            <p className="text-xs text-status-breach">
              <span className="font-semibold">{t('rejectionReason')}:</span>{' '}
              {request.decisionReason}
            </p>
          ) : null}
        </div>
        <ArrowRight className="mt-1 h-4 w-4 shrink-0 text-ink-tertiary" aria-hidden="true" />
      </Link>
    </li>
  );
}

// ─────────────────────────────────────────────────────────────────
//  No Answer queue (Sprint 5.2 — LIVE)
// ─────────────────────────────────────────────────────────────────

/**
 * Sprint 5.2 — leads whose `currentStageStatus.status` starts with
 * `no_answer` (no_answer_1, no_answer_2, future no_answer_n).
 *
 * Uses the existing `leadsApi.list` with the new
 * `currentStatusCodePrefix` filter (Sprint 5.2 backend) so the
 * count + the list always match. Scoped to the caller by default
 * (the existing list endpoint already applies the role's scope
 * `where` clause); the agent sees only their own no-answer
 * leads, the TL+ sees the team's set.
 */
function NoAnswerQueue(): JSX.Element {
  const t = useTranslations('admin.leads.queueViews');
  const tDetail = useTranslations('admin.leads.detail');
  const locale = useLocale();

  const [items, setItems] = useState<readonly Lead[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const me = getCachedMe();
      const page = await leadsApi.list({
        currentStatusCodePrefix: NO_ANSWER_STATUS_PREFIX,
        ...(me ? { assignedToId: me.userId } : {}),
        limit: 100,
      });
      setItems(page.items);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (loading) {
    return (
      <QueueCard>
        <p className="text-sm text-ink-tertiary">{t('loading')}</p>
      </QueueCard>
    );
  }
  if (error) {
    return <Notice tone="error">{error}</Notice>;
  }
  if (items.length === 0) {
    return (
      <QueueEmpty
        icon={<PhoneOff className="h-8 w-8" aria-hidden="true" />}
        title={t('empty.noAnswer.title')}
        body={t('empty.noAnswer.body')}
      />
    );
  }
  return (
    <QueueCard>
      <QueueHeader count={items.length} label={t('heading.noAnswer')} />
      <ul className="flex flex-col divide-y divide-surface-border">
        {items.map((lead) => (
          <NoAnswerRow key={lead.id} lead={lead} locale={locale} t={t} tDetail={tDetail} />
        ))}
      </ul>
    </QueueCard>
  );
}

function NoAnswerRow({
  lead,
  locale,
  t,
  tDetail,
}: {
  lead: Lead;
  locale: string;
  t: ReturnType<typeof useTranslations>;
  tDetail: ReturnType<typeof useTranslations>;
}): JSX.Element {
  // The list response carries `currentStageStatus` when the
  // server populated it; defensive fallback to the lead's
  // stage code so the row still reads cleanly if a slim
  // response slips through.
  const statusCode = lead.currentStageStatus?.status ?? null;
  const lastResponse = lead.lastResponseAt
    ? new Date(lead.lastResponseAt).toLocaleString(locale === 'ar' ? 'ar' : 'en')
    : null;
  return (
    <li>
      <Link
        href={`/admin/leads/${lead.id}`}
        className="flex items-start gap-3 p-3 transition-colors hover:bg-brand-50"
      >
        <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-status-warning/10 text-status-warning">
          <PhoneOff className="h-4 w-4" aria-hidden="true" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-ink-primary">{lead.name}</span>
            <Badge tone="warning">{statusCode ?? t('chip.noAnswer')}</Badge>
            {lead.stage?.name ? <Badge tone="neutral">{lead.stage.name}</Badge> : null}
          </div>
          <p className="text-xs text-ink-secondary">{lead.phone}</p>
          {lastResponse ? (
            <p className="text-[11px] text-ink-tertiary">
              {tDetail('lastActivity.label')}: {lastResponse}
            </p>
          ) : null}
        </div>
        <ArrowRight className="mt-1 h-4 w-4 shrink-0 text-ink-tertiary" aria-hidden="true" />
      </Link>
    </li>
  );
}

// ─────────────────────────────────────────────────────────────────
//  Pending queues (honest gap state)
// ─────────────────────────────────────────────────────────────────

function PendingQueue({
  queue,
}: {
  queue: 'teamLeads' | 'agentBreakdown' | 'returnedHandoffs';
}): JSX.Element {
  const t = useTranslations('admin.leads.queueViews');
  return (
    <QueueEmpty
      icon={<Users2 className="h-8 w-8" aria-hidden="true" />}
      title={t(`pending.${queue}.title` as 'pending.teamLeads.title')}
      body={t(`pending.${queue}.body` as 'pending.teamLeads.body')}
    />
  );
}

// ─────────────────────────────────────────────────────────────────
//  Shared chrome
// ─────────────────────────────────────────────────────────────────

function QueueCard({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <section className="overflow-hidden rounded-lg border border-surface-border bg-surface-card shadow-card">
      {children}
    </section>
  );
}

function QueueHeader({ count, label }: { count: number; label: string }): JSX.Element {
  return (
    <header className="flex items-center justify-between border-b border-surface-border bg-surface px-4 py-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-tertiary">{label}</h3>
      <Badge tone="info">{count}</Badge>
    </header>
  );
}

function QueueEmpty({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}): JSX.Element {
  return (
    <section className="rounded-lg border border-dashed border-surface-border bg-surface-card p-10 text-center">
      <span className="inline-flex items-center justify-center text-ink-tertiary">
        {icon ?? <Inbox className="h-8 w-8" aria-hidden="true" />}
      </span>
      <p className="mt-2 text-sm font-medium text-ink-primary">{title}</p>
      <p className="mt-1 max-w-md text-xs text-ink-secondary">{body}</p>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────

function effectiveDueAt(f: LeadFollowUp): string {
  if (!f.snoozedUntil) return f.dueAt;
  const dueMs = new Date(f.dueAt).getTime();
  const snoozeMs = new Date(f.snoozedUntil).getTime();
  return snoozeMs > dueMs ? f.snoozedUntil : f.dueAt;
}

function isDueToday(dueAt: string, snoozedUntil: string | null): boolean {
  const due = new Date(
    snoozedUntil && new Date(snoozedUntil).getTime() > new Date(dueAt).getTime()
      ? snoozedUntil
      : dueAt,
  );
  const now = new Date();
  return (
    due.getFullYear() === now.getFullYear() &&
    due.getMonth() === now.getMonth() &&
    due.getDate() === now.getDate()
  );
}
