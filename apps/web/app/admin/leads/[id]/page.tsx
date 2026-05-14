'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, useCallback, type FormEvent } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import {
  ArrowLeft,
  ArrowRightLeft,
  CalendarPlus,
  CheckCircle2,
  ChevronDown,
  Mail,
  Phone,
  PhoneCall,
  Plus,
  Repeat2,
  StickyNote,
  Trophy,
  UserCog,
  XCircle,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Select, Textarea } from '@/components/ui/input';
import { LifecycleBadge } from '@/components/ui/lifecycle-badge';
import { FieldGated } from '@/components/ui/field-gated';
import { Notice } from '@/components/ui/notice';
import { Tabs, TabPanel, type TabDescriptor } from '@/components/ui/tabs';
import { useToast } from '@/components/ui/toast';
import { LostReasonModal, type LostReasonResult } from '@/components/admin/lost-reason-modal';
import { FollowUpQuickModal } from '@/components/admin/follow-up-quick-modal';
import { ReactivateLeadModal } from '@/components/admin/reactivate-lead-modal';
import { RotateLeadModal } from '@/components/admin/rotate-lead-modal';
import { ActiveDftConvertDecisionModal } from '@/components/admin/lead-detail/active-dft-convert-decision-modal';
import { EvidenceCard } from '@/components/admin/lead-detail/evidence-card';
import { PartnerDataCard } from '@/components/admin/lead-detail/partner-data-card';
import { RotationHistoryCard } from '@/components/admin/lead-detail/rotation-history-card';
import { ActivityTimeline } from '@/components/admin/lead-detail/activity-timeline';
import { AttemptsHistoryCard } from '@/components/admin/lead-detail/attempts-history-card';
import { StageStatusPicker } from '@/components/admin/lead-detail/stage-status-picker';
import { ListNavigator } from '@/components/admin/lead-detail/list-navigator';
import { NextActionCard } from '@/components/admin/lead-detail/next-action-card';
import { StageStatusSlot } from '@/components/admin/lead-detail/stage-status-slot';
import { JourneyBar } from '@/components/admin/lead-detail/journey-bar';
import { AddActionDrawer } from '@/components/admin/lead-detail/add-action-drawer';
import { PendingTransitionRequestCard } from '@/components/admin/lead-detail/pending-transition-request-card';
import { PartnerPresenceSummary } from '@/components/admin/lead-detail/partner-presence-summary';
import { PartnerPresenceTable } from '@/components/admin/lead-detail/partner-presence-table';
import {
  AttributionCard,
  LastActivityCard,
  SlaCard,
} from '@/components/admin/lead-detail/sidebar-cards';
import { SnoozeModal } from '@/components/agent/snooze-modal';
import {
  ApiError,
  followUpsApi,
  leadsApi,
  lostReasonsApi,
  partnerVerificationApi,
  pipelineApi,
  pipelinesApi,
  presenceApi,
  teamsApi,
  usersApi,
} from '@/lib/api';
import type {
  AdminUser,
  Lead,
  LeadActivity,
  LeadFollowUp,
  LeadStageCode,
  LostReason,
  PipelineStage,
  SlaStatus,
  Team,
} from '@/lib/api-types';
import { hasCapability } from '@/lib/auth';
import { readListContext, type NavigatorPosition } from '@/lib/lead-list-context';
import { cn } from '@/lib/utils';

