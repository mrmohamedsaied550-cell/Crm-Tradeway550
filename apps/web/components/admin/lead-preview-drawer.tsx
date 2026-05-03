'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import {
  ArrowRight,
  ArrowRightLeft,
  CalendarPlus,
  ChevronDown,
  Mail,
  MessageCircle,
  Phone,
  PhoneCall,
  X,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { LifecycleBadge } from '@/components/ui/lifecycle-badge';
import { Notice } from '@/components/ui/notice';
import { useToast } from '@/components/ui/toast';
import { FollowUpQuickModal } from '@/components/admin/follow-up-quick-modal';
import { LostReasonModal, type LostReasonResult } from '@/components/admin/lost-reason-modal';
import { NextActionCard } from '@/components/admin/lead-detail/next-action-card';
import { LastActivityCard } from '@/components/admin/lead-detail/sidebar-cards';
import { SnoozeModal } from '@/components/agent/snooze-modal';
import {
  ApiError,
  followUpsApi,
  leadsApi,
  lostReasonsApi,
  pipelineApi,
  pipelinesApi,
} from '@/lib/api';
import type {
  Lead,
  LeadActivity,
  LeadActivityType,
  LeadFollowUp,
  LeadStageCode,
  LostReason,
  PipelineStage,
  SlaStatus,
} from '@/lib/api-types';
import { cn } from '@/lib/utils';

/**
 * Phase B — Speed: lead preview drawer used by /admin/leads.
 *
 * Single click on a row opens it; double click navigates to the full
 * page. The drawer reuses B1's NextActionCard + LastActivityCard +
 * FollowUpQuickModal + SnoozeModal so behaviour matches the detail
 * page exactly.
 *
 * Performance:
 *   - per-id in-component cache avoids re-fetching when the user
 *     bounces between the same rows in a session,
 *   - the always-visible header (name, phone, badges) renders from
 *     the row data already passed in by the parent — no spinner for
 *     identity,
 *   - the deeper data (next action, last activity) renders behind
 *     a small skeleton until the per-lead fetch lands.
 *
 * Reliability:
 *   - escape closes,
 *   - outside-click on the backdrop closes,
 *   - lead 404 (deleted between list-load and drawer-open) shows a
 *     clear error notice instead of a stuck spinner.
 *
 * No backend changes; reuses leadsApi.get + followUpsApi.listForLead
 * + the existing stage / lost-reason endpoints.
 */

function slaTone(s: SlaStatus): 'healthy' | 'warning' | 'breach' | 'inactive' {
  if (s === 'breached') return 'breach';
  if (s === 'paused') return 'inactive';
  return 'healthy';
}

function whatsappHref(phoneE164: string): string {
  const digits = phoneE164.startsWith('+') ? phoneE164.slice(1) : phoneE164;
  return `https://wa.me/${digits}`;
}

interface LeadPreviewDrawerProps {
  open: boolean;
  /** The lead the drawer should reflect. Null means closed. */
  leadId: string | null;
  /**
   * Optional list-row context — lets the header render name/phone
   * instantly while the per-lead fetch is still in flight.
   */
  rowHint?: Pick<Lead, 'id' | 'name' | 'phone' | 'email'> | null;
  onClose: () => void;
  /**
   * Fired after any drawer-side mutation (move stage, follow-up,
   * etc.) so the parent list can silently reload.
   */
  onChanged?: () => void;
}

