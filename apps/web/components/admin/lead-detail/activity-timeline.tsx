'use client';

import { useMemo } from 'react';
import {
  ArrowRightLeft,
  CalendarPlus,
  Check,
  Clock,
  Phone,
  Settings,
  StickyNote,
  TriangleAlert,
  UserPlus,
  Users,
} from 'lucide-react';

import { EmptyState } from '@/components/ui/empty-state';
import type { LeadActivity, LeadActivityType, LeadFollowUp } from '@/lib/api-types';
import { cn } from '@/lib/utils';

/**
 * Phase B — B2: chat-like activity timeline.
 *
 * Two improvements over the previous flat list:
 *
 *  1. Merges follow-up events (created / completed / snoozed) with
 *     the existing activity stream so the timeline tells the full
 *     story — no need to hop to a separate calendar to see when a
 *     follow-up was scheduled.
 *
 *  2. Visually separates user actions (note, call) from system
 *     events (stage change, assignment, SLA breach, follow-up
 *     events). User actions sit on the trailing edge with a brand-
 *     tinted bubble; system events sit on the leading edge with
 *     subdued styling. Both align RTL-correctly via `self-end` /
 *     `self-start` in a flex column.
 *
 *  3. Day separators ("Today" / "Yesterday" / dated) so a long
 *     timeline reads in chunks rather than as one wall of rows.
 *
 * No backend changes — the snooze event is reliably derived from
 * `updatedAt > createdAt` while `completedAt` is null and
 * `snoozedUntil` is set, since the only field UpdateFollowUpDto
 * accepts today is `snoozedUntil` (lead-followups patch endpoint
 * is single-purpose).
 */

type Tone = 'info' | 'warning' | 'breach' | 'neutral' | 'healthy';

function activityTone(type: LeadActivityType): Tone {
  switch (type) {
    case 'sla_breach':
      return 'breach';
    case 'assignment':
    case 'auto_assignment':
      return 'info';
    case 'stage_change':
      return 'warning';
    case 'note':
    case 'call':
      return 'healthy';
    default:
      return 'neutral';
  }
}

const ACTIVITY_ICON: Record<LeadActivityType, React.ComponentType<{ className?: string }>> = {
  note: StickyNote,
  call: Phone,
  stage_change: ArrowRightLeft,
  assignment: UserPlus,
  auto_assignment: Users,
  sla_breach: TriangleAlert,
  system: Settings,
};

const TONE_CLASS: Record<Tone, { dot: string; bubble: string }> = {
  info: { dot: 'bg-status-info', bubble: 'border-brand-200 bg-brand-50/60' },
  warning: { dot: 'bg-status-warning', bubble: 'border-status-warning/30 bg-status-warning/5' },
  breach: { dot: 'bg-status-breach', bubble: 'border-status-breach/30 bg-status-breach/5' },
  healthy: { dot: 'bg-status-healthy', bubble: 'border-status-healthy/30 bg-status-healthy/5' },
  neutral: { dot: 'bg-ink-tertiary', bubble: 'border-surface-border bg-surface' },
};

interface PayloadShape {
  fromStageCode?: string;
  toStageCode?: string;
  fromUserId?: string | null;
  toUserId?: string | null;
  strategy?: string;
  captainId?: string;
  reason?: string;
}

function readPayload(raw: Record<string, unknown> | null): PayloadShape {
  if (!raw) return {};
  const out: PayloadShape = {};
  if (typeof raw['fromStageCode'] === 'string') out.fromStageCode = raw['fromStageCode'];
  if (typeof raw['toStageCode'] === 'string') out.toStageCode = raw['toStageCode'];
  if (typeof raw['fromUserId'] === 'string' || raw['fromUserId'] === null)
    out.fromUserId = raw['fromUserId'] as string | null;
  if (typeof raw['toUserId'] === 'string' || raw['toUserId'] === null)
    out.toUserId = raw['toUserId'] as string | null;
  if (typeof raw['strategy'] === 'string') out.strategy = raw['strategy'];
  if (typeof raw['captainId'] === 'string') out.captainId = raw['captainId'];
  if (typeof raw['reason'] === 'string') out.reason = raw['reason'];
  return out;
}

type FollowUpSubKind = 'created' | 'completed' | 'snoozed';

interface ActivityItem {
  kind: 'activity';
  id: string;
  at: Date;
  data: LeadActivity;
}
interface FollowUpItem {
  kind: 'followup';
  id: string;
  at: Date;
  subKind: FollowUpSubKind;
  data: LeadFollowUp;
}
type TimelineItem = ActivityItem | FollowUpItem;

function isUserAction(item: TimelineItem): boolean {
  if (item.kind === 'activity') return item.data.type === 'note' || item.data.type === 'call';
  // Follow-up created / completed are user-initiated; snoozed too.
  return true;
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function dayLabel(date: Date, now: Date, locale: string, tDetail: (k: string) => string): string {
  const todayStart = startOfDay(now);
  const dStart = startOfDay(date);
  const diffDays = Math.round((todayStart - dStart) / (24 * 60 * 60 * 1000));
  if (diffDays === 0) return tDetail('timeline.today');
  if (diffDays === 1) return tDetail('timeline.yesterday');
  return date.toLocaleDateString(locale, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: dStart < todayStart - 365 * 24 * 60 * 60 * 1000 ? 'numeric' : undefined,
  });
}

