'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import {
  AlertTriangle,
  Calendar,
  CheckCircle2,
  ClipboardList,
  Clock,
  Loader2,
  MessageCircle,
  Phone,
  Wrench,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataTable, type Column } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Notice } from '@/components/ui/notice';
import { FieldGated } from '@/components/ui/field-gated';
import { useToast } from '@/components/ui/toast';
import { NextActionCell } from '@/components/admin/next-action-cell';
import { SnoozeModal } from '@/components/agent/snooze-modal';
import { ApiError, followUpsApi, leadsApi, pipelineApi } from '@/lib/api';
import type {
  FollowUpActionType,
  Lead,
  LeadFollowUp,
  LeadStageCode,
  PipelineStage,
  SlaStatus,
} from '@/lib/api-types';
import { getCachedMe } from '@/lib/auth';
import { useRealtime } from '@/lib/realtime';
import { cn } from '@/lib/utils';

/**
 * /agent/workspace (C31 + C36) — sales-agent "My Day" worklist.
 *
 * MVP columns: name / phone / stage / SLA. Agents update a lead via
 * the unified "Update" modal that combines (a) stage move,
 * (b) optional note, and (c) optional next-action follow-up. Above
 * the table sits "My Follow-ups" — pending + overdue first.
 */

const ACTION_TYPES: readonly FollowUpActionType[] = ['call', 'whatsapp', 'visit', 'other'];

function slaTone(s: SlaStatus): 'healthy' | 'warning' | 'breach' | 'inactive' {
  if (s === 'breached') return 'breach';
  if (s === 'paused') return 'inactive';
  return 'healthy';
}

/**
 * P3-01 — `tel:` and WhatsApp deep-link helpers. Both targets work
 * from a mobile browser tap and from a desktop browser (the OS
 * routes the protocol). The phone is stored as E.164 already so
 * we can use it verbatim; `wa.me` strips the leading `+`.
 */
function telHref(phoneE164: string): string {
  return `tel:${phoneE164}`;
}
function whatsappHref(phoneE164: string): string {
  const digits = phoneE164.startsWith('+') ? phoneE164.slice(1) : phoneE164;
  return `https://wa.me/${digits}`;
}