export function LeadPreviewDrawer({
  open,
  leadId,
  rowHint,
  onClose,
  onChanged,
}: LeadPreviewDrawerProps): JSX.Element | null {
  const t = useTranslations('admin.leads.detail');
  const tDrawer = useTranslations('admin.leads.drawer');
  const tCommon = useTranslations('admin.common');
  const locale = useLocale();
  const { toast } = useToast();

  // Per-id cache so re-opening the same lead is instant.
  const cacheRef = useRef<
    Map<
      string,
      {
        lead: Lead;
        followUps: LeadFollowUp[];
        activities: LeadActivity[];
        stages: PipelineStage[];
        lostReasons: LostReason[];
      }
    >
  >(new Map());

  const [lead, setLead] = useState<Lead | null>(null);
  const [followUps, setFollowUps] = useState<LeadFollowUp[]>([]);
  const [activities, setActivities] = useState<LeadActivity[]>([]);
  const [stages, setStages] = useState<PipelineStage[]>([]);
  const [lostReasons, setLostReasons] = useState<LostReason[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState<string | null>(null);

  // UI sub-modals.
  const [stageMenuOpen, setStageMenuOpen] = useState<boolean>(false);
  const [followUpModalOpen, setFollowUpModalOpen] = useState<boolean>(false);
  const [snoozeFor, setSnoozeFor] = useState<LeadFollowUp | null>(null);
  const [lostModalOpen, setLostModalOpen] = useState<boolean>(false);
  const [pendingLostStageId, setPendingLostStageId] = useState<string | null>(null);

  const [tickNow, setTickNow] = useState<Date>(() => new Date());
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => setTickNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, [open]);

  const fetchLead = useCallback(async (id: string, force = false): Promise<void> => {
    if (!force) {
      const cached = cacheRef.current.get(id);
      if (cached) {
        setLead(cached.lead);
        setFollowUps(cached.followUps);
        setActivities(cached.activities);
        setStages(cached.stages);
        setLostReasons(cached.lostReasons);
        return;
      }
    }
    setLoading(true);
    setError(null);
    try {
      const [l, fus, acts, lr] = await Promise.all([
        leadsApi.get(id),
        followUpsApi.listForLead(id).catch(() => [] as LeadFollowUp[]),
        leadsApi.listActivities(id).catch(() => [] as LeadActivity[]),
        lostReasonsApi.listActive().catch(() => [] as LostReason[]),
      ]);
      const st = await (
        l.pipelineId ? pipelinesApi.stagesOf(l.pipelineId) : pipelineApi.listStages()
      ).catch(() => [] as PipelineStage[]);
      cacheRef.current.set(id, {
        lead: l,
        followUps: fus,
        activities: acts,
        stages: st,
        lostReasons: lr,
      });
      setLead(l);
      setFollowUps(fus);
      setActivities(acts);
      setStages(st);
      setLostReasons(lr);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch on id change (when open). Reset transient UI state too so
  // sub-modals from a previous lead don't carry over.
  useEffect(() => {
    if (!open || !leadId) return;
    setStageMenuOpen(false);
    setFollowUpModalOpen(false);
    setSnoozeFor(null);
    setLostModalOpen(false);
    setPendingLostStageId(null);
    void fetchLead(leadId);
  }, [open, leadId, fetchLead]);

  // Close on Escape. The parent owns `open` so we just call onClose.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        // Don't close if a sub-modal is intercepting Escape.
        if (followUpModalOpen || snoozeFor || lostModalOpen) return;
        onClose();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, followUpModalOpen, snoozeFor, lostModalOpen]);

  // ─── Derived ───
  const stageByCode = useMemo(() => new Map(stages.map((s) => [s.code, s])), [stages]);
  const lostReasonsById = useMemo(() => new Map(lostReasons.map((r) => [r.id, r])), [lostReasons]);

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

  const lastActivity = useMemo<LeadActivity | null>(() => {
    if (activities.length === 0) return null;
    let best = activities[0]!;
    for (const a of activities) {
      if (new Date(a.createdAt).getTime() > new Date(best.createdAt).getTime()) best = a;
    }
    return best;
  }, [activities]);

  // ─── Mutations ───
  async function performMoveStage(
    targetCode: string,
    lostExtras?: LostReasonResult,
  ): Promise<void> {
    if (!lead) return;
    const target = stageByCode.get(targetCode);
    if (target?.terminalKind === 'lost' && !lostExtras) {
      setPendingLostStageId(target.id);
      setLostModalOpen(true);
      return;
    }
    setActionPending('stage');
    setError(null);
    try {
      await leadsApi.moveStage(lead.id, {
        ...(target ? { pipelineStageId: target.id } : { stageCode: targetCode }),
        ...(lostExtras && {
          lostReasonId: lostExtras.lostReasonId,
          ...(lostExtras.lostNote && { lostNote: lostExtras.lostNote }),
        }),
      });
      // Invalidate cache for this lead so the next render reflects.
      cacheRef.current.delete(lead.id);
      await fetchLead(lead.id, true);
      onChanged?.();
      toast({ tone: 'success', title: tDrawer('stageMoved') });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setActionPending(null);
    }
  }

  async function quickMoveTo(code: LeadStageCode): Promise<void> {
    setStageMenuOpen(false);
    if (!lead || code === lead.stage.code) return;
    await performMoveStage(code);
  }

  async function onLostReasonConfirm(result: LostReasonResult): Promise<void> {
    const stageId = pendingLostStageId;
    if (!stageId) return;
    const target = stages.find((s) => s.id === stageId);
    if (!target) return;
    setLostModalOpen(false);
    setPendingLostStageId(null);
    await performMoveStage(target.code, result);
  }

  async function onAddFollowUp(input: {
    actionType: 'call' | 'whatsapp' | 'visit' | 'other';
    dueAt: string;
    note?: string;
  }): Promise<void> {
    if (!lead) return;
    await followUpsApi.create(lead.id, input);
    setFollowUpModalOpen(false);
    cacheRef.current.delete(lead.id);
    await fetchLead(lead.id, true);
    onChanged?.();
    toast({ tone: 'success', title: t('followUpModal.created') });
  }

  async function onCompleteFollowUp(id: string): Promise<void> {
    if (!lead) return;
    setError(null);
    try {
      await followUpsApi.complete(id);
      cacheRef.current.delete(lead.id);
      await fetchLead(lead.id, true);
      onChanged?.();
      toast({ tone: 'success', title: t('nextAction.completedToast') });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  async function onSnoozeConfirm(snoozedUntil: string | null): Promise<void> {
    if (!snoozeFor || !lead) return;
    await followUpsApi.update(snoozeFor.id, { snoozedUntil });
    setSnoozeFor(null);
    cacheRef.current.delete(lead.id);
    await fetchLead(lead.id, true);
    onChanged?.();
    toast({
      tone: 'success',
      title: snoozedUntil
        ? t('nextAction.snoozedToast', { when: new Date(snoozedUntil).toLocaleString() })
        : t('nextAction.snoozeClearedToast'),
    });
  }

  if (!open) return null;

  // Header data — prefers fetched lead, falls back to row hint so the
  // identity is visible immediately without a spinner.
  const headerName = lead?.name ?? rowHint?.name ?? '—';
  const headerPhone = lead?.phone ?? rowHint?.phone ?? '';
  const headerEmail = lead?.email ?? rowHint?.email ?? null;
  const isConverted = lead ? Boolean(lead.captain) || lead.stage.code === 'converted' : false;
  const fullPageHref = leadId ? `/admin/leads/${leadId}` : '#';
  const stageMenuStages = stages.filter((s) => lead && s.code !== lead.stage.code);

  const formatRelative = (target: Date): string => {
    const diffMs = target.getTime() - tickNow.getTime();
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
  };

  return (
    <>
      {/* Backdrop — dim the rest of the page. Click closes. */}
      <button
        type="button"
        aria-label={tCommon('close')}
        onClick={onClose}
        className="fixed inset-0 z-40 bg-black/20 transition-opacity"
      />

      {/* Drawer — slides in from the trailing edge (RTL-aware). */}
      <aside
        role="dialog"
        aria-modal="false"
        aria-labelledby="lead-drawer-title"
        className={cn(
          'fixed inset-y-0 end-0 z-50 flex w-[420px] max-w-[100vw] flex-col',
          'border-s border-surface-border bg-surface-card shadow-xl',
        )}
      >
        {/* Header: identity + close */}
        <header className="flex items-start justify-between gap-2 border-b border-surface-border px-5 py-4">
          <div className="flex min-w-0 flex-col gap-1">
            <h2 id="lead-drawer-title" className="truncate text-lg font-semibold text-ink-primary">
              {headerName}
            </h2>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-secondary">
              {headerPhone ? (
                <a
                  href={`tel:${headerPhone}`}
                  className="inline-flex items-center gap-1 font-mono text-brand-700 hover:underline"
                >
                  <Phone className="h-3 w-3" aria-hidden="true" />
                  {headerPhone}
                </a>
              ) : null}
              {headerEmail ? (
                <a
                  href={`mailto:${headerEmail}`}
                  className="inline-flex items-center gap-1 text-brand-700 hover:underline"
                >
                  <Mail className="h-3 w-3" aria-hidden="true" />
                  {headerEmail}
                </a>
              ) : null}
            </div>
            {lead ? (
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                <LifecycleBadge state={lead.lifecycleState} />
                <Badge tone={lead.stage.isTerminal ? 'inactive' : 'info'}>{lead.stage.name}</Badge>
                <Badge tone={slaTone(lead.slaStatus)}>{lead.slaStatus}</Badge>
              </div>
            ) : null}
          </div>
          <button
            type="button"
            aria-label={tCommon('close')}
            onClick={onClose}
            className="shrink-0 rounded-md p-1 text-ink-secondary hover:bg-surface hover:text-brand-700"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </header>

        {/* Body — scrolls if content overflows. */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {error ? <Notice tone="error">{error}</Notice> : null}

          {/* Quick actions row — Call (primary) · WhatsApp · + Follow-up · Move stage */}
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <a
              href={headerPhone ? `tel:${headerPhone}` : '#'}
              className="inline-flex h-9 items-center gap-1.5 rounded-md bg-brand-600 px-3 text-sm font-medium text-white hover:bg-brand-700"
            >
              <PhoneCall className="h-4 w-4" aria-hidden="true" />
              {t('quickActions.call')}
            </a>
            <a
              href={headerPhone ? whatsappHref(headerPhone) : '#'}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-9 items-center gap-1.5 rounded-md border border-surface-border bg-surface-card px-3 text-sm font-medium text-ink-primary hover:bg-brand-50"
            >
              <MessageCircle className="h-4 w-4" aria-hidden="true" />
              {tDrawer('whatsapp')}
            </a>
            <Button
              variant="secondary"
              size="md"
              onClick={() => setFollowUpModalOpen(true)}
              disabled={!lead}
            >
              <CalendarPlus className="h-4 w-4" aria-hidden="true" />
              {t('quickActions.addFollowUp')}
            </Button>
            <div className="relative">
              <Button
                variant="secondary"
                size="md"
                onClick={() => setStageMenuOpen((v) => !v)}
                disabled={!lead || isConverted || actionPending === 'stage'}
                loading={actionPending === 'stage'}
              >
                <ArrowRightLeft className="h-4 w-4" aria-hidden="true" />
                {t('quickActions.moveStage')}
                <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
              {stageMenuOpen && stageMenuStages.length > 0 ? (
                <ul
                  role="menu"
                  className="absolute end-0 z-10 mt-1 min-w-[180px] overflow-hidden rounded-md border border-surface-border bg-surface-card py-1 text-sm shadow-card"
                >
                  {stageMenuStages.map((s) => (
                    <li key={s.code}>
                      <button
                        role="menuitem"
                        type="button"
                        onClick={() => void quickMoveTo(s.code as LeadStageCode)}
                        className="flex w-full items-center justify-between gap-3 px-3 py-1.5 text-start text-ink-primary hover:bg-brand-50"
                      >
                        <span>{s.name}</span>
                        {s.terminalKind === 'lost' ? (
                          <span className="text-[10px] uppercase text-status-breach">lost</span>
                        ) : s.terminalKind === 'won' ? (
                          <span className="text-[10px] uppercase text-status-healthy">won</span>
                        ) : null}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </div>

          {/* Loading skeleton for the deeper sections — header + quick
              actions stay visible because they only need the row hint. */}
          {loading && !lead ? (
            <div className="flex flex-col gap-3">
              <div className="h-32 animate-pulse rounded-lg bg-surface-border/40" />
              <div className="h-20 animate-pulse rounded-lg bg-surface-border/40" />
            </div>
          ) : lead ? (
            <div className="flex flex-col gap-3">
              <NextActionCard
                next={nextFollowUp}
                now={tickNow}
                busy={actionPending !== null}
                onComplete={onCompleteFollowUp}
                onSnooze={(f) => setSnoozeFor(f)}
                onAdd={() => setFollowUpModalOpen(true)}
              />

              <LastActivityCard
                activity={lastActivity}
                relativeTime={
                  lastActivity ? formatRelative(new Date(lastActivity.createdAt)) : null
                }
                authorLabel=""
                summary={null}
                label={t('lastActivity.label')}
                emptyLabel={t('lastActivity.empty')}
                typeLabel={(type: LeadActivityType) => t(`activity.type.${type}`)}
              />

              {/* Lost reason mini — when applicable */}
              {lead.lifecycleState === 'lost' && lead.lostReasonId ? (
                <section className="rounded-lg border border-status-breach/30 bg-status-breach/5 p-3 text-sm">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-tertiary">
                    {t('lostReasonLabel')}
                  </p>
                  <p className="mt-1 font-medium text-ink-primary">
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
            </div>
          ) : null}
        </div>

        {/* Footer — Open full page link is always available. */}
        <footer className="flex items-center justify-end border-t border-surface-border px-5 py-3">
          <Link
            href={fullPageHref}
            className="inline-flex items-center gap-1 text-sm font-medium text-brand-700 hover:underline"
          >
            {tDrawer('openFullPage')}
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        </footer>
      </aside>

      {/* Sub-modals — only one can be open at a time in practice, but
          they're independent so we render all three and let internal
          `open` props gate visibility. */}
      <FollowUpQuickModal
        open={followUpModalOpen}
        leadName={lead?.name}
        onConfirm={onAddFollowUp}
        onClose={() => setFollowUpModalOpen(false)}
      />
      <SnoozeModal
        open={snoozeFor !== null}
        leadName={lead?.name}
        currentlySnoozed={Boolean(
          snoozeFor?.snoozedUntil && Date.parse(snoozeFor.snoozedUntil) > Date.now(),
        )}
        onConfirm={onSnoozeConfirm}
        onClose={() => setSnoozeFor(null)}
      />
      <LostReasonModal
        open={lostModalOpen}
        leadName={lead?.name}
        reasons={lostReasons}
        onConfirm={onLostReasonConfirm}
        onClose={() => {
          setLostModalOpen(false);
          setPendingLostStageId(null);
        }}
      />
    </>
  );
}
