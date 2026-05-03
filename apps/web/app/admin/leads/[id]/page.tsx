'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, useCallback, type FormEvent } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import {
  ArrowLeft,
  ArrowRightLeft,
  CheckCircle2,
  ChevronDown,
  Mail,
  Phone,
  PhoneCall,
  Settings,
  StickyNote,
  Trophy,
  TriangleAlert,
  UserCog,
  UserPlus,
  Users,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Select, Textarea } from '@/components/ui/input';
import { LifecycleBadge } from '@/components/ui/lifecycle-badge';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { LostReasonModal, type LostReasonResult } from '@/components/admin/lost-reason-modal';
import {
  ApiError,
  leadsApi,
  lostReasonsApi,
  pipelineApi,
  pipelinesApi,
  teamsApi,
  usersApi,
} from '@/lib/api';
import type {
  AdminUser,
  Lead,
  LeadActivity,
  LeadActivityType,
  LeadStageCode,
  LostReason,
  PipelineStage,
  SlaStatus,
  Team,
} from '@/lib/api-types';
import { cn } from '@/lib/utils';

function slaTone(s: SlaStatus): 'healthy' | 'warning' | 'breach' | 'inactive' {
  if (s === 'breached') return 'breach';
  if (s === 'paused') return 'inactive';
  return 'healthy';
}