interface UpdateFormState {
  stageCode: LeadStageCode | '';
  note: string;
  scheduleNext: boolean;
  actionType: FollowUpActionType;
  /** yyyy-mm-dd from <input type="date"> */
  date: string;
  /** HH:mm from <input type="time"> */
  time: string;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function defaultTime(): string {
  // Snap to "in 1 hour" rounded to the nearest 15 minutes.
  const d = new Date(Date.now() + 60 * 60 * 1000);
  d.setMinutes(Math.round(d.getMinutes() / 15) * 15, 0, 0);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

const EMPTY_UPDATE_FORM: UpdateFormState = {
  stageCode: '',
  note: '',
  scheduleNext: false,
  actionType: 'call',
  date: todayIso(),
  time: defaultTime(),
};

export default function AgentWorkspacePage(): JSX.Element {
  const t = useTranslations('agent.workspace');
  const tCommon = useTranslations('admin.common');
  const tToast = useTranslations('agent.followUpToast');
  const { toast } = useToast();

  const [meId, setMeId] = useState<string | null>(null);
  const [rows, setRows] = useState<Lead[]>([]);
  const [stages, setStages] = useState<PipelineStage[]>([]);
  const [followUps, setFollowUps] = useState<LeadFollowUp[]>([]);
  const [overdue, setOverdue] = useState<Lead[]>([]);
  const [dueToday, setDueToday] = useState<Lead[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Update modal state — keyed by the lead being acted on.
  const [openFor, setOpenFor] = useState<Lead | null>(null);
  const [form, setForm] = useState<UpdateFormState>(EMPTY_UPDATE_FORM);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Phase A — A7: snooze picker. Holds the follow-up the agent is
  // currently snoozing; null when the modal is closed.
  const [snoozeFor, setSnoozeFor] = useState<LeadFollowUp | null>(null);

  // Page-load toast: surface the overdue count once on mount so agents
  // see it the moment they open the workspace. The `shown` ref prevents
  // re-firing on every reload (which would happen because `overdue` is
  // refetched on lead.assigned realtime events).
  const overdueToastShownRef = useRef<boolean>(false);

  useEffect(() => {
    const me = getCachedMe();
    setMeId(me?.userId ?? null);
  }, []);

  const reload = useCallback(async (): Promise<void> => {
    if (!meId) return;
    setLoading(true);
    setError(null);
    try {
      const [page, st, mine, ovd, today, summary] = await Promise.all([
        leadsApi.list({ assignedToId: meId, limit: 200 }),
        pipelineApi.listStages(),
        followUpsApi.mine({ status: 'pending', limit: 100 }),
        leadsApi.overdue(),
        leadsApi.dueToday(),
        followUpsApi.meSummary(),
      ]);
      setRows(page.items);
      setStages(st);
      setFollowUps(mine);
      setOverdue(ovd);
      setDueToday(today);
      // Phase A — A7: page-load toast for overdue follow-ups. Fires
      // exactly once per mount, even if the user triggers re-fetches.
      if (!overdueToastShownRef.current && summary.overdueCount > 0) {
        overdueToastShownRef.current = true;
        toast({
          tone: 'warning',
          title: tToast('overdueTitle', { count: summary.overdueCount }),
          body: tToast('overdueBody'),
          duration: 7000,
        });
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [meId, toast, tToast]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // P3-02 — refresh the worklist when the API tells us this user just
  // got a new lead assigned (manual / round-robin / SLA reassignment).
  // The reload is cheap; no debounce needed because the server only
  // emits when something actually changed.
  useRealtime('lead.assigned', (event) => {
    if (!meId) return;
    if (event.toUserId !== meId) return;
    void reload();
  });

  const stageOptions = useMemo(() => stages, [stages]);

  // Lead ids that have a pending overdue follow-up — used to highlight
  // them in the worklist independent of slaStatus. C37 — also unions
  // the dedicated /leads/overdue feed so a backend-detected overdue
  // lead lights up even if the matching follow-up isn't in the
  // (capped) "my follow-ups" payload.
  const overdueLeadIds = useMemo(() => {
    const now = Date.now();
    const ids = new Set<string>();
    for (const f of followUps) {
      if (!f.completedAt && Date.parse(f.dueAt) < now) ids.add(f.leadId);
    }
    for (const l of overdue) ids.add(l.id);
    return ids;
  }, [followUps, overdue]);

  function openUpdate(l: Lead): void {
    setForm({
      ...EMPTY_UPDATE_FORM,
      stageCode: l.stage.code,
      note: '',
      scheduleNext: false,
      date: todayIso(),
      time: defaultTime(),
    });
    setFormError(null);
    setOpenFor(l);
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (!openFor) return;
    setSubmitting(true);
    setFormError(null);
    const lead = openFor;
    try {
      // 1) Stage change if it actually moved.
      if (form.stageCode && form.stageCode !== lead.stage.code) {
        await leadsApi.moveStage(lead.id, { stageCode: form.stageCode });
      }
      // 2) Note if non-empty.
      if (form.note.trim().length > 0) {
        await leadsApi.addActivity(lead.id, { type: 'note', body: form.note.trim() });
      }
      // 3) Follow-up if scheduled.
      if (form.scheduleNext) {
        const dueAt = new Date(`${form.date}T${form.time}:00`).toISOString();
        await followUpsApi.create(lead.id, {
          actionType: form.actionType,
          dueAt,
          ...(form.note.trim().length > 0 ? { note: form.note.trim() } : {}),
        });
      }
      setNotice(t('updateDone'));
      setOpenFor(null);
      await reload();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function completeFollowUp(id: string): Promise<void> {
    setNotice(null);
    setError(null);
    try {
      await followUpsApi.complete(id);
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  // Phase A — A7: apply a snooze (or clear it) and close the picker.
  // Errors propagate to the SnoozeModal which renders the message.
  async function onSnoozeConfirm(snoozedUntil: string | null): Promise<void> {
    if (!snoozeFor) return;
    setNotice(null);
    setError(null);
    await followUpsApi.update(snoozeFor.id, { snoozedUntil });
    setSnoozeFor(null);
    await reload();
    toast({
      tone: 'success',
      title: snoozedUntil
        ? tToast('snoozeApplied', { when: new Date(snoozedUntil).toLocaleString() })
        : tToast('snoozeCleared'),
    });
  }

  // B3 — Now ref for the NextActionCell column. Re-derived per
  // render so relative labels track the wall clock (the worklist
  // reloads on lead.assigned realtime + on every user action).
  const tableNow = new Date();

  // Phase C — C7: same field-permission gating pattern as the
  // /admin/leads list (cell-level placeholders keep table layout
  // stable; the Open detail link hides when `id` is denied because
  // the URL would be broken).
  const placeholder = <span className="text-ink-tertiary">—</span>;
  const columns: ReadonlyArray<Column<Lead>> = [
    {
      key: 'name',
      header: t('cols.name'),
      render: (l) => (
        <div className="flex flex-col leading-tight">
          <FieldGated resource="lead" field="name" fallback={placeholder}>
            <span className="flex items-center gap-1.5">
              {overdueLeadIds.has(l.id) ? (
                <AlertTriangle
                  className="h-3.5 w-3.5 text-status-breach"
                  aria-label={t('overdueIndicator')}
                />
              ) : null}
              <span className="font-medium text-ink-primary">{l.name}</span>
            </span>
          </FieldGated>
          <FieldGated resource="lead" field="phone">
            <span className="flex items-center gap-1 text-xs text-ink-tertiary">
              <Phone className="h-3 w-3" aria-hidden="true" />
              <code className="font-mono">{l.phone}</code>
            </span>
          </FieldGated>
        </div>
      ),
    },
    {
      key: 'source',
      header: t('cols.source'),
      render: (l) => (
        <FieldGated resource="lead" field="source" fallback={placeholder}>
          <span className="text-xs uppercase tracking-wide">{l.source}</span>
        </FieldGated>
      ),
    },
    {
      key: 'stage',
      header: t('cols.stage'),
      render: (l) => (
        <span className="inline-flex items-center gap-1 rounded-full border border-surface-border bg-surface px-2 py-0.5 text-xs">
          {l.stage.name}
        </span>
      ),
    },
    {
      key: 'nextAction',
      header: t('cols.nextAction'),
      render: (l) => (
        <FieldGated resource="lead" field="nextActionDueAt" fallback={placeholder}>
          <NextActionCell dueAt={l.nextActionDueAt} now={tableNow} />
        </FieldGated>
      ),
    },
    {
      key: 'sla',
      header: t('cols.sla'),
      render: (l) => (
        <FieldGated resource="lead" field="slaStatus" fallback={placeholder}>
          <Badge tone={slaTone(l.slaStatus)}>{l.slaStatus}</Badge>
        </FieldGated>
      ),
    },
    {
      key: 'actions',
      header: t('cols.actions'),
      render: (l) => (
        <div className="flex flex-wrap items-center gap-2">
          <FieldGated resource="lead" field="phone">
            <a
              href={telHref(l.phone)}
              className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-surface-border bg-surface-card text-ink-primary hover:bg-brand-50"
              title={t('actions.call')}
              aria-label={t('actions.call')}
            >
              <Phone className="h-4 w-4" aria-hidden="true" />
            </a>
            <a
              href={whatsappHref(l.phone)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-surface-border bg-surface-card text-ink-primary hover:bg-brand-50"
              title={t('actions.whatsapp')}
              aria-label={t('actions.whatsapp')}
            >
              <MessageCircle className="h-4 w-4" aria-hidden="true" />
            </a>
          </FieldGated>
          <Button variant="secondary" size="sm" onClick={() => openUpdate(l)}>
            <Wrench className="h-3.5 w-3.5" aria-hidden="true" />
            {t('actions.update')}
          </Button>
          {/* C7: hide the Open Detail link when `id` is denied —
              the URL would resolve to /admin/leads/undefined. */}
          <FieldGated resource="lead" field="id">
            <Link
              href={`/admin/leads/${l.id}`}
              className="text-xs font-medium text-brand-700 hover:text-brand-800"
            >
              {t('actions.openDetail')} →
            </Link>
          </FieldGated>
        </div>
      ),
    },
  ];

  if (!meId) {
    return (
      <div className="flex flex-col gap-3">
        <header>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-ink-primary">
            <ClipboardList className="h-5 w-5 text-brand-700" aria-hidden="true" />
            {t('title')}
          </h1>
          <p className="mt-1 text-sm text-ink-secondary">{t('subtitle')}</p>
        </header>
        <Notice tone="info">{t('noUser')}</Notice>
      </div>
    );
  }

  const overdueFollowUps = followUps.filter(
    (f) => !f.completedAt && Date.parse(f.dueAt) < Date.now(),
  );
  const upcomingFollowUps = followUps.filter(
    (f) => !f.completedAt && Date.parse(f.dueAt) >= Date.now(),
  );

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-ink-primary">
            <ClipboardList className="h-5 w-5 text-brand-700" aria-hidden="true" />
            {t('title')}
          </h1>
          <p className="mt-1 text-sm text-ink-secondary">{t('subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-status-breach/30 bg-status-breach/10 px-3 py-1 text-xs font-medium text-status-breach">
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
            {overdue.length} {t('counters.overdue')}
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-status-warning/30 bg-status-warning/10 px-3 py-1 text-xs font-medium text-status-warning">
            <Calendar className="h-3.5 w-3.5" aria-hidden="true" />
            {dueToday.length} {t('counters.dueToday')}
          </span>
        </div>
      </header>

      {notice ? <Notice tone="success">{notice}</Notice> : null}
      {error ? (
        <Notice tone="error">
          <div className="flex items-start justify-between gap-2">
            <span>{error}</span>
            <Button variant="ghost" size="sm" onClick={() => void reload()}>
              {tCommon('retry')}
            </Button>
          </div>
        </Notice>
      ) : null}

      {/* C37 — Overdue Leads (red) */}
      {overdue.length > 0 ? (
        <section className="rounded-lg border border-status-breach/30 bg-status-breach/5 shadow-card">
          <header className="flex items-center justify-between gap-2 border-b border-status-breach/30 px-3 py-2">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-status-breach">
              <AlertTriangle className="h-4 w-4" aria-hidden="true" />
              {t('overdueSection.title')}
              <Badge tone="breach">{overdue.length}</Badge>
            </h2>
          </header>
          <ul className="divide-y divide-status-breach/20">
            {overdue.map((l) => (
              <li
                key={l.id}
                className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
              >
                <div className="flex flex-col leading-tight">
                  <span className="text-sm font-medium text-ink-primary">{l.name}</span>
                  <span className="flex items-center gap-1 text-xs text-ink-tertiary">
                    <Phone className="h-3 w-3" aria-hidden="true" />
                    <code className="font-mono">{l.phone}</code>
                    <span className="ms-2">{l.stage.name}</span>
                    {l.nextActionDueAt ? (
                      <span className="ms-2 text-status-breach">
                        {t('overdueSection.dueLabel')}{' '}
                        {new Date(l.nextActionDueAt).toLocaleString()}
                      </span>
                    ) : null}
                  </span>
                </div>
                <Button variant="secondary" size="sm" onClick={() => openUpdate(l)}>
                  <Wrench className="h-3.5 w-3.5" aria-hidden="true" />
                  {t('actions.update')}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* C37 — Due Today (amber) */}
      {dueToday.length > 0 ? (
        <section className="rounded-lg border border-status-warning/30 bg-status-warning/5 shadow-card">
          <header className="flex items-center justify-between gap-2 border-b border-status-warning/30 px-3 py-2">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-status-warning">
              <Calendar className="h-4 w-4" aria-hidden="true" />
              {t('dueTodaySection.title')}
              <Badge tone="warning">{dueToday.length}</Badge>
            </h2>
          </header>
          <ul className="divide-y divide-status-warning/20">
            {dueToday.map((l) => (
              <li
                key={l.id}
                className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
              >
                <div className="flex flex-col leading-tight">
                  <span className="text-sm font-medium text-ink-primary">{l.name}</span>
                  <span className="flex items-center gap-1 text-xs text-ink-tertiary">
                    <Phone className="h-3 w-3" aria-hidden="true" />
                    <code className="font-mono">{l.phone}</code>
                    <span className="ms-2">{l.stage.name}</span>
                    {l.nextActionDueAt ? (
                      <span className="ms-2 text-status-warning">
                        {t('dueTodaySection.atLabel')}{' '}
                        {new Date(l.nextActionDueAt).toLocaleTimeString([], {
                          hour: 'numeric',
                          minute: '2-digit',
                        })}
                      </span>
                    ) : null}
                  </span>
                </div>
                <Button variant="secondary" size="sm" onClick={() => openUpdate(l)}>
                  <Wrench className="h-3.5 w-3.5" aria-hidden="true" />
                  {t('actions.update')}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* My Follow-ups (C36) */}
      <section className="rounded-lg border border-surface-border bg-surface-card shadow-card">
        <header className="flex items-center justify-between gap-2 border-b border-surface-border px-3 py-2">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-ink-primary">
            <Calendar className="h-4 w-4 text-brand-700" aria-hidden="true" />
            {t('followUps.title')}
            {overdueFollowUps.length > 0 ? (
              <Badge tone="breach">
                {overdueFollowUps.length} {t('followUps.overdue')}
              </Badge>
            ) : null}
          </h2>
          <span className="text-xs text-ink-tertiary">
            {followUps.length === 0
              ? t('followUps.empty')
              : `${followUps.length} ${t('followUps.pending')}`}
          </span>
        </header>
        {followUps.length === 0 ? (
          <p className="p-4 text-sm text-ink-tertiary">{t('followUps.emptyHint')}</p>
        ) : (
          <ul className="divide-y divide-surface-border">
            {[...overdueFollowUps, ...upcomingFollowUps].map((f) => {
              const overdue = Date.parse(f.dueAt) < Date.now();
              return (
                <li
                  key={f.id}
                  className={cn(
                    'flex flex-wrap items-center justify-between gap-2 px-3 py-2',
                    overdue ? 'bg-status-breach/5' : '',
                  )}
                >
                  <div className="flex flex-col leading-tight">
                    <span className="flex items-center gap-2 text-sm font-medium text-ink-primary">
                      {overdue ? (
                        <AlertTriangle
                          className="h-3.5 w-3.5 text-status-breach"
                          aria-hidden="true"
                        />
                      ) : null}
                      {f.lead?.name ?? '—'} ·{' '}
                      <code className="font-mono text-xs">{f.lead?.phone ?? ''}</code>
                    </span>
                    <span className="text-xs text-ink-secondary">
                      {t(`followUps.types.${f.actionType}`)} · {new Date(f.dueAt).toLocaleString()}
                      {f.note ? ` · ${f.note}` : ''}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    {f.lead ? (
                      <Link
                        href={`/admin/leads/${f.lead.id}`}
                        className="text-xs font-medium text-brand-700 hover:text-brand-800"
                      >
                        {t('actions.openDetail')} →
                      </Link>
                    ) : null}
                    <Button variant="ghost" size="sm" onClick={() => setSnoozeFor(f)}>
                      <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                      {t('followUps.snooze')}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => void completeFollowUp(f.id)}>
                      <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                      {t('followUps.complete')}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* My Leads */}
      {loading ? (
        <div className="flex items-center justify-center gap-2 rounded-lg border border-surface-border bg-surface-card p-8 text-sm text-ink-secondary">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          {tCommon('loading')}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<ClipboardList className="h-7 w-7" aria-hidden="true" />}
          title={t('emptyTitle')}
          body={t('emptyBody')}
        />
      ) : (
        <>
          {/*
           * P3-01 — sm and up: existing DataTable.
           * Below sm: stacked cards. The card layout puts the most
           * important call-to-action buttons (call / WhatsApp /
           * update) on a single row of 44px-min tap targets so
           * agents can act with one thumb.
           */}
          <div className="hidden sm:block">
            <DataTable<Lead>
              rows={rows}
              columns={columns}
              /* C7: phone fallback when `lead.id` is denied. */
              keyOf={(l) => l.id ?? l.phone ?? ''}
            />
          </div>
          <ul className="flex flex-col gap-2 sm:hidden">
            {rows.map((l) => (
              <li
                key={l.id ?? l.phone ?? ''}
                className={cn(
                  'flex flex-col gap-2 rounded-lg border bg-surface-card p-3 shadow-card',
                  overdueLeadIds.has(l.id)
                    ? 'border-status-breach/40 bg-status-breach/5'
                    : 'border-surface-border',
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 flex-col leading-tight">
                    <FieldGated resource="lead" field="name">
                      <span className="flex items-center gap-1.5">
                        {overdueLeadIds.has(l.id) ? (
                          <AlertTriangle
                            className="h-3.5 w-3.5 shrink-0 text-status-breach"
                            aria-label={t('overdueIndicator')}
                          />
                        ) : null}
                        <span className="truncate text-sm font-semibold text-ink-primary">
                          {l.name}
                        </span>
                      </span>
                    </FieldGated>
                    <FieldGated resource="lead" field="phone">
                      <span className="flex items-center gap-1 text-xs text-ink-tertiary">
                        <Phone className="h-3 w-3" aria-hidden="true" />
                        <code className="font-mono">{l.phone}</code>
                      </span>
                    </FieldGated>
                  </div>
                  <FieldGated resource="lead" field="slaStatus">
                    <Badge tone={slaTone(l.slaStatus)}>{l.slaStatus}</Badge>
                  </FieldGated>
                </div>
                <div className="flex items-center gap-2 text-xs text-ink-secondary">
                  <span className="inline-flex items-center gap-1 rounded-full border border-surface-border bg-surface px-2 py-0.5">
                    {l.stage.name}
                  </span>
                  <FieldGated resource="lead" field="source">
                    <span className="uppercase tracking-wide">{l.source}</span>
                  </FieldGated>
                </div>
                <div className="flex items-center gap-2">
                  <FieldGated resource="lead" field="phone">
                    <a
                      href={telHref(l.phone)}
                      className="inline-flex h-11 flex-1 items-center justify-center gap-1.5 rounded-md border border-surface-border bg-surface text-sm font-medium text-ink-primary hover:bg-brand-50"
                      aria-label={t('actions.call')}
                    >
                      <Phone className="h-4 w-4" aria-hidden="true" />
                      {t('actions.call')}
                    </a>
                    <a
                      href={whatsappHref(l.phone)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex h-11 flex-1 items-center justify-center gap-1.5 rounded-md border border-surface-border bg-surface text-sm font-medium text-ink-primary hover:bg-brand-50"
                      aria-label={t('actions.whatsapp')}
                    >
                      <MessageCircle className="h-4 w-4" aria-hidden="true" />
                      {t('actions.whatsapp')}
                    </a>
                  </FieldGated>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="h-11 flex-1"
                    onClick={() => openUpdate(l)}
                  >
                    <Wrench className="h-4 w-4" aria-hidden="true" />
                    {t('actions.update')}
                  </Button>
                </div>
                <FieldGated resource="lead" field="id">
                  <Link
                    href={`/admin/leads/${l.id}`}
                    className="self-end text-xs font-medium text-brand-700 hover:text-brand-800"
                  >
                    {t('actions.openDetail')} →
                  </Link>
                </FieldGated>
              </li>
            ))}
          </ul>
        </>
      )}

      <Modal
        open={openFor !== null}
        title={t('updateModalTitle')}
        onClose={() => setOpenFor(null)}
        width="lg"
      >
        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          {formError ? <Notice tone="error">{formError}</Notice> : null}

          <Field label={t('updateStageLabel')} required>
            <Select
              value={form.stageCode}
              onChange={(e) => setForm({ ...form, stageCode: e.target.value as LeadStageCode })}
              required
            >
              <option value="" disabled>
                {t('stagePickerPlaceholder')}
              </option>
              {stageOptions.map((s) => (
                <option key={s.id} value={s.code}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field label={t('updateNoteLabel')}>
            <Textarea
              value={form.note}
              onChange={(e) => setForm({ ...form, note: e.target.value })}
              rows={3}
              placeholder={t('updateNotePlaceholder')}
            />
          </Field>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.scheduleNext}
              onChange={(e) => setForm({ ...form, scheduleNext: e.target.checked })}
            />
            {t('updateScheduleToggle')}
          </label>

          {form.scheduleNext ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label={t('nextActionType')} required>
                <Select
                  value={form.actionType}
                  onChange={(e) =>
                    setForm({ ...form, actionType: e.target.value as FollowUpActionType })
                  }
                  required
                >
                  {ACTION_TYPES.map((a) => (
                    <option key={a} value={a}>
                      {t(`followUps.types.${a}`)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('nextActionDate')} required>
                <Input
                  type="date"
                  value={form.date}
                  onChange={(e) => setForm({ ...form, date: e.target.value })}
                  required
                />
              </Field>
              <Field label={t('nextActionTime')} required>
                <Input
                  type="time"
                  value={form.time}
                  onChange={(e) => setForm({ ...form, time: e.target.value })}
                  required
                />
              </Field>
            </div>
          ) : null}

          <div className="flex items-center justify-end gap-2">
            <Button variant="secondary" type="button" onClick={() => setOpenFor(null)}>
              {tCommon('cancel')}
            </Button>
            <Button type="submit" loading={submitting}>
              {tCommon('save')}
            </Button>
          </div>
        </form>
      </Modal>

      <SnoozeModal
        open={snoozeFor !== null}
        leadName={snoozeFor?.lead?.name ?? undefined}
        currentlySnoozed={Boolean(
          snoozeFor?.snoozedUntil && Date.parse(snoozeFor.snoozedUntil) > Date.now(),
        )}
        onConfirm={onSnoozeConfirm}
        onClose={() => setSnoozeFor(null)}
      />
    </div>
  );
}
