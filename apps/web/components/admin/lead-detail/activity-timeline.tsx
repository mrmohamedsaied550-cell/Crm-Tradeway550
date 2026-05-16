'use client';

import { useMemo, useState } from 'react';
import {
  ArrowRightLeft,
  CalendarPlus,
  Check,
  ChevronDown,
  ChevronUp,
  Clock,
  Gauge,
  ListChecks,
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
 * Activity Timeline — chat-like, with two Phase 1 UX wins:
 *
 *  1. Filter chips above the stream so the agent can hide the noise:
 *       • All        — default; everything (current behaviour).
 *       • Mine       — user actions only (note, call, stage_change,
 *                      stage_status_changed, follow-ups created/
 *                      completed/snoozed).
 *       • Stage      — stage_change + stage_status_changed.
 *       • System     — sla_breach, sla_threshold_crossed, assignment,
 *                      auto_assignment, rotation, system.
 *
 *  2. Auto-grouping of system noise: when ≥3 same-type system events
 *     fire on the same day with no user action in between, they are
 *     collapsed into a single GroupRow that shows the count and
 *     expands to reveal each underlying event. Today this kicks in
 *     for `sla_breach` and `auto_assignment` — the two events that
 *     produced the worst spam in the wild (a single SLA loop could
 *     post 5+ breaches before anyone noticed). Day separators still
 *     read in the same chunked rhythm as before.
 *
 *  Both improvements are pure-presentation: the API still returns
 *  the full event list. No backend / DB / schema changes.
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
    case 'sla_threshold_crossed':
      return 'warning';
    case 'stage_status_changed':
      return 'info';
    case 'rotation':
      return 'warning';
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
  sla_threshold_crossed: Gauge,
  stage_status_changed: ListChecks,
  rotation: ArrowRightLeft,
  system: Settings,
};

const TONE_CLASS: Record<Tone, { dot: string; bubble: string }> = {
  info: { dot: 'bg-status-info', bubble: 'border-brand-200 bg-brand-50/60' },
  warning: { dot: 'bg-status-warning', bubble: 'border-status-warning/30 bg-status-warning/5' },
  breach: { dot: 'bg-status-breach', bubble: 'border-status-breach/30 bg-status-breach/5' },
  healthy: { dot: 'bg-status-healthy', bubble: 'border-status-healthy/30 bg-status-healthy/5' },
  neutral: { dot: 'bg-ink-tertiary', bubble: 'border-surface-border bg-surface' },
};

/** Phase 1 — minimum consecutive same-type events before grouping kicks in. */
const GROUP_THRESHOLD = 3;

/** Phase 1 — only these types are eligible for collapse. They are
 *  the ones agents told us produced the worst stream noise. */
const GROUPABLE_TYPES: ReadonlySet<LeadActivityType> = new Set<LeadActivityType>([
  'sla_breach',
  'auto_assignment',
]);