function activityTone(
  type: LeadActivityType,
): 'info' | 'warning' | 'breach' | 'neutral' | 'healthy' {
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

/** Compact relative-time formatter without bringing in date-fns. */
function formatRelative(target: Date, now: Date, locale: string): string {
  const diffMs = target.getTime() - now.getTime();
  const abs = Math.abs(diffMs);
  const units: ReadonlyArray<[Intl.RelativeTimeFormatUnit, number]> = [
    ['day', 24 * 60 * 60 * 1000],
    ['hour', 60 * 60 * 1000],
    ['minute', 60 * 1000],
    ['second', 1000],
  ];
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  for (const [unit, ms] of units) {
    if (abs >= ms || unit === 'second') {
      return rtf.format(Math.round(diffMs / ms), unit);
    }
  }
  return '';
}

interface PayloadShape {
  event?: string;
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
  if (typeof raw['event'] === 'string') out.event = raw['event'];
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

export default function LeadDetailPage(): JSX.Element {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const router = useRouter();
  const locale = useLocale();
  const t = useTranslations('admin.leads');
  const tCommon = useTranslations('admin.common');
  const tDetail = useTranslations('admin.leads.detail');

  const [lead, setLead] = useState<Lead | null>(null);
  const [activities, setActivities] = useState<LeadActivity[]>([]);
  const [stages, setStages] = useState<PipelineStage[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  // Phase A — A6: lost reasons cached for label resolution + the
  // lost-reason modal's picker (passed in to skip its own fetch).
  const [lostReasons, setLostReasons] = useState<LostReason[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Inline action state
  const [assigneeId, setAssigneeId] = useState<string>('');
  const [stageCode, setStageCode] = useState<LeadStageCode | ''>('');
  const [activityType, setActivityType] = useState<'note' | 'call'>('note');
  const [activityBody, setActivityBody] = useState<string>('');
  const [actionPending, setActionPending] = useState<string | null>(null);

  // Refs used by the quick-actions bar to focus the composer + open the
  // move-stage dropdown.
  const composerSectionRef = useRef<HTMLElement | null>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [stageMenuOpen, setStageMenuOpen] = useState<boolean>(false);

  // Phase A — A6: lost-reason modal state. The modal opens whenever
  // the agent picks a stage with `terminalKind === 'lost'`; the
  // pending stage is held here so the moveStage call can fire after
  // the modal returns the chosen reason.
  const [lostModalOpen, setLostModalOpen] = useState<boolean>(false);
  const [pendingLostStageId, setPendingLostStageId] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const [l, acts, usrs, tms, lr] = await Promise.all([
        leadsApi.get(id),
        leadsApi.listActivities(id),
        usersApi
          .list({ limit: 200 })
          .catch(() => ({ items: [] as AdminUser[], total: 0, limit: 200, offset: 0 })),
        teamsApi.list().catch(() => [] as Team[]),
        // Phase A — A6: lost reasons cached on the page so the
        // "Lost reason" panel can resolve labels without a per-render
        // fetch + the modal can re-use the same list.
        lostReasonsApi.listActive().catch(() => [] as LostReason[]),
      ]);
      // Phase 1B — load stages from the LEAD'S OWN pipeline, not the
      // tenant default. Custom pipelines define their own stages;
      // showing the default's stages would let the agent pick a code
      // that doesn't exist on this pipeline (server-side guard would
      // then reject the move with a less friendly error).
      const st = await (
        l.pipelineId ? pipelinesApi.stagesOf(l.pipelineId) : pipelineApi.listStages()
      ).catch(() => [] as PipelineStage[]);
      setLead(l);
      setActivities(acts);
      setStages(st);
      setUsers(usrs.items);
      setTeams(tms);
      setLostReasons(lr);
      setAssigneeId(l.assignedToId ?? '');
      setStageCode(l.stage.code);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const userById = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);
  const teamById = useMemo(() => new Map(teams.map((tm) => [tm.id, tm])), [teams]);
  const stageByCode = useMemo(() => new Map(stages.map((s) => [s.code, s])), [stages]);
  // Phase A — A6: id → reason lookup for the "Lost reason" panel on
  // the profile card. Cheap O(1) reads inside render.
  const lostReasonsById = useMemo(() => new Map(lostReasons.map((r) => [r.id, r])), [lostReasons]);
  const activeUsers = useMemo(() => users.filter((u) => u.status === 'active'), [users]);

  const stageLabel = useCallback(
    (code: string | undefined): string => {
      if (!code) return '—';
      return stageByCode.get(code)?.name ?? code;
    },
    [stageByCode],
  );

  const userLabel = useCallback(
    (uid: string | null | undefined): string => {
      if (!uid) return tDetail('unassigned');
      return userById.get(uid)?.name ?? uid.slice(0, 8);
    },
    [userById, tDetail],
  );

  // ─────── Mutations ───────

  async function onAssign(): Promise<void> {
    if (!lead) return;
    setActionPending('assign');
    setError(null);
    try {
      await leadsApi.assign(lead.id, assigneeId || null);
      setNotice(tCommon('saved'));
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setActionPending(null);
    }
  }

  /**
   * Phase A — A6: shared move helper. If the target stage's
   * `terminalKind === 'lost'`, opens the lost-reason modal and
   * defers the API call until the agent picks a reason. Otherwise
   * fires moveStage immediately. `lostExtras` carries the reason
   * payload on the second pass; first-pass calls omit it.
   */
  async function performMoveStage(
    targetStageCode: string,
    lostExtras?: LostReasonResult,
  ): Promise<void> {
    if (!lead) return;
    const target = stageByCode.get(targetStageCode);
    // Lost-stage gating: only intercept the FIRST call (no
    // lostExtras yet). The second call carries lostExtras and goes
    // straight through.
    if (target?.terminalKind === 'lost' && !lostExtras) {
      setPendingLostStageId(target.id);
      setLostModalOpen(true);
      return;
    }
    setActionPending('stage');
    setError(null);
    try {
      await leadsApi.moveStage(lead.id, {
        ...(target ? { pipelineStageId: target.id } : { stageCode: targetStageCode }),
        ...(lostExtras && {
          lostReasonId: lostExtras.lostReasonId,
          ...(lostExtras.lostNote && { lostNote: lostExtras.lostNote }),
        }),
      });
      setNotice(tCommon('saved'));
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setActionPending(null);
    }
  }

  async function onMoveStage(): Promise<void> {
    if (!stageCode) return;
    await performMoveStage(stageCode);
  }

  /**
   * Quick-action variant: move the lead to `code` directly (skipping the
   * sidebar's "select then save" two-step). The sidebar's `stageCode`
   * state is updated optimistically so the dropdown stays in sync after
   * reload.
   */
  async function quickMoveToStage(code: LeadStageCode): Promise<void> {
    if (!lead || code === lead.stage.code) return;
    setStageMenuOpen(false);
    setStageCode(code);
    await performMoveStage(code);
  }

  /**
   * Phase A — A6: called by the lost-reason modal once the agent
   * picks a reason. Replays the stage move with the reason payload.
   */
  async function onLostReasonConfirm(result: LostReasonResult): Promise<void> {
    const stageId = pendingLostStageId;
    if (!stageId) return;
    // Find the matching stage by id (the helper expects a code).
    const target = stages.find((s) => s.id === stageId);
    if (!target) return;
    setLostModalOpen(false);
    setPendingLostStageId(null);
    await performMoveStage(target.code, result);
  }

  function onLostReasonCancel(): void {
    setLostModalOpen(false);
    setPendingLostStageId(null);
    // Restore the sidebar dropdown to the lead's actual current
    // stage so the user isn't stuck with the lost stage selected
    // but no move performed.
    if (lead) setStageCode(lead.stage.code);
  }

  /**
   * Focus the activity composer textarea + scroll it into view. Used by
   * the quick-action bar's "Add note" button.
   */
  function focusComposer(type: 'note' | 'call'): void {
    setActivityType(type);
    requestAnimationFrame(() => {
      composerSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      composerTextareaRef.current?.focus();
    });
  }

  async function onAddActivity(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (!lead || !activityBody.trim()) return;
    setActionPending('activity');
    setError(null);
    try {
      await leadsApi.addActivity(lead.id, { type: activityType, body: activityBody.trim() });
      setActivityBody('');
      setNotice(tCommon('saved'));
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setActionPending(null);
    }
  }

  async function onConvert(): Promise<void> {
    if (!lead) return;
    if (!window.confirm(t('convertHint'))) return;
    setActionPending('convert');
    setError(null);
    try {
      await leadsApi.convert(lead.id);
      setNotice(tCommon('saved'));
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setActionPending(null);
    }
  }

  // ─────── Loading / error / not found ───────

  if (loading && !lead) {
    return (
      <p className="rounded-lg border border-surface-border bg-surface-card px-4 py-10 text-center text-sm text-ink-secondary shadow-card">
        {tCommon('loading')}
      </p>
    );
  }
  if (error && !lead) {
    return (
      <div className="flex flex-col gap-3">
        <Notice tone="error">
          <div className="flex items-start justify-between gap-3">
            <span>{error}</span>
            <Button variant="ghost" size="sm" onClick={() => void reload()}>
              {tCommon('retry')}
            </Button>
          </div>
        </Notice>
      </div>
    );
  }
  if (!lead) {
    return (
      <EmptyState
        title={tCommon('errorTitle')}
        action={
          <Button variant="secondary" size="sm" onClick={() => router.push('/admin/leads')}>
            {t('title')}
          </Button>
        }
      />
    );
  }

  // ─────── Derived display values ───────

  const isConverted = Boolean(lead.captain) || lead.stage.code === 'converted';
  const isLost = lead.stage.code === 'lost';
  const assignee = lead.assignedToId ? (userById.get(lead.assignedToId) ?? null) : null;
  const assigneeTeam = assignee?.teamId ? (teamById.get(assignee.teamId) ?? null) : null;

  const now = new Date();
  const slaDueRelative = lead.slaDueAt
    ? formatRelative(new Date(lead.slaDueAt), now, locale)
    : null;
  const createdAtRelative = formatRelative(new Date(lead.createdAt), now, locale);

  // ─────── Render ───────

  return (
    <div className="flex flex-col gap-4">
      <Link
        href="/admin/leads"
        className="inline-flex items-center gap-1 text-xs font-medium text-ink-secondary hover:text-brand-700"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> {t('title')}
      </Link>

      <PageHeader
        title={lead.name}
        actions={
          <div className="flex items-center gap-2">
            {/* Phase A — A6: lifecycle classifier sits next to stage
                + SLA so a glance tells you "this lead is open / won
                / lost / archived". Using the standalone badge means
                future surfaces (Kanban card, list row) can drop it
                in without re-deriving the tone. */}
            <LifecycleBadge state={lead.lifecycleState} />
            <Badge tone={lead.stage.isTerminal ? 'inactive' : 'info'}>{lead.stage.name}</Badge>
            <Badge tone={slaTone(lead.slaStatus)}>{lead.slaStatus}</Badge>
            {isConverted ? (
              <Badge tone="healthy">
                <Trophy className="me-1 inline h-3 w-3" aria-hidden="true" />
                {tDetail('captainBadge')}
              </Badge>
            ) : null}
          </div>
        }
      />

      {/* ───── Quick actions bar (C20) ─────
          Three high-frequency actions surfaced right under the header so an
          agent doesn't have to scroll into the sidebar to call / take a
          note / move the stage. */}
      <QuickActionsBar
        phone={lead.phone}
        currentStageCode={lead.stage.code}
        stages={stages}
        stageMenuOpen={stageMenuOpen}
        setStageMenuOpen={setStageMenuOpen}
        disabled={isConverted}
        actionPending={actionPending}
        onCall={() => focusComposer('call')}
        onAddNote={() => focusComposer('note')}
        onPickStage={(c) => void quickMoveToStage(c)}
        labels={{
          call: tDetail('quickActions.call'),
          addNote: tDetail('quickActions.addNote'),
          moveStage: tDetail('quickActions.moveStage'),
          terminalHint: tDetail('quickActions.terminalHint'),
        }}
      />

      {error ? (
        <Notice tone="error">
          <div className="flex items-start justify-between gap-3">
            <span>{error}</span>
            <Button variant="ghost" size="sm" onClick={() => void reload()}>
              {tCommon('retry')}
            </Button>
          </div>
        </Notice>
      ) : null}
      {notice ? <Notice tone="success">{notice}</Notice> : null}

      {/* ───── Profile card ───── */}
      <section className="grid gap-3 rounded-lg border border-surface-border bg-surface-card p-5 shadow-card sm:grid-cols-2 lg:grid-cols-4">
        <ProfileField label={tDetail('phoneLabel')}>
          <a
            href={`tel:${lead.phone}`}
            className="inline-flex items-center gap-1 font-mono text-sm text-brand-700 hover:underline"
          >
            <Phone className="h-3.5 w-3.5" aria-hidden="true" />
            {lead.phone}
          </a>
        </ProfileField>

        <ProfileField label={tDetail('emailLabel')}>
          {lead.email ? (
            <a
              href={`mailto:${lead.email}`}
              className="inline-flex items-center gap-1 text-sm text-brand-700 hover:underline"
            >
              <Mail className="h-3.5 w-3.5" aria-hidden="true" />
              {lead.email}
            </a>
          ) : (
            <span className="text-sm text-ink-tertiary">—</span>
          )}
        </ProfileField>

        <ProfileField label={tDetail('assigneeLabel')}>
          {assignee ? (
            <div className="flex flex-col leading-tight">
              <span className="text-sm font-medium text-ink-primary">{assignee.name}</span>
              <span className="text-xs text-ink-secondary">
                {assignee.email}
                {assigneeTeam ? <> · {assigneeTeam.name}</> : null}
              </span>
            </div>
          ) : (
            <span className="text-sm text-ink-tertiary">{tDetail('unassigned')}</span>
          )}
        </ProfileField>

        <ProfileField label={tDetail('stageLabel')}>
          <div className="flex flex-col leading-tight">
            <span className="text-sm font-medium text-ink-primary">{lead.stage.name}</span>
            <span className="text-xs text-ink-tertiary">
              {tDetail('source')}: {lead.source}
            </span>
          </div>
        </ProfileField>

        <ProfileField label={tDetail('slaLabel')}>
          <div className="flex flex-col leading-tight">
            <Badge tone={slaTone(lead.slaStatus)}>{lead.slaStatus}</Badge>
            {slaDueRelative ? (
              <span className="mt-0.5 text-xs text-ink-tertiary">
                {tDetail('slaDue')} {slaDueRelative}
              </span>
            ) : null}
          </div>
        </ProfileField>

        <ProfileField label={tDetail('captainLabel')}>
          {isConverted ? (
            <div className="flex flex-col leading-tight">
              <span className="text-sm font-medium text-status-healthy">
                {lead.captain?.onboardingStatus
                  ? tDetail('captainOnboarding', { status: lead.captain.onboardingStatus })
                  : tDetail('captainBadge')}
              </span>
              <Link
                href="/admin/captains"
                className="mt-0.5 inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline"
              >
                {tDetail('viewCaptain')}
              </Link>
            </div>
          ) : isLost ? (
            <span className="text-sm text-ink-tertiary">{tDetail('captainLost')}</span>
          ) : (
            <span className="text-sm text-ink-tertiary">{tDetail('captainNotYet')}</span>
          )}
        </ProfileField>

        {/* Phase A — A6: surface the lost reason + optional note when
            the lead is in the lost lifecycle. The reason name comes
            from the lookup map; the note is free text the agent left
            at the time of the move. */}
        {lead.lifecycleState === 'lost' && lead.lostReasonId ? (
          <ProfileField label={tDetail('lostReasonLabel')}>
            <div className="flex flex-col leading-tight">
              <span className="text-sm font-medium text-ink-primary">
                {lostReasonsById.get(lead.lostReasonId)
                  ? locale === 'ar'
                    ? lostReasonsById.get(lead.lostReasonId)!.labelAr
                    : lostReasonsById.get(lead.lostReasonId)!.labelEn
                  : '—'}
              </span>
              {lead.lostNote ? (
                <span className="mt-0.5 text-xs text-ink-tertiary">{lead.lostNote}</span>
              ) : null}
            </div>
          </ProfileField>
        ) : null}

        <ProfileField label={tDetail('createdLabel')}>
          <span className="text-sm text-ink-secondary">{createdAtRelative}</span>
        </ProfileField>

        <ProfileField label={tDetail('lastResponseLabel')}>
          <span className="text-sm text-ink-secondary">
            {lead.lastResponseAt ? formatRelative(new Date(lead.lastResponseAt), now, locale) : '—'}
          </span>
        </ProfileField>
      </section>

      {/* ───── Two-column body: timeline + sidebar actions ───── */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        {/* Left: activity timeline + add-activity composer */}
        <div className="flex flex-col gap-4">
          {/* Add activity composer */}
          <section
            ref={composerSectionRef}
            id="lead-activity-composer"
            className="rounded-lg border border-surface-border bg-surface-card p-5 shadow-card"
          >
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-ink-primary">
              <StickyNote className="h-4 w-4 text-brand-700" aria-hidden="true" />
              {tDetail('logActivity')}
            </h2>
            <form onSubmit={onAddActivity} className="flex flex-col gap-3">
              <div className="grid gap-3 sm:grid-cols-[160px_1fr]">
                <Field label={t('addActivityType')}>
                  <Select
                    value={activityType}
                    onChange={(e) => setActivityType(e.target.value as 'note' | 'call')}
                  >
                    <option value="note">{t('addNote')}</option>
                    <option value="call">{t('addCall')}</option>
                  </Select>
                </Field>
                <Field label={t('addActivityBody')}>
                  <Textarea
                    ref={composerTextareaRef}
                    value={activityBody}
                    onChange={(e) => setActivityBody(e.target.value)}
                    maxLength={4000}
                    placeholder={
                      activityType === 'call'
                        ? tDetail('callPlaceholder')
                        : tDetail('notePlaceholder')
                    }
                    rows={3}
                  />
                </Field>
              </div>
              <div className="flex items-center justify-end gap-2">
                <span className="text-xs text-ink-tertiary">{activityBody.length}/4000</span>
                <Button
                  type="submit"
                  loading={actionPending === 'activity'}
                  disabled={!activityBody.trim()}
                >
                  {tDetail('postActivity')}
                </Button>
              </div>
            </form>
          </section>

          {/* Activity timeline */}
          <section className="rounded-lg border border-surface-border bg-surface-card p-5 shadow-card">
            <h2 className="mb-4 text-sm font-semibold text-ink-primary">
              {t('activitiesTitle')}
              <span className="ms-2 text-xs font-normal text-ink-tertiary">
                ({activities.length})
              </span>
            </h2>

            {activities.length === 0 ? (
              <EmptyState title={tDetail('noActivities')} body={tDetail('noActivitiesHint')} />
            ) : (
              <ol className="relative flex flex-col gap-3 ps-4">
                <span
                  className="absolute inset-y-0 start-1.5 w-px bg-surface-border"
                  aria-hidden="true"
                />
                {activities.map((a) => (
                  <ActivityItem
                    key={a.id}
                    activity={a}
                    locale={locale}
                    now={now}
                    stageLabel={stageLabel}
                    userLabel={userLabel}
                    tDetail={tDetail}
                  />
                ))}
              </ol>
            )}
          </section>
        </div>

        {/* Right: quick actions sidebar */}
        <aside className="flex flex-col gap-4">
          <section className="rounded-lg border border-surface-border bg-surface-card p-5 shadow-card">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-ink-primary">
              <UserCog className="h-4 w-4 text-brand-700" aria-hidden="true" />
              {tDetail('quickActionsTitle')}
            </h2>

            {/* Assign / reassign */}
            <div className="flex flex-col gap-2">
              <Field label={t('assignAction')}>
                <Select
                  value={assigneeId}
                  onChange={(e) => setAssigneeId(e.target.value)}
                  disabled={isConverted}
                >
                  <option value="">{tDetail('unassigned')}</option>
                  {activeUsers.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name} ({u.email})
                    </option>
                  ))}
                </Select>
              </Field>
              <Button
                onClick={() => void onAssign()}
                loading={actionPending === 'assign'}
                disabled={isConverted || (assigneeId || '') === (lead.assignedToId ?? '')}
                size="sm"
              >
                {tDetail('saveAssignee')}
              </Button>
            </div>

            <hr className="my-4 border-surface-border" />

            {/* Move stage */}
            <div className="flex flex-col gap-2">
              <Field label={t('moveStageAction')}>
                <Select
                  value={stageCode}
                  onChange={(e) => setStageCode(e.target.value as LeadStageCode)}
                  disabled={isConverted}
                >
                  {stages.map((s) => (
                    <option key={s.code} value={s.code}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Button
                onClick={() => void onMoveStage()}
                loading={actionPending === 'stage'}
                disabled={isConverted || stageCode === lead.stage.code}
                size="sm"
              >
                {tDetail('saveStage')}
              </Button>
            </div>

            <hr className="my-4 border-surface-border" />

            {/* Convert */}
            <div className="flex flex-col gap-2">
              <span className="text-xs text-ink-secondary">{t('convertHint')}</span>
              <Button
                variant="primary"
                onClick={() => void onConvert()}
                loading={actionPending === 'convert'}
                disabled={isConverted || isLost}
                size="sm"
              >
                <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                {isConverted ? t('convertedAlready') : t('convertAction')}
              </Button>
              {isLost ? (
                <p className="text-xs text-ink-tertiary">{tDetail('cantConvertLost')}</p>
              ) : null}
            </div>
          </section>
        </aside>
      </div>

      {/* Phase A — A6: lost-reason modal. Opens when the agent
          picks a stage with terminalKind='lost'. The modal returns
          { lostReasonId, lostNote? } via onConfirm; we replay the
          stage move with that payload. */}
      <LostReasonModal
        open={lostModalOpen}
        leadName={lead.name}
        reasons={lostReasons}
        onConfirm={onLostReasonConfirm}
        onClose={onLostReasonCancel}
      />
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────
// Small subcomponents
// ───────────────────────────────────────────────────────────────────────

interface QuickActionsBarProps {
  phone: string;
  currentStageCode: string;
  stages: ReadonlyArray<PipelineStage>;
  stageMenuOpen: boolean;
  setStageMenuOpen: (open: boolean) => void;
  disabled: boolean;
  actionPending: string | null;
  onCall: () => void;
  onAddNote: () => void;
  onPickStage: (code: LeadStageCode) => void;
  labels: { call: string; addNote: string; moveStage: string; terminalHint: string };
}

/**
 * Three-button action bar surfaced at the top of the lead detail.
 *   - Call: opens the lead's tel: link in the OS dialer + flips the
 *     activity composer to "call" so the agent can log the outcome.
 *   - Add note: focuses the composer and scrolls it into view.
 *   - Move stage: dropdown of the non-current pipeline stages; picking a
 *     stage moves the lead immediately (skips the "select then save"
 *     two-step still available in the sidebar).
 */
function QuickActionsBar({
  phone,
  currentStageCode,
  stages,
  stageMenuOpen,
  setStageMenuOpen,
  disabled,
  actionPending,
  onCall,
  onAddNote,
  onPickStage,
  labels,
}: QuickActionsBarProps): JSX.Element {
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // Close the dropdown when the user clicks outside or hits Escape.
  useEffect(() => {
    if (!stageMenuOpen) return;
    function onDocClick(e: MouseEvent): void {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(e.target as Node)) setStageMenuOpen(false);
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') setStageMenuOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [stageMenuOpen, setStageMenuOpen]);

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-surface-border bg-surface-card p-3 shadow-card">
      <a
        href={`tel:${phone}`}
        onClick={onCall}
        className="inline-flex h-9 items-center gap-1.5 rounded-md bg-brand-600 px-4 text-sm font-medium text-white transition-colors hover:bg-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-1"
      >
        <PhoneCall className="h-4 w-4" aria-hidden="true" />
        {labels.call}
      </a>

      <Button variant="secondary" size="md" onClick={onAddNote}>
        <StickyNote className="h-4 w-4" aria-hidden="true" />
        {labels.addNote}
      </Button>

      <div ref={wrapperRef} className="relative">
        <Button
          variant="secondary"
          size="md"
          onClick={() => setStageMenuOpen(!stageMenuOpen)}
          disabled={disabled || actionPending === 'stage'}
          loading={actionPending === 'stage'}
        >
          <ArrowRightLeft className="h-4 w-4" aria-hidden="true" />
          {labels.moveStage}
          <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
        {stageMenuOpen ? (
          <ul
            role="menu"
            className="absolute end-0 z-10 mt-1 min-w-[180px] overflow-hidden rounded-md border border-surface-border bg-surface-card py-1 text-sm shadow-card"
          >
            {stages.map((s) => {
              const isCurrent = s.code === currentStageCode;
              return (
                <li key={s.code}>
                  <button
                    role="menuitem"
                    type="button"
                    disabled={isCurrent}
                    onClick={() => onPickStage(s.code as LeadStageCode)}
                    className={cn(
                      'flex w-full items-center justify-between gap-3 px-3 py-1.5 text-start',
                      isCurrent
                        ? 'cursor-not-allowed text-ink-tertiary'
                        : 'text-ink-primary hover:bg-brand-50',
                    )}
                  >
                    <span>{s.name}</span>
                    {isCurrent ? (
                      <span className="text-[11px] uppercase text-ink-tertiary">·</span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>

      {disabled ? <span className="text-xs text-ink-tertiary">{labels.terminalHint}</span> : null}
    </div>
  );
}

function ProfileField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] font-medium uppercase tracking-wide text-ink-tertiary">
        {label}
      </span>
      {children}
    </div>
  );
}

interface ActivityItemProps {
  activity: LeadActivity;
  locale: string;
  now: Date;
  stageLabel: (code: string | undefined) => string;
  userLabel: (uid: string | null | undefined) => string;
  tDetail: ReturnType<typeof useTranslations>;
}

function ActivityItem({
  activity,
  locale,
  now,
  stageLabel,
  userLabel,
  tDetail,
}: ActivityItemProps): JSX.Element {
  const Icon = ACTIVITY_ICON[activity.type] ?? Settings;
  const tone = activityTone(activity.type);
  const dotTone: Record<typeof tone, string> = {
    healthy: 'bg-status-healthy',
    info: 'bg-status-info',
    warning: 'bg-status-warning',
    breach: 'bg-status-breach',
    neutral: 'bg-ink-tertiary',
  };

  const payload = readPayload(activity.payload);
  const summary = formatActivitySummary(activity, payload, stageLabel, userLabel, tDetail);
  const author =
    activity.createdById !== null ? userLabel(activity.createdById) : tDetail('systemAuthor');
  const when = formatRelative(new Date(activity.createdAt), now, locale);

  return (
    <li className="relative">
      <span
        className={cn(
          'absolute -start-[18px] top-1 inline-flex h-3 w-3 items-center justify-center rounded-full ring-2 ring-surface-card',
          dotTone[tone],
        )}
        aria-hidden="true"
      />
      <div className="rounded-md border border-surface-border bg-surface px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <Icon className="h-3.5 w-3.5 text-ink-secondary" aria-hidden="true" />
            <Badge tone={tone}>{tDetail(`activity.type.${activity.type}`)}</Badge>
          </div>
          <span
            className="text-xs text-ink-tertiary"
            title={new Date(activity.createdAt).toLocaleString()}
          >
            {when}
          </span>
        </div>

        {summary ? <p className="mt-1.5 text-sm text-ink-primary">{summary}</p> : null}
        {activity.body && activity.type !== 'note' && activity.type !== 'call' ? (
          <p className="mt-1 text-xs text-ink-secondary">{activity.body}</p>
        ) : null}
        {activity.body && (activity.type === 'note' || activity.type === 'call') ? (
          <p className="mt-1.5 text-sm text-ink-primary">{activity.body}</p>
        ) : null}

        <p className="mt-1.5 text-[11px] text-ink-tertiary">
          {tDetail('activityAuthorBy')} {author}
        </p>
      </div>
    </li>
  );
}

function formatActivitySummary(
  activity: LeadActivity,
  payload: PayloadShape,
  stageLabel: (code: string | undefined) => string,
  userLabel: (uid: string | null | undefined) => string,
  tDetail: ReturnType<typeof useTranslations>,
): string | null {
  switch (activity.type) {
    case 'stage_change':
      return tDetail('activity.summary.stageChange', {
        from: stageLabel(payload.fromStageCode),
        to: stageLabel(payload.toStageCode),
      });
    case 'assignment':
      if (payload.toUserId === null) {
        return tDetail('activity.summary.unassigned');
      }
      if (payload.fromUserId === null || payload.fromUserId === undefined) {
        return tDetail('activity.summary.assigned', { user: userLabel(payload.toUserId) });
      }
      return tDetail('activity.summary.reassigned', {
        from: userLabel(payload.fromUserId),
        to: userLabel(payload.toUserId),
      });
    case 'auto_assignment':
      return tDetail('activity.summary.autoAssignment', {
        strategy: payload.strategy ?? 'round_robin',
      });
    case 'sla_breach':
      return activity.body ?? tDetail('activity.summary.slaBreach');
    case 'system':
      if (payload.event === 'converted') {
        return tDetail('activity.summary.converted');
      }
      if (payload.event === 'created') {
        return tDetail('activity.summary.created', {
          stage: stageLabel(
            payload.fromStageCode ??
              (activity.payload?.['stageCode'] as string | undefined) ??
              undefined,
          ),
        });
      }
      if (payload.event === 'updated') {
        return tDetail('activity.summary.updated');
      }
      return null;
    case 'note':
    case 'call':
      // Body is rendered separately for note/call.
      return null;
    default:
      return null;
  }
}