function slaTone(s: SlaStatus): 'healthy' | 'warning' | 'breach' | 'inactive' {
  if (s === 'breached') return 'breach';
  if (s === 'paused') return 'inactive';
  return 'healthy';
}

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

  const { toast } = useToast();

  const [lead, setLead] = useState<Lead | null>(null);
  const [activities, setActivities] = useState<LeadActivity[]>([]);
  const [followUps, setFollowUps] = useState<LeadFollowUp[]>([]);
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
  const [activityType, setActivityType] = useState<'note' | 'call'>('note');
  const [activityBody, setActivityBody] = useState<string>('');
  const [actionPending, setActionPending] = useState<string | null>(null);

  // D4.8 — Active / DFT / Convert Decision Modal state.
  const [convertModalOpen, setConvertModalOpen] = useState<boolean>(false);
  const [convertError, setConvertError] = useState<string | null>(null);

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

  // Phase B — B1: + Follow-up modal + snooze modal state.
  const [followUpModalOpen, setFollowUpModalOpen] = useState<boolean>(false);
  const [snoozeFor, setSnoozeFor] = useState<LeadFollowUp | null>(null);

  // Phase D2 — D2.6: manual reactivation modal state.
  const [reactivateOpen, setReactivateOpen] = useState<boolean>(false);
  const [reactivateError, setReactivateError] = useState<string | null>(null);
  const [reactivateSubmitting, setReactivateSubmitting] = useState<boolean>(false);

  // Phase D3 — D3.4: rotation modal state.
  const [rotateOpen, setRotateOpen] = useState<boolean>(false);
  const [rotateError, setRotateError] = useState<string | null>(null);
  const [rotateSubmitting, setRotateSubmitting] = useState<boolean>(false);

  // Sprint 2.A — Smart Tabs. Default to Overview; deep-link via URL
  // ?tab=… is a polish item for a later sprint.
  type LeadDetailTab =
    | 'overview'
    | 'profile'
    | 'partnerPresence'
    | 'documents'
    | 'operations'
    | 'audit';
  const [activeTab, setActiveTab] = useState<LeadDetailTab>('overview');

  // Sprint 2.B — Add Action drawer state. Single entry point that
  // routes to lifecycle / profile / documents / partner-data / note
  // panels (each surfacing its own write path).
  //
  // Sprint 3.1 — extra fields let the QuickActionsBar Move Stage
  // shortcut open the drawer directly on the Lifecycle panel with
  // the picked stage pre-selected — so it CANNOT bypass approval
  // rules (the drawer's normal save flow handles requiresApproval
  // for us).
  const [addActionOpen, setAddActionOpen] = useState<boolean>(false);
  const [addActionInitialArea, setAddActionInitialArea] = useState<
    'lifecycle' | 'profile' | 'documents' | 'partnerData' | 'note' | undefined
  >(undefined);
  const [addActionInitialStageId, setAddActionInitialStageId] = useState<string | undefined>(
    undefined,
  );

  // Tick once a minute so relative-time labels stay fresh in the
  // NextActionCard ("Due in 2 min" → "Due in 1 min" → "Overdue 1 min").
  // Cheap; the page doesn't refetch on tick.
  const [tickNow, setTickNow] = useState<Date>(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setTickNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);

  // Phase B — Navigation: read the list-context cache (filled by the
  // /admin/leads page) and re-resolve when the lead id changes —
  // walking prev/next pushes a new id, which re-fires this.
  const [navigatorPos, setNavigatorPos] = useState<NavigatorPosition | null>(null);
  useEffect(() => {
    setNavigatorPos(readListContext(id));
  }, [id]);

  // Sprint 11 — Sprint 10 carry-forward: ship a presence activity
  // ping when the operator opens Lead Detail so the chip's
  // `currentContext` reads "lead" for other viewers. Best-effort
  // (presence outage must never break Lead Detail).
  useEffect(() => {
    if (!id) return;
    void presenceApi
      .activity({ context: 'lead_detail', entityType: 'lead', entityId: id })
      .catch(() => {
        /* swallow */
      });
  }, [id]);

  // Keyboard shortcuts: Alt+←/→ + j/k. Active only when no input,
  // textarea, or contentEditable element is focused — typing in the
  // composer must not jump to a different lead.
  useEffect(() => {
    if (!navigatorPos) return;
    function isTypingTarget(t: EventTarget | null): boolean {
      const el = t as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
      if (el.isContentEditable) return true;
      return false;
    }
    function onKey(e: KeyboardEvent): void {
      if (isTypingTarget(e.target)) return;
      // Alt+Arrow normally walks browser history. Inside the lead
      // detail we override it for prev/next-lead — preventDefault so
      // both intents don't fire.
      if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        const id = e.key === 'ArrowLeft' ? navigatorPos!.prevId : navigatorPos!.nextId;
        if (id) {
          e.preventDefault();
          router.push(`/admin/leads/${id}`);
        }
        return;
      }
      // j/k vim-style; ignore when any modifier is held so app
      // shortcuts (Ctrl+K command palette, etc.) keep working.
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (e.key === 'j' && navigatorPos!.nextId) {
        e.preventDefault();
        router.push(`/admin/leads/${navigatorPos!.nextId}`);
      } else if (e.key === 'k' && navigatorPos!.prevId) {
        e.preventDefault();
        router.push(`/admin/leads/${navigatorPos!.prevId}`);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigatorPos, router]);

  const reload = useCallback(async (): Promise<void> => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const [l, acts, usrs, tms, lr, fus] = await Promise.all([
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
        // Phase B — B1: per-lead follow-ups feed the NextActionCard
        // (earliest pending wins; effective-due aware).
        followUpsApi.listForLead(id).catch(() => [] as LeadFollowUp[]),
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
      setFollowUps(fus);
      setStages(st);
      setUsers(usrs.items);
      setTeams(tms);
      setLostReasons(lr);
      setAssigneeId(l.assignedToId ?? '');
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

  // Phase B — B1: pick the earliest pending follow-up (effective-due
  // aware) so the NextActionCard renders the right row + lets the
  // agent complete / snooze without leaving the page.
  const nextFollowUp = useMemo<LeadFollowUp | null>(() => {
    let best: { row: LeadFollowUp; eff: number } | null = null;
    for (const f of followUps) {
      if (f.completedAt) continue;
      const due = new Date(f.dueAt).getTime();
      const sn = f.snoozedUntil ? new Date(f.snoozedUntil).getTime() : 0;
      const eff = Math.max(due, sn);
      if (!best || eff < best.eff) best = { row: f, eff };
    }
    return best?.row ?? null;
  }, [followUps]);

  // Most-recent activity drives the "Last activity" sidebar card.
  // Activities arrive newest-first from the API today, but sort
  // defensively so the card can't surprise us.
  const lastActivity = useMemo<LeadActivity | null>(() => {
    if (activities.length === 0) return null;
    let best = activities[0]!;
    for (const a of activities) {
      if (new Date(a.createdAt).getTime() > new Date(best.createdAt).getTime()) best = a;
    }
    return best;
  }, [activities]);
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

  /**
   * Sprint 3.1 — QuickActionsBar's Move Stage shortcut now opens
   * the Add Action drawer prefilled on the Lifecycle panel with
   * the target stage pre-picked, instead of calling moveStage
   * directly. This eliminates the approval-bypass risk: the
   * standard save flow inside the panel handles requiresApproval
   * uniformly. The agent can still change the stage / pick a
   * status / type notes in the drawer, but cannot bypass any
   * configured smart-rule approval.
   */
  function quickMoveToStage(code: LeadStageCode): void {
    if (!lead || code === lead.stage.code) return;
    setStageMenuOpen(false);
    const target = stages.find((s) => s.code === code);
    if (!target) return;
    setAddActionInitialArea('lifecycle');
    setAddActionInitialStageId(target.id);
    setAddActionOpen(true);
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

  // ─────── Phase B — B1: follow-up handlers + derived next action ───

  async function onAddFollowUp(input: {
    actionType: 'call' | 'whatsapp' | 'visit' | 'other';
    dueAt: string;
    note?: string;
  }): Promise<void> {
    if (!lead) return;
    await followUpsApi.create(lead.id, input);
    setFollowUpModalOpen(false);
    await reload();
    toast({ tone: 'success', title: tDetail('followUpModal.created') });
  }

  async function onCompleteFollowUp(id: string): Promise<void> {
    setError(null);
    try {
      await followUpsApi.complete(id);
      await reload();
      toast({ tone: 'success', title: tDetail('nextAction.completedToast') });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  async function onSnoozeConfirm(snoozedUntil: string | null): Promise<void> {
    if (!snoozeFor) return;
    await followUpsApi.update(snoozeFor.id, { snoozedUntil });
    setSnoozeFor(null);
    await reload();
    toast({
      tone: 'success',
      title: snoozedUntil
        ? tDetail('nextAction.snoozedToast', { when: new Date(snoozedUntil).toLocaleString() })
        : tDetail('nextAction.snoozeClearedToast'),
    });
  }

  // D4.8 — Active / DFT / Convert Decision Modal replaces the
  // legacy window.confirm flow. The modal embeds a read-only
  // partner verification summary plus an optional evidence-only
  // attach. Convert remains the technical CRM action — the modal
  // does NOT auto-merge partner Active / DFT dates.
  async function onConvertConfirmed(opts: {
    evidence: { partnerSourceId: string; notes?: string } | null;
  }): Promise<void> {
    if (!lead) return;
    setActionPending('convert');
    setConvertError(null);
    setError(null);
    try {
      await leadsApi.convert(lead.id);
      if (opts.evidence) {
        // Best-effort — a failed evidence attach must NOT roll back
        // the conversion (different transactions, different concerns).
        try {
          await partnerVerificationApi.attachEvidence(lead.id, opts.evidence);
          setNotice(tDetail('convertDecision.toastConvertedWithEvidence'));
        } catch (err) {
          setNotice(tDetail('convertDecision.toastConvertedEvidenceFailed'));
          // Surface the evidence error in the existing error band so
          // the operator can see why the attach didn't land.
          setError(err instanceof ApiError ? err.message : String(err));
        }
      } else {
        setNotice(tCommon('saved'));
      }
      setConvertModalOpen(false);
      await reload();
    } catch (err) {
      setConvertError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setActionPending(null);
    }
  }

  // Phase D2 — D2.6: manual reactivation. Capability + closed-state
  // gating happens in the CTA's render guards; here we just call the
  // endpoint and route to the new attempt's detail page on success.
  async function onReactivateConfirm(): Promise<void> {
    if (!lead) return;
    setReactivateSubmitting(true);
    setReactivateError(null);
    try {
      const result = await leadsApi.reactivate(lead.id);
      toast({ tone: 'success', title: tDetail('reactivate.successToast') });
      setReactivateOpen(false);
      router.push(`/admin/leads/${result.id}#attempts`);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'lead.reactivate.already_open') {
          setReactivateError(tDetail('reactivate.errorAlreadyOpen'));
        } else if (err.code === 'auth.forbidden') {
          setReactivateError(tDetail('reactivate.errorForbidden'));
        } else {
          setReactivateError(err.message);
        }
      } else {
        setReactivateError(String(err));
      }
    } finally {
      setReactivateSubmitting(false);
    }
  }

  // Phase D3 — D3.4: manual rotation. Capability gating happens on
  // the CTA's render guard; here we just call the endpoint and
  // refresh the lead detail (the rotation log + history card pull
  // their own data on the next reload).
  async function onRotateConfirm(input: {
    handoverMode: 'full' | 'summary' | 'clean';
    toUserId?: string;
    reasonCode?: string;
    notes?: string;
  }): Promise<void> {
    if (!lead) return;
    setRotateSubmitting(true);
    setRotateError(null);
    try {
      await leadsApi.rotate(lead.id, input);
      toast({ tone: 'success', title: tDetail('rotate.successToast') });
      setRotateOpen(false);
      await reload();
    } catch (err) {
      if (err instanceof ApiError) {
        switch (err.code) {
          case 'lead.rotate.disabled':
            setRotateError(tDetail('rotate.errorDisabled'));
            break;
          case 'lead.rotate.same_owner':
            setRotateError(tDetail('rotate.errorSameOwner'));
            break;
          case 'lead.rotate.invalid_target':
            setRotateError(tDetail('rotate.errorInvalidTarget'));
            break;
          case 'lead.rotate.no_eligible_agent':
            setRotateError(tDetail('rotate.errorNoEligible'));
            break;
          case 'auth.forbidden':
            setRotateError(tDetail('rotate.errorForbidden'));
            break;
          default:
            setRotateError(err.message);
        }
      } else {
        setRotateError(String(err));
      }
    } finally {
      setRotateSubmitting(false);
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
      {/* Top strip: Back link + prev/next navigator. The navigator
          gracefully renders disabled chevrons (no count) when the
          list cache is missing — feature is absent, not broken. */}
      <div className="flex items-center justify-between gap-3">
        <Link
          href="/admin/leads"
          className="inline-flex items-center gap-1 text-xs font-medium text-ink-secondary hover:text-brand-700"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> {t('title')}
        </Link>
        <ListNavigator position={navigatorPos} />
      </div>

      {/* ───── Header card (B1) ─────
          Identity + at-a-glance state in one compact card so the
          page's first 100px tell the agent who they're dealing with
          and where the lead stands. Quick actions sit right below
          and Next Action is the first thing in the right column. */}
      <section className="rounded-lg border border-surface-border bg-surface-card p-5 shadow-card">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-1">
            <h1 className="truncate text-2xl font-semibold leading-tight text-ink-primary">
              {lead.name}
            </h1>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-ink-secondary">
              <FieldGated resource="lead" field="phone">
                <a
                  href={`tel:${lead.phone}`}
                  className="inline-flex items-center gap-1 font-mono text-brand-700 hover:underline"
                >
                  <Phone className="h-3.5 w-3.5" aria-hidden="true" />
                  {lead.phone}
                </a>
              </FieldGated>
              {lead.email ? (
                <FieldGated resource="lead" field="email">
                  <a
                    href={`mailto:${lead.email}`}
                    className="inline-flex items-center gap-1 text-brand-700 hover:underline"
                  >
                    <Mail className="h-3.5 w-3.5" aria-hidden="true" />
                    {lead.email}
                  </a>
                </FieldGated>
              ) : null}
              <span className="inline-flex items-center gap-1">
                <UserCog className="h-3.5 w-3.5 text-ink-tertiary" aria-hidden="true" />
                {assignee ? (
                  <span>
                    <span className="font-medium text-ink-primary">{assignee.name}</span>
                    {assigneeTeam ? (
                      <span className="text-ink-tertiary"> · {assigneeTeam.name}</span>
                    ) : null}
                  </span>
                ) : (
                  <span className="text-ink-tertiary">{tDetail('unassigned')}</span>
                )}
              </span>
              <span className="text-ink-tertiary">
                {tDetail('createdLabel')}: {createdAtRelative}
              </span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <LifecycleBadge state={lead.lifecycleState} />
            <Badge tone={lead.stage.isTerminal ? 'inactive' : 'info'}>{lead.stage.name}</Badge>
            {/* Sprint 1.C — current stage-specific status (formerly
                a render-null placeholder). Renders the active
                status code humanised, or nothing when no status
                is set. Edit surface is the lower picker. */}
            <StageStatusSlot status={lead.currentStageStatus?.status ?? null} />
            <Badge tone={slaTone(lead.slaStatus)}>{lead.slaStatus}</Badge>
            {isConverted ? (
              <Badge tone="healthy">
                <Trophy className="me-1 inline h-3 w-3" aria-hidden="true" />
                {tDetail('captainBadge')}
              </Badge>
            ) : null}
          </div>
        </div>
        {/* Sprint 1.C — Captain Masr lifecycle Journey Bar. Reads
            `lead.stage.lifecycleCategory` (exposed by Sprint 1.B).
            Renders the 4-step journey with the active step in the
            lifecycle palette; when the stage isn't classified yet
            the bar shows the empty-state hint and all steps appear
            neutral. Sits under the badge row inside the header
            card so the journey reads as part of "who this lead
            is" rather than competing with the page chrome. */}
        <div className="mt-4 border-t border-surface-border pt-4">
          <JourneyBar current={lead.stage.lifecycleCategory ?? null} />
        </div>
      </section>

      {/* ───── Quick actions bar (B1: + Follow-up added; Sprint 2.B:
              + Add Action primary CTA) ───── */}
      <QuickActionsBar
        phone={lead.phone}
        currentStageCode={lead.stage.code}
        stages={stages}
        stageMenuOpen={stageMenuOpen}
        setStageMenuOpen={setStageMenuOpen}
        disabled={isConverted}
        actionPending={actionPending}
        onAddAction={() => {
          setAddActionInitialArea(undefined);
          setAddActionInitialStageId(undefined);
          setAddActionOpen(true);
        }}
        onCall={() => focusComposer('call')}
        onAddNote={() => focusComposer('note')}
        onAddFollowUp={() => setFollowUpModalOpen(true)}
        onPickStage={(c) => quickMoveToStage(c)}
        labels={{
          addAction: tDetail('quickActions.addAction'),
          call: tDetail('quickActions.call'),
          addNote: tDetail('quickActions.addNote'),
          addFollowUp: tDetail('quickActions.addFollowUp'),
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

      {/* ───── Sprint 2.A — Hero row: One Primary Next Action +
              Stage Context Panel (status picker). These two surfaces
              are always visible above the tabs so the agent never
              has to switch tabs to see "what's the next thing"
              and "what's the lead's current operational state". */}
      <div className="grid gap-4 md:grid-cols-2">
        <NextActionCard
          next={nextFollowUp}
          now={tickNow}
          busy={actionPending !== null}
          onComplete={onCompleteFollowUp}
          onSnooze={(f) => setSnoozeFor(f)}
          onAdd={() => setFollowUpModalOpen(true)}
        />
        <StageStatusPicker
          leadId={lead.id}
          refreshKey={lead.updatedAt}
          onChanged={() => void reload()}
        />
      </div>

      {/* ───── Sprint 3 — Pending Transition Request card ─────
          Renders null when no pending or recently-rejected request
          exists. Lives above the tabs so the agent / approver
          never has to switch tabs to see what's waiting. */}
      <PendingTransitionRequestCard
        leadId={lead.id}
        refreshKey={lead.updatedAt}
        onChanged={() => void reload()}
      />

      {/* ───── Sprint 4 — Partner Presence compact summary ─────
          Always-visible chip row showing the lead's per-partner
          status across imported sources (Uber EG / inDrive EG /
          DiDi EG / Careem / Yango). Surfaces the one-contact /
          many-partners model at the header level so the agent
          doesn't have to switch to the Partner Presence tab to
          read the headline. */}
      <PartnerPresenceSummary leadId={lead.id} refreshKey={lead.updatedAt} />

      {/* ───── Sprint 2.A — Smart Tabs ───── */}
      <Tabs<LeadDetailTab>
        value={activeTab}
        onChange={setActiveTab}
        ariaLabel={tDetail('tabs.ariaLabel')}
        tabs={
          [
            { id: 'overview', label: tDetail('tabs.overview') },
            { id: 'profile', label: tDetail('tabs.profile') },
            { id: 'partnerPresence', label: tDetail('tabs.partnerPresence') },
            { id: 'documents', label: tDetail('tabs.documents') },
            { id: 'operations', label: tDetail('tabs.operations') },
            { id: 'audit', label: tDetail('tabs.audit') },
          ] as ReadonlyArray<TabDescriptor<LeadDetailTab>>
        }
      />

      {/* ───── Overview tab: activity timeline + supporting context.
              Existing 2-column layout preserved verbatim — only the
              StageStatusPicker + NextActionCard were promoted up to
              the hero row above; everything else stays in the
              right-aside column. ───── */}
      <TabPanel id="overview" active={activeTab === 'overview'}>
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
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

            {/* Activity timeline (B2) — chat-like, merges follow-up
              events into the activity stream. Bucketed by day with
              "Today" / "Yesterday" / dated separators. */}
            <section className="rounded-lg border border-surface-border bg-surface-card p-5 shadow-card">
              <h2 className="mb-4 text-sm font-semibold text-ink-primary">
                {t('activitiesTitle')}
                <span className="ms-2 text-xs font-normal text-ink-tertiary">
                  ({activities.length + followUps.length})
                </span>
              </h2>
              <ActivityTimeline
                activities={activities}
                followUps={followUps}
                now={now}
                locale={locale}
                stageLabel={stageLabel}
                userLabel={userLabel}
                tDetail={tDetail}
                formatRelative={(target) => formatRelative(target, now, locale)}
              />
            </section>
          </div>

          {/* Right: supporting context cards (NextActionCard +
            StageStatusPicker moved up to the hero row in Sprint 2.A). */}
          <aside className="flex flex-col gap-3">
            <LastActivityCard
              activity={lastActivity}
              relativeTime={
                lastActivity ? formatRelative(new Date(lastActivity.createdAt), now, locale) : null
              }
              authorLabel={
                lastActivity
                  ? `${tDetail('activityAuthorBy')} ${
                      lastActivity.createdById !== null
                        ? userLabel(lastActivity.createdById)
                        : tDetail('systemAuthor')
                    }`
                  : ''
              }
              summary={
                lastActivity
                  ? formatActivitySummary(
                      lastActivity,
                      readPayload(lastActivity.payload),
                      stageLabel,
                      userLabel,
                      tDetail,
                    )
                  : null
              }
              label={tDetail('lastActivity.label')}
              emptyLabel={tDetail('lastActivity.empty')}
              typeLabel={(type) => tDetail(`activity.type.${type}`)}
            />

            <SlaCard
              status={lead.slaStatus}
              dueRelative={slaDueRelative}
              label={tDetail('slaLabel')}
              dueLabel={tDetail('slaDue')}
            />

            <AttributionCard
              attribution={lead.attribution ?? null}
              fallbackSource={lead.source}
              label={tDetail('attribution.label')}
              emptyLabel={tDetail('attribution.empty')}
            />

            {/* Phase D2 — D2.5: returning-lead context. Renders nothing
              for first-attempt rows; surfaces the attempt timeline +
              out-of-scope hint for multi-attempt cases. */}
            <AttemptsHistoryCard leadId={lead.id} />

            {/* Phase D3 — D3.4: rotation history. Renders nothing when
              no rotations exist; a sales-agent-shaped role sees a
              single neutral chip ("Handled previously") instead of
              the full from/to chain. */}
            <RotationHistoryCard leadId={lead.id} />

            {/* Phase D4 — D4.4: read-only Partner Data card. The
              component returns `null` for callers without
              `partner.verification.read` (sales agents in D4.4),
              so the section is invisible to them. TLs / Ops /
              Account Manager / Super Admin see the projection. */}
            <PartnerDataCard leadId={lead.id} />

            {/* Phase D4 — D4.8: EvidenceCard. Read-only list of
              `LeadEvidence` rows attached to this lead — surfaces
              what merges / evidence-only attaches happened
              historically. Returns null for callers without
              `partner.verification.read`, so it is invisible to
              sales agents. */}
            <EvidenceCard leadId={lead.id} />

            {/* Captain card — only when converted */}
            {isConverted ? (
              <section className="rounded-lg border border-status-healthy/30 bg-status-healthy/5 p-4 shadow-card">
                <header className="mb-2 flex items-center gap-2">
                  <Trophy className="h-4 w-4 text-status-healthy" aria-hidden="true" />
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-tertiary">
                    {tDetail('captainLabel')}
                  </h3>
                </header>
                <p className="text-sm font-medium text-status-healthy">
                  {lead.captain?.onboardingStatus
                    ? tDetail('captainOnboarding', { status: lead.captain.onboardingStatus })
                    : tDetail('captainBadge')}
                </p>
                <Link
                  href="/admin/captains"
                  className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline"
                >
                  {tDetail('viewCaptain')}
                </Link>
              </section>
            ) : null}

            {/* Lost reason card — only when lost */}
            {lead.lifecycleState === 'lost' && lead.lostReasonId ? (
              <section className="rounded-lg border border-status-breach/30 bg-status-breach/5 p-4 shadow-card">
                <header className="mb-2 flex items-center gap-2">
                  <XCircle className="h-4 w-4 text-status-breach" aria-hidden="true" />
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-tertiary">
                    {tDetail('lostReasonLabel')}
                  </h3>
                </header>
                <p className="text-sm font-medium text-ink-primary">
                  {lostReasonsById.get(lead.lostReasonId)
                    ? locale === 'ar'
                      ? lostReasonsById.get(lead.lostReasonId)!.labelAr
                      : lostReasonsById.get(lead.lostReasonId)!.labelEn
                    : '—'}
                </p>
                {lead.lostNote ? (
                  <p className="mt-1 text-xs text-ink-secondary">{lead.lostNote}</p>
                ) : null}
              </section>
            ) : null}

            {/* Admin actions — assign + convert. Move stage lives in the
              top quick-actions bar; we don't duplicate it here. */}
            <section className="rounded-lg border border-surface-border bg-surface-card p-4 shadow-card">
              <header className="mb-3 flex items-center gap-2">
                <UserCog className="h-4 w-4 text-brand-700" aria-hidden="true" />
                <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-tertiary">
                  {tDetail('adminActions.title')}
                </h3>
              </header>

              <div className="flex flex-col gap-2">
                <Field label={t('assignAction')}>
                  {/* Phase C — C6: edit-mode FieldGated. When the role
                    can't write `assignedToId`, the Select is rendered
                    disabled / readOnly so the agent sees the current
                    value but can't change it. The server (C5) silently
                    no-ops the write either way. */}
                  <FieldGated resource="lead" field="assignedToId" mode="edit">
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
                  </FieldGated>
                </Field>
                <FieldGated resource="lead" field="assignedToId" mode="edit">
                  <Button
                    onClick={() => void onAssign()}
                    loading={actionPending === 'assign'}
                    disabled={isConverted || (assigneeId || '') === (lead.assignedToId ?? '')}
                    size="sm"
                  >
                    {tDetail('saveAssignee')}
                  </Button>
                </FieldGated>
              </div>

              <hr className="my-3 border-surface-border" />

              <div className="flex flex-col gap-2">
                <Button
                  variant="primary"
                  onClick={() => {
                    setConvertError(null);
                    setConvertModalOpen(true);
                  }}
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

                {/* Phase D2 — D2.6: manual reactivation override. Only
                  surfaced when the user holds `lead.reactivate` AND
                  the lead is closed (won / lost / archived). The
                  checkbox-gated modal handles the confirmation. */}
                {hasCapability('lead.reactivate') && lead.lifecycleState !== 'open' ? (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setReactivateError(null);
                      setReactivateOpen(true);
                    }}
                    size="sm"
                  >
                    <Repeat2 className="h-3.5 w-3.5" aria-hidden="true" />
                    {tDetail('reactivate.action')}
                  </Button>
                ) : null}

                {/* Phase D3 — D3.4: rotate CTA. Surfaced only when the
                  user holds `lead.rotate` (TL+ / Ops). Hidden for
                  agents. The modal opens with current owner pre-shown
                  and three handover-mode radio cards. */}
                {hasCapability('lead.rotate') ? (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setRotateError(null);
                      setRotateOpen(true);
                    }}
                    size="sm"
                  >
                    <ArrowRightLeft className="h-3.5 w-3.5" aria-hidden="true" />
                    {tDetail('rotate.action')}
                  </Button>
                ) : null}
              </div>
            </section>
          </aside>
        </div>
      </TabPanel>

      {/* ───── Profile tab ─────
          Sprint 2.A — placeholder shell. Sprint 2.D wires the
          editable fields (contact / location / vehicle / acquisition
          / assignment) with FieldGated for D5 field-level access.
          Backend write path is the existing `PATCH /leads/:id`
          endpoint — no API gap here. */}
      <TabPanel id="profile" active={activeTab === 'profile'}>
        <section className="rounded-lg border border-surface-border bg-surface-card p-5 shadow-card">
          <EmptyState
            title={tDetail('tabs.profilePending.title')}
            body={tDetail('tabs.profilePending.description')}
          />
        </section>
      </TabPanel>

      {/* ───── Partner Presence tab (Sprint 4) ─────
          Detailed per-partner journey table built on the existing
          D4.4 verification projection — one row per partner the
          lead has data for, with partner status / verification
          chip / last sync / warnings. Followed by the Add Partner
          Target placeholder + same-phone hint. Existing
          PartnerDataCard + EvidenceCard render BELOW for the
          merge / evidence detail that the new table doesn't
          duplicate. */}
      <TabPanel id="partnerPresence" active={activeTab === 'partnerPresence'}>
        <div className="flex flex-col gap-3">
          <PartnerPresenceTable leadId={lead.id} refreshKey={lead.updatedAt} />
          <PartnerDataCard leadId={lead.id} />
          <EvidenceCard leadId={lead.id} />
        </div>
      </TabPanel>

      {/* ───── Documents tab ─────
          Sprint 2.A — placeholder shell. Sprint 2.E adds the
          Uploaded / Accepted / Rejected / Missing / Needs
          Resubmission status panels.
          Backend gap: no document upload / accept endpoints exist
          yet (no LeadDocument model in prisma). Sprint 2.E will
          list the exact backend gap and show an empty UI scaffold;
          Sprint 4 / D4 likely adds the model. */}
      <TabPanel id="documents" active={activeTab === 'documents'}>
        <section className="rounded-lg border border-surface-border bg-surface-card p-5 shadow-card">
          <EmptyState
            title={tDetail('tabs.documentsPending.title')}
            body={tDetail('tabs.documentsPending.description')}
          />
        </section>
      </TabPanel>

      {/* ───── Operations tab ─────
          Sprint 2.A — placeholder shell. Sprint 2.D / 2.C move the
          assign / convert / reactivate / rotate admin actions plus
          the SLA / Attempts / Rotation history cards into this
          tab. For now the Operations tab points at the existing
          surfaces (those still render inside Overview's aside). */}
      <TabPanel id="operations" active={activeTab === 'operations'}>
        <section className="rounded-lg border border-surface-border bg-surface-card p-5 shadow-card">
          <EmptyState
            title={tDetail('tabs.operationsPending.title')}
            body={tDetail('tabs.operationsPending.description')}
          />
        </section>
      </TabPanel>

      {/* ───── Audit tab ─────
          Sprint 2.A — link out to the tenant-wide Audit Log page
          pre-filtered by this lead's id. The full embedded audit
          view (with field-permission gates) lands in a future
          sprint; for now we point the operator at the place where
          the same data is already surfaced. */}
      <TabPanel id="audit" active={activeTab === 'audit'}>
        <section className="rounded-lg border border-surface-border bg-surface-card p-5 shadow-card">
          <EmptyState
            title={tDetail('tabs.auditPending.title')}
            body={tDetail('tabs.auditPending.description')}
            action={
              <Link
                href={`/admin/audit?entityId=${encodeURIComponent(lead.id)}`}
                className="inline-flex items-center gap-1 text-sm font-medium text-brand-700 hover:underline"
              >
                {tDetail('tabs.auditOpenFullAudit')}
              </Link>
            }
          />
        </section>
      </TabPanel>

      {/* Sprint 2.B — Add Action drawer. Unified entry for any
          lead update. Internal router screen lets the agent pick
          an intent (Lifecycle / Profile / Documents / Partner /
          Note) before showing the focused panel. */}
      <AddActionDrawer
        open={addActionOpen}
        onClose={() => {
          setAddActionOpen(false);
          setAddActionInitialArea(undefined);
          setAddActionInitialStageId(undefined);
        }}
        lead={lead}
        onApplied={() => void reload()}
        initialArea={addActionInitialArea}
        initialNextStageId={addActionInitialStageId}
      />

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

      {/* Phase B — B1: + Follow-up modal (opens from the quick-actions
          bar and from NextActionCard's CTA). */}
      <FollowUpQuickModal
        open={followUpModalOpen}
        leadName={lead.name}
        onConfirm={onAddFollowUp}
        onClose={() => setFollowUpModalOpen(false)}
      />

      {/* Phase B — B1: snooze the active follow-up from NextActionCard. */}
      <SnoozeModal
        open={snoozeFor !== null}
        leadName={lead.name}
        currentlySnoozed={Boolean(
          snoozeFor?.snoozedUntil && Date.parse(snoozeFor.snoozedUntil) > Date.now(),
        )}
        onConfirm={onSnoozeConfirm}
        onClose={() => setSnoozeFor(null)}
      />

      {/* Phase D2 — D2.6: manual reactivation confirmation. */}
      <ReactivateLeadModal
        open={reactivateOpen}
        leadName={lead.name}
        submitting={reactivateSubmitting}
        error={reactivateError}
        onConfirm={() => void onReactivateConfirm()}
        onClose={() => setReactivateOpen(false)}
      />

      {/* Phase D3 — D3.4: rotate-lead modal. Eligible-users list is
          the active-user roster the page already loads for the
          assignee picker. Capability-gated CTA at render guards the
          parent button; the modal trusts that gate. */}
      <RotateLeadModal
        open={rotateOpen}
        leadName={lead.name}
        currentOwnerName={
          lead.assignedToId ? (userById.get(lead.assignedToId)?.name ?? null) : null
        }
        eligibleUsers={activeUsers.filter((u) => u.id !== lead.assignedToId)}
        submitting={rotateSubmitting}
        error={rotateError}
        onConfirm={(input) => void onRotateConfirm(input)}
        onClose={() => setRotateOpen(false)}
      />

      {/* Phase D4 — D4.8: Active / DFT / Convert Decision Modal.
          Replaces the legacy window.confirm convert flow. Embeds
          a read-only partner verification summary + optional
          evidence-only attach. Convert remains the technical CRM
          action; partner Active / DFT dates are NOT touched here. */}
      <ActiveDftConvertDecisionModal
        open={convertModalOpen}
        leadId={lead.id}
        leadName={lead.name}
        leadPhone={lead.phone}
        converting={actionPending === 'convert'}
        convertError={convertError}
        onConvert={onConvertConfirmed}
        onClose={() => {
          setConvertModalOpen(false);
          setConvertError(null);
        }}
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
  /** Sprint 2.B — opens the unified Add Action drawer. */
  onAddAction: () => void;
  onCall: () => void;
  onAddNote: () => void;
  /** Phase B — B1: opens the FollowUpQuickModal. */
  onAddFollowUp: () => void;
  onPickStage: (code: LeadStageCode) => void;
  labels: {
    addAction: string;
    call: string;
    addNote: string;
    addFollowUp: string;
    moveStage: string;
    terminalHint: string;
  };
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
  onAddAction,
  onCall,
  onAddNote,
  onAddFollowUp,
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
      {/* Sprint 2.B — unified Add Action entry. First button so it
          reads as the primary path for any lead update; the
          existing call / note / follow-up buttons remain as quick
          shortcuts for the high-frequency cases. */}
      <Button variant="primary" size="md" onClick={onAddAction} disabled={disabled}>
        <Plus className="h-4 w-4" aria-hidden="true" />
        {labels.addAction}
      </Button>

      <a
        href={`tel:${phone}`}
        onClick={onCall}
        className="inline-flex h-9 items-center gap-1.5 rounded-md border border-surface-border bg-surface-card px-4 text-sm font-medium text-ink-primary transition-colors hover:border-brand-200 hover:bg-brand-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-1"
      >
        <PhoneCall className="h-4 w-4" aria-hidden="true" />
        {labels.call}
      </a>

      <Button variant="secondary" size="md" onClick={onAddNote}>
        <StickyNote className="h-4 w-4" aria-hidden="true" />
        {labels.addNote}
      </Button>

      <Button variant="secondary" size="md" onClick={onAddFollowUp}>
        <CalendarPlus className="h-4 w-4" aria-hidden="true" />
        {labels.addFollowUp}
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