interface PayloadShape {
  fromStageCode?: string;
  toStageCode?: string;
  fromUserId?: string | null;
  toUserId?: string | null;
  strategy?: string;
  captainId?: string;
  reason?: string;
  fromStatus?: string | null;
  toStatus?: string;
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
  if (typeof raw['fromStatus'] === 'string' || raw['fromStatus'] === null)
    out.fromStatus = raw['fromStatus'] as string | null;
  if (typeof raw['toStatus'] === 'string') out.toStatus = raw['toStatus'];
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
interface GroupItem {
  kind: 'group';
  id: string;
  at: Date;
  /** The activity type these grouped activities share. */
  groupType: LeadActivityType;
  /** Original activities, sorted newest-first — same order as flat. */
  items: ActivityItem[];
}
type TimelineItem = ActivityItem | FollowUpItem | GroupItem;

function isUserAction(item: TimelineItem): boolean {
  if (item.kind === 'activity') return item.data.type === 'note' || item.data.type === 'call';
  if (item.kind === 'group') return false;
  // Follow-up created / completed / snoozed are user-initiated.
  return true;
}

/** Phase 1 filter chips. Maps a chip to the set of activity types
 *  it lets through. Follow-ups are user actions (always shown for
 *  `mine`, hidden for `stage` and `system`). Groups are filtered
 *  by their `groupType`. */
type Filter = 'all' | 'mine' | 'stage' | 'system';

const STAGE_TYPES: ReadonlySet<LeadActivityType> = new Set<LeadActivityType>([
  'stage_change',
  'stage_status_changed',
]);
const SYSTEM_TYPES: ReadonlySet<LeadActivityType> = new Set<LeadActivityType>([
  'sla_breach',
  'sla_threshold_crossed',
  'assignment',
  'auto_assignment',
  'rotation',
  'system',
]);
const MINE_TYPES: ReadonlySet<LeadActivityType> = new Set<LeadActivityType>(['note', 'call']);

function passesFilter(item: TimelineItem, filter: Filter): boolean {
  if (filter === 'all') return true;
  if (item.kind === 'followup') return filter === 'mine';
  if (item.kind === 'group') {
    if (filter === 'mine') return false;
    if (filter === 'stage') return STAGE_TYPES.has(item.groupType);
    if (filter === 'system') return SYSTEM_TYPES.has(item.groupType);
  }
  if (item.kind === 'activity') {
    const t = item.data.type;
    if (filter === 'mine') return MINE_TYPES.has(t);
    if (filter === 'stage') return STAGE_TYPES.has(t);
    if (filter === 'system') return SYSTEM_TYPES.has(t);
  }
  return false;
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
  // Phase 1 — local-only filter state. Lives in the URL would be
  // nicer (so refresh keeps it) but that requires plumbing through
  // the page's router; staging this for a later sprint.
  const [filter, setFilter] = useState<Filter>('all');

  // Step 1 — flat merge: activities + follow-up-derived events,
  // newest-first. Identical to the previous behaviour.
  const flat = useMemo<Array<ActivityItem | FollowUpItem>>(() => {
    const out: Array<ActivityItem | FollowUpItem> = [];
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

  // Step 2 — collapse runs of consecutive same-day, same-type
  // groupable activities (sla_breach, auto_assignment) of size
  // ≥ GROUP_THRESHOLD. Anything else passes through unchanged.
  // The fold keeps the newest-first order the parent sorted on.
  const items = useMemo<TimelineItem[]>(() => {
    const out: TimelineItem[] = [];
    let i = 0;
    while (i < flat.length) {
      const cur = flat[i]!;
      // Only activity items are eligible for grouping; follow-ups
      // pass through.
      if (cur.kind !== 'activity' || !GROUPABLE_TYPES.has(cur.data.type)) {
        out.push(cur);
        i += 1;
        continue;
      }
      const head: ActivityItem = cur;
      const groupType: LeadActivityType = head.data.type;
      const groupDay = startOfDay(head.at);
      const run: ActivityItem[] = [head];
      let j = i + 1;
      while (j < flat.length) {
        const nx = flat[j]!;
        if (
          nx.kind !== 'activity' ||
          nx.data.type !== groupType ||
          startOfDay(nx.at) !== groupDay
        ) {
          break;
        }
        run.push(nx);
        j += 1;
      }
      if (run.length >= GROUP_THRESHOLD) {
        out.push({
          kind: 'group',
          id: `g:${groupType}:${head.id}`,
          at: head.at, // newest event is the group's timestamp
          groupType,
          items: run,
        });
      } else {
        for (const r of run) out.push(r);
      }
      i = j;
    }
    return out;
  }, [flat]);

  // Step 3 — apply the filter chip. We keep this AFTER grouping so a
  // group of 5 SLA breaches still reads as a single row when "System"
  // is selected, instead of fanning out into 5.
  const filteredItems = useMemo<TimelineItem[]>(
    () => items.filter((it) => passesFilter(it, filter)),
    [items, filter],
  );

  // Step 4 — bucket by day-start so the day separators render in O(n).
  const buckets = useMemo<Array<{ dayStart: number; items: TimelineItem[] }>>(() => {
    const map = new Map<number, TimelineItem[]>();
    for (const it of filteredItems) {
      const k = startOfDay(it.at);
      const list = map.get(k);
      if (list) list.push(it);
      else map.set(k, [it]);
    }
    return Array.from(map.entries())
      .sort((a, b) => b[0] - a[0])
      .map(([dayStart, list]) => ({ dayStart, items: list }));
  }, [filteredItems]);

  return (
    <div className="flex flex-col gap-3">
      <FilterChips filter={filter} setFilter={setFilter} tDetail={tDetail} />
      {filteredItems.length === 0 ? (
        <EmptyState
          title={filter === 'all' ? tDetail('noActivities') : tDetail('timeline.filter.emptyTitle')}
          body={
            filter === 'all' ? tDetail('noActivitiesHint') : tDetail('timeline.filter.emptyBody')
          }
        />
      ) : (
        <div className="flex flex-col gap-4">
          {buckets.map(({ dayStart, items }) => (
            <section key={dayStart} className="flex flex-col gap-2">
              <DaySeparator label={dayLabel(new Date(dayStart), now, locale, tDetail)} />
              <ul className="flex flex-col gap-2">
                {items.map((it) =>
                  it.kind === 'group' ? (
                    <GroupRow
                      key={it.id}
                      item={it}
                      stageLabel={stageLabel}
                      userLabel={userLabel}
                      tDetail={tDetail}
                      formatRelative={formatRelative}
                    />
                  ) : (
                    <TimelineRow
                      key={it.id}
                      item={it}
                      stageLabel={stageLabel}
                      userLabel={userLabel}
                      tDetail={tDetail}
                      formatRelative={formatRelative}
                    />
                  ),
                )}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────
// Filter chips (segmented control)
// ───────────────────────────────────────────────────────────────────────

const FILTERS: ReadonlyArray<Filter> = ['all', 'mine', 'stage', 'system'];

function FilterChips({
  filter,
  setFilter,
  tDetail,
}: {
  filter: Filter;
  setFilter: (f: Filter) => void;
  tDetail: (key: string) => string;
}): JSX.Element {
  return (
    <div
      role="tablist"
      aria-label={tDetail('timeline.filter.label')}
      className="inline-flex items-center gap-1 self-start rounded-md border border-surface-border bg-surface p-0.5"
    >
      {FILTERS.map((f) => {
        const active = filter === f;
        return (
          <button
            key={f}
            role="tab"
            aria-selected={active}
            type="button"
            onClick={() => setFilter(f)}
            className={cn(
              'h-7 rounded px-3 text-xs font-medium transition-colors',
              active
                ? 'bg-brand-600 text-white shadow-sm'
                : 'text-ink-secondary hover:bg-brand-50 hover:text-ink-primary',
            )}
          >
            {tDetail(`timeline.filter.${f}`)}
          </button>
        );
      })}
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
  item: ActivityItem | FollowUpItem;
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

// ───────────────────────────────────────────────────────────────────────
// Grouped row (≥ GROUP_THRESHOLD same-type same-day system events)
// ───────────────────────────────────────────────────────────────────────

interface GroupRowProps {
  item: GroupItem;
  stageLabel: (code: string | undefined) => string;
  userLabel: (uid: string | null | undefined) => string;
  tDetail: (key: string, vars?: Record<string, string | number>) => string;
  formatRelative: (target: Date) => string;
}

function GroupRow({
  item,
  stageLabel,
  userLabel,
  tDetail,
  formatRelative,
}: GroupRowProps): JSX.Element {
  const [expanded, setExpanded] = useState<boolean>(false);
  const tone = activityTone(item.groupType);
  const tc = TONE_CLASS[tone];
  const Icon = ACTIVITY_ICON[item.groupType] ?? Settings;
  const newest = item.items[0]!; // newest-first; group is non-empty by construction
  const oldest = item.items[item.items.length - 1]!;

  const headLabel = tDetail('timeline.group.headline', {
    type: tDetail(`activity.type.${item.groupType}`),
    count: item.items.length,
  });
  const range = `${formatRelative(oldest.at)} – ${formatRelative(newest.at)}`;

  return (
    <li className="flex flex-col items-start">
      <div className={cn('w-full max-w-[88%] rounded-lg border text-sm', tc.bubble)}>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="flex w-full items-start gap-2 px-3 py-2 text-start"
        >
          <span
            className={cn('mt-1 inline-flex h-2 w-2 rounded-full', tc.dot)}
            aria-hidden="true"
          />
          <span className="flex flex-1 flex-col gap-0.5">
            <span className="flex flex-wrap items-center gap-2 text-[11px] text-ink-tertiary">
              <span className="inline-flex items-center gap-1 font-medium uppercase tracking-wide">
                <Icon className="h-3 w-3" aria-hidden="true" />
                {tDetail(`activity.type.${item.groupType}`)}
              </span>
              <span
                className="inline-flex h-4 min-w-[20px] items-center justify-center rounded-full bg-ink-primary/10 px-1.5 text-[10px] font-semibold text-ink-primary"
                aria-label={String(item.items.length)}
              >
                ×{item.items.length}
              </span>
              <span aria-hidden="true">·</span>
              <span title={range}>{range}</span>
            </span>
            <span className="text-sm text-ink-primary">{headLabel}</span>
            {!expanded ? (
              <span className="text-[11px] text-ink-tertiary">
                {tDetail('timeline.group.expandHint')}
              </span>
            ) : null}
          </span>
          <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center text-ink-tertiary">
            {expanded ? (
              <ChevronUp className="h-4 w-4" aria-hidden="true" />
            ) : (
              <ChevronDown className="h-4 w-4" aria-hidden="true" />
            )}
          </span>
        </button>
        {expanded ? (
          <ul className="border-t border-surface-border bg-surface-card/40 px-3 py-2">
            {item.items.map((sub) => (
              <li key={sub.id} className="flex flex-col gap-0.5 py-1.5">
                <span className="flex items-center gap-2 text-[11px] text-ink-tertiary">
                  <span title={sub.at.toLocaleString()}>{formatRelative(sub.at)}</span>
                </span>
                <span className="text-sm text-ink-primary">
                  {pickSummary(sub, stageLabel, userLabel, tDetail) ?? pickTypeLabel(sub, tDetail)}
                </span>
                <span className="text-[11px] text-ink-tertiary">
                  {tDetail('activityAuthorBy')} {pickAuthor(sub, userLabel, tDetail)}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </li>
  );
}

// ───────────────────────────────────────────────────────────────────────
// Helpers (shared between TimelineRow + GroupRow expansion)
// ───────────────────────────────────────────────────────────────────────

function pickTone(item: ActivityItem | FollowUpItem): Tone {
  if (item.kind === 'activity') return activityTone(item.data.type);
  if (item.subKind === 'completed') return 'healthy';
  if (item.subKind === 'snoozed') return 'warning';
  return 'info';
}

function pickIcon(item: ActivityItem | FollowUpItem): React.ComponentType<{ className?: string }> {
  if (item.kind === 'activity') return ACTIVITY_ICON[item.data.type] ?? Settings;
  if (item.subKind === 'completed') return Check;
  if (item.subKind === 'snoozed') return Clock;
  return CalendarPlus;
}

function pickAuthor(
  item: ActivityItem | FollowUpItem,
  userLabel: (uid: string | null | undefined) => string,
  tDetail: (key: string) => string,
): string {
  if (item.kind === 'activity') {
    return item.data.createdById !== null
      ? userLabel(item.data.createdById)
      : tDetail('systemAuthor');
  }
  return item.data.createdById ? userLabel(item.data.createdById) : tDetail('systemAuthor');
}

function pickTypeLabel(
  item: ActivityItem | FollowUpItem,
  tDetail: (key: string, vars?: Record<string, string | number>) => string,
): string {
  if (item.kind === 'activity') return tDetail(`activity.type.${item.data.type}`);
  return tDetail(`timeline.followUp.${item.subKind}`);
}

function pickSummary(
  item: ActivityItem | FollowUpItem,
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
      case 'stage_status_changed':
        return payload.toStatus
          ? tDetail('activity.summary.stageStatusChangedTo', { status: payload.toStatus })
          : tDetail('activity.summary.stageStatusChanged');
      case 'rotation':
        return tDetail('activity.summary.rotation');
      case 'system':
        if (payload.captainId) return tDetail('activity.summary.converted');
        return null;
      default:
        return null;
    }
  }
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

function pickBody(item: ActivityItem | FollowUpItem): string | null {
  if (item.kind === 'activity') {
    if (item.data.body && (item.data.type === 'note' || item.data.type === 'call'))
      return item.data.body;
    return null;
  }
  return item.data.note ?? null;
}