interface ActivityTimelineProps {
  activities: ReadonlyArray<LeadActivity>;
  followUps: ReadonlyArray<LeadFollowUp>;
  now: Date;
  locale: string;
  /** Resolves a stage code to its display name. */
  stageLabel: (code: string | undefined) => string;
  /** Resolves a user id to "Sara Ali" (or short id when unknown). */
  userLabel: (uid: string | null | undefined) => string;
  /** Translator scoped to admin.leads.detail. */
  tDetail: (key: string, vars?: Record<string, string | number>) => string;
  /** Pre-formatted relative time helper from the parent. */
  formatRelative: (target: Date) => string;
}

export function ActivityTimeline({
  activities,
  followUps,
  now,
  locale,
  stageLabel,
  userLabel,
  tDetail,
  formatRelative,
}: ActivityTimelineProps): JSX.Element {
  // Merge activities + follow-up-derived events into a single
  // chronological stream, newest-first. Splitting then re-grouping
  // by day keeps the day-separator render trivial.
  const items = useMemo<TimelineItem[]>(() => {
    const out: TimelineItem[] = [];
    for (const a of activities) {
      out.push({ kind: 'activity', id: `a:${a.id}`, at: new Date(a.createdAt), data: a });
    }
    for (const f of followUps) {
      out.push({
        kind: 'followup',
        id: `f-c:${f.id}`,
        at: new Date(f.createdAt),
        subKind: 'created',
        data: f,
      });
      if (f.completedAt) {
        out.push({
          kind: 'followup',
          id: `f-d:${f.id}`,
          at: new Date(f.completedAt),
          subKind: 'completed',
          data: f,
        });
      }
      // Snooze event: updatedAt strictly after createdAt + the row is
      // still pending + a snooze is set. Patch endpoint is single-
      // purpose (snoozedUntil only) so updatedAt reliably timestamps
      // the snooze action.
      if (
        !f.completedAt &&
        f.snoozedUntil &&
        new Date(f.updatedAt).getTime() > new Date(f.createdAt).getTime() + 1000
      ) {
        out.push({
          kind: 'followup',
          id: `f-s:${f.id}`,
          at: new Date(f.updatedAt),
          subKind: 'snoozed',
          data: f,
        });
      }
    }
    out.sort((a, b) => b.at.getTime() - a.at.getTime());
    return out;
  }, [activities, followUps]);

  // Bucket by day-start so the day separators render in O(n).
  const buckets = useMemo<Array<{ dayStart: number; items: TimelineItem[] }>>(() => {
    const map = new Map<number, TimelineItem[]>();
    for (const it of items) {
      const k = startOfDay(it.at);
      const list = map.get(k);
      if (list) list.push(it);
      else map.set(k, [it]);
    }
    return Array.from(map.entries())
      .sort((a, b) => b[0] - a[0])
      .map(([dayStart, list]) => ({ dayStart, items: list }));
  }, [items]);

  if (items.length === 0) {
    return <EmptyState title={tDetail('noActivities')} body={tDetail('noActivitiesHint')} />;
  }

  return (
    <div className="flex flex-col gap-4">
      {buckets.map(({ dayStart, items }) => (
        <section key={dayStart} className="flex flex-col gap-2">
          <DaySeparator label={dayLabel(new Date(dayStart), now, locale, tDetail)} />
          <ul className="flex flex-col gap-2">
            {items.map((it) => (
              <TimelineRow
                key={it.id}
                item={it}
                stageLabel={stageLabel}
                userLabel={userLabel}
                tDetail={tDetail}
                formatRelative={formatRelative}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function DaySeparator({ label }: { label: string }): JSX.Element {
  return (
    <div className="flex items-center gap-2 px-1 py-1" aria-hidden="false">
      <span className="h-px flex-1 bg-surface-border" aria-hidden="true" />
      <span className="text-[11px] font-medium uppercase tracking-wide text-ink-tertiary">
        {label}
      </span>
      <span className="h-px flex-1 bg-surface-border" aria-hidden="true" />
    </div>
  );
}

interface RowProps {
  item: TimelineItem;
  stageLabel: (code: string | undefined) => string;
  userLabel: (uid: string | null | undefined) => string;
  tDetail: (key: string, vars?: Record<string, string | number>) => string;
  formatRelative: (target: Date) => string;
}

function TimelineRow({
  item,
  stageLabel,
  userLabel,
  tDetail,
  formatRelative,
}: RowProps): JSX.Element {
  const userSide = isUserAction(item);
  const tone = pickTone(item);
  const tc = TONE_CLASS[tone];

  // Header line: who + what + when.
  const author = pickAuthor(item, userLabel, tDetail);
  const typeLabel = pickTypeLabel(item, tDetail);
  const summary = pickSummary(item, stageLabel, userLabel, tDetail);
  const body = pickBody(item);
  const Icon = pickIcon(item);
  const when = formatRelative(item.at);

  return (
    <li className={cn('flex flex-col', userSide ? 'items-end' : 'items-start')}>
      <div className={cn('max-w-[88%] rounded-lg border px-3 py-2 text-sm', tc.bubble)}>
        <div className="flex items-center gap-2 text-[11px] text-ink-tertiary">
          <span className={cn('inline-flex h-2 w-2 rounded-full', tc.dot)} aria-hidden="true" />
          <span className="inline-flex items-center gap-1 font-medium uppercase tracking-wide">
            <Icon className="h-3 w-3" aria-hidden="true" />
            {typeLabel}
          </span>
          <span aria-hidden="true">·</span>
          <span title={item.at.toLocaleString()}>{when}</span>
        </div>
        {summary ? <p className="mt-1 text-sm text-ink-primary">{summary}</p> : null}
        {body ? <p className="mt-1 whitespace-pre-line text-sm text-ink-primary">{body}</p> : null}
        <p className="mt-1 text-[11px] text-ink-tertiary">
          {tDetail('activityAuthorBy')} {author}
        </p>
      </div>
    </li>
  );
}

function pickTone(item: TimelineItem): Tone {
  if (item.kind === 'activity') return activityTone(item.data.type);
  if (item.subKind === 'completed') return 'healthy';
  if (item.subKind === 'snoozed') return 'warning';
  return 'info';
}

function pickIcon(item: TimelineItem): React.ComponentType<{ className?: string }> {
  if (item.kind === 'activity') return ACTIVITY_ICON[item.data.type] ?? Settings;
  if (item.subKind === 'completed') return Check;
  if (item.subKind === 'snoozed') return Clock;
  return CalendarPlus;
}

function pickAuthor(
  item: TimelineItem,
  userLabel: (uid: string | null | undefined) => string,
  tDetail: (key: string) => string,
): string {
  if (item.kind === 'activity') {
    return item.data.createdById !== null
      ? userLabel(item.data.createdById)
      : tDetail('systemAuthor');
  }
  // Follow-up: created/completed/snoozed all attributed to the
  // creator. (`completedBy` isn't tracked separately on the row.)
  return item.data.createdById ? userLabel(item.data.createdById) : tDetail('systemAuthor');
}

function pickTypeLabel(
  item: TimelineItem,
  tDetail: (key: string, vars?: Record<string, string | number>) => string,
): string {
  if (item.kind === 'activity') return tDetail(`activity.type.${item.data.type}`);
  return tDetail(`timeline.followUp.${item.subKind}`);
}

function pickSummary(
  item: TimelineItem,
  stageLabel: (code: string | undefined) => string,
  userLabel: (uid: string | null | undefined) => string,
  tDetail: (key: string, vars?: Record<string, string | number>) => string,
): string | null {
  if (item.kind === 'activity') {
    const a = item.data;
    const payload = readPayload(a.payload);
    switch (a.type) {
      case 'stage_change':
        return tDetail('activity.summary.stageChange', {
          from: stageLabel(payload.fromStageCode),
          to: stageLabel(payload.toStageCode),
        });
      case 'assignment':
        if (payload.toUserId === null) return tDetail('activity.summary.unassigned');
        if (payload.fromUserId)
          return tDetail('activity.summary.reassigned', {
            from: userLabel(payload.fromUserId),
            to: userLabel(payload.toUserId),
          });
        return tDetail('activity.summary.assigned', { user: userLabel(payload.toUserId) });
      case 'auto_assignment':
        return tDetail('activity.summary.autoAssignment', {
          strategy: payload.strategy ?? 'round-robin',
        });
      case 'sla_breach':
        return tDetail('activity.summary.slaBreach');
      case 'system':
        if (payload.captainId) return tDetail('activity.summary.converted');
        return null;
      default:
        return null;
    }
  }
  // Follow-up: summary line shows action type + due time.
  const f = item.data;
  const dueAt = new Date(f.dueAt);
  const fmt = dueAt.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  const typeLabel = tDetail(`timeline.followUp.types.${f.actionType}`);
  if (item.subKind === 'created') {
    return tDetail('timeline.followUp.createdSummary', { type: typeLabel, due: fmt });
  }
  if (item.subKind === 'completed') {
    return tDetail('timeline.followUp.completedSummary', { type: typeLabel });
  }
  // snoozed
  if (f.snoozedUntil) {
    const sn = new Date(f.snoozedUntil).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
    return tDetail('timeline.followUp.snoozedSummary', { until: sn });
  }
  return null;
}

function pickBody(item: TimelineItem): string | null {
  if (item.kind === 'activity') {
    if (item.data.body && (item.data.type === 'note' || item.data.type === 'call'))
      return item.data.body;
    return null;
  }
  // Show the follow-up's note alongside its event (e.g. "Confirm
  // vehicle docs"); helpful for completed events too.
  return item.data.note ?? null;
}
