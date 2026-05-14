'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import {
  AlertTriangle,
  ArrowRightCircle,
  CalendarPlus,
  CheckCheck,
  ShieldCheck,
  Trophy,
  XCircle,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Field, Select, Textarea } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import { ApiError, followUpsApi, leadsApi, pipelineApi } from '@/lib/api';
import type {
  AllowedStatusEntry,
  Lead,
  PipelineStage,
  StageStatusesResponse,
} from '@/lib/api-types';

/**
 * Sprint 2.C — Lifecycle action panel inside the Add Action drawer.
 *
 * Consumes Sprint 1.A's Smart Status Rule schema:
 *   - Reads the lead's current stage + status + the stage's
 *     `allowedStatuses` catalogue (each entry carries optional
 *     rule metadata: requiresFollowUp, requiresReason,
 *     closeJourney + closeType, autoMoveStage + nextStageCode +
 *     nextStatusCode, convertToCaptain, requiresApproval,
 *     requiredChecks, defaultNextActionTitle,
 *     defaultDueOffsetMinutes, defaultDueTime, reasonGroup).
 *   - Selecting a Next Status surfaces the matching rule as
 *     inline banners + auxiliary form fields (follow-up due-at
 *     when the rule requires it, reason hint when applicable,
 *     close/convert/approval preview when the rule flags it).
 *
 * Sprint discipline:
 *   - Stage MOVE (cross-stage) stays in the existing
 *     QuickActionsBar "Move stage" dropdown. The Lifecycle action
 *     panel focuses on the smart-rule layer for the CURRENT stage
 *     (same-stage status updates + the rule's downstream
 *     automations). When a status' rule sets
 *     `autoMoveStage: true` with a `nextStageCode`, the save
 *     path will move + status in sequence; otherwise stage
 *     transitions across stages route through the existing
 *     Move Stage flow.
 *   - Lost / rejected / not_qualified close (`closeJourney: true`)
 *     and Lead → Captain conversion (`convertToCaptain: true`)
 *     show preview banners but DO NOT execute auto-actions in
 *     2.C — those reuse existing modals (LostReasonModal,
 *     ActiveDftConvertDecisionModal) accessible from the Lead
 *     Detail. Sprint 3 wires the approval engine; until then
 *     `requiresApproval: true` raises a clear banner that says
 *     "approval flow not yet wired — Sprint 3."
 *
 * Permissions:
 *   - Status writes require `lead.stage.status.write` (server-
 *     enforced by leadsApi.setStageStatus).
 *   - Follow-up creation requires `followup.write` (server-
 *     enforced by followUpsApi.create).
 *   - The panel doesn't pre-check capabilities — if the user
 *     opened the drawer, the page already verified `lead.read`;
 *     write failures surface as inline errors with the API's
 *     human message.
 */

/**
 * Communication-method values per Sprint 2 spec. Stored in the
 * activity row notes (for now); a dedicated column may land in a
 * later sprint. Backend gap: there's no `communicationMethod`
 * field on activities or stage statuses yet — we prepend the
 * method to the notes string as `[via Call] ...` so it shows up
 * in the timeline.
 */
const COMMUNICATION_METHODS = [
  'call',
  'whatsapp',
  'sms',
  'manual',
  'partner_sheet',
  'system',
] as const;
type CommunicationMethod = (typeof COMMUNICATION_METHODS)[number];

interface LifecycleActionPanelProps {
  lead: Lead;
  onApplied: () => void;
  onClose: () => void;
}

export function LifecycleActionPanel({
  lead,
  onApplied,
  onClose,
}: LifecycleActionPanelProps): JSX.Element {
  const t = useTranslations('admin.leads.detail.addAction.areas.lifecycle');
  const tCommon = useTranslations('admin.common');
  const locale = useLocale();

  // ─────── Live data ───────
  // `current` = the lead's existing stage + recorded status + this
  // stage's allowedStatuses (D3.3 endpoint, scope-checked).
  // `stages` = the full pipeline catalogue (Sprint 2.1 — each stage
  // now carries its own `allowedStatuses` + `lifecycleCategory` so
  // cross-stage Next Status options resolve without an extra
  // round-trip).
  const [current, setCurrent] = useState<StageStatusesResponse | null>(null);
  const [stages, setStages] = useState<PipelineStage[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // ─────── Form state ───────
  // `nextStageId` defaults to the lead's current stage so opening
  // the drawer + picking only a status is a same-stage update. If
  // the agent picks a different stage, the save path moves the
  // lead first, then writes the status (if any) against the new
  // stage.
  const [nextStageId, setNextStageId] = useState<string>('');
  const [nextStatusCode, setNextStatusCode] = useState<string>('');
  const [communicationMethod, setCommunicationMethod] = useState<CommunicationMethod>('call');
  const [notes, setNotes] = useState<string>('');
  /** ISO 8601 local datetime (input type=datetime-local format). */
  const [followUpDueAt, setFollowUpDueAt] = useState<string>('');
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // ─────── Fetch ───────
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    Promise.all([leadsApi.getStageStatuses(lead.id), pipelineApi.listStages()])
      .then(([currentResp, stagesResp]) => {
        if (cancelled) return;
        setCurrent(currentResp);
        setStages(stagesResp);
        // Default Next Stage = current stage so the panel opens on
        // "same-stage status update".
        setNextStageId(currentResp.stage.id);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(err instanceof ApiError ? err.message : String(err));
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [lead.id]);

  // ─────── Reset status when stage changes ───────
  // Picking a different Next Stage clears the status pick because
  // the previously-selected code may not exist in the new stage's
  // catalogue.
  useEffect(() => {
    setNextStatusCode('');
  }, [nextStageId]);

  // ─────── Derived: the picked Next Stage row + its catalogue ───────
  const nextStage: PipelineStage | null = useMemo(
    () => stages.find((s) => s.id === nextStageId) ?? null,
    [stages, nextStageId],
  );

  const isCrossStage = useMemo(
    () => current !== null && nextStage !== null && nextStage.id !== current.stage.id,
    [current, nextStage],
  );

  /** Allowed statuses available for the picked Next Stage. */
  const nextStageAllowedStatuses: readonly AllowedStatusEntry[] = useMemo(() => {
    if (!current || !nextStage) return [];
    // When the agent stays on the current stage, prefer the D3.3
    // response — it has the same data but came through the
    // lead-scoped endpoint (so any field-level redaction still
    // applies). For cross-stage selections we read off the
    // catalogue endpoint added in Sprint 2.1.
    if (nextStage.id === current.stage.id) {
      return current.allowedStatuses;
    }
    return nextStage.allowedStatuses ?? [];
  }, [current, nextStage]);

  // ─────── Resolve the smart rule for the picked next status ───────
  const selectedRule: AllowedStatusEntry | null = useMemo(() => {
    if (!nextStatusCode) return null;
    return nextStageAllowedStatuses.find((s) => s.code === nextStatusCode) ?? null;
  }, [nextStageAllowedStatuses, nextStatusCode]);

  // ─────── Seed follow-up default-due when rule asks for one ───────
  useEffect(() => {
    if (!selectedRule?.requiresFollowUp) {
      setFollowUpDueAt('');
      return;
    }
    // Default: now + defaultDueOffsetMinutes (or 60 if unset).
    const offsetMinutes = selectedRule.defaultDueOffsetMinutes ?? 60;
    const due = new Date(Date.now() + offsetMinutes * 60 * 1000);
    // Apply defaultDueTime clock pin if set (HH:MM).
    if (selectedRule.defaultDueTime) {
      const [hh, mm] = selectedRule.defaultDueTime.split(':').map((n) => Number.parseInt(n, 10));
      if (Number.isFinite(hh) && Number.isFinite(mm)) {
        due.setHours(hh!, mm!, 0, 0);
      }
    }
    // datetime-local needs a YYYY-MM-DDTHH:MM string with no Z.
    const pad = (n: number) => String(n).padStart(2, '0');
    setFollowUpDueAt(
      `${due.getFullYear()}-${pad(due.getMonth() + 1)}-${pad(due.getDate())}T${pad(due.getHours())}:${pad(due.getMinutes())}`,
    );
  }, [selectedRule]);

  // ─────── Helpers ───────
  const labelFor = useCallback(
    (entry: AllowedStatusEntry): string => {
      return locale === 'ar' && entry.labelAr ? entry.labelAr : entry.label;
    },
    [locale],
  );

  const currentStatusLabel: string = useMemo(() => {
    if (!current?.currentStatus) return '';
    const match = current.allowedStatuses.find((s) => s.code === current.currentStatus!.status);
    return match ? labelFor(match) : current.currentStatus.status;
  }, [current, labelFor]);

  // ─────── Save ───────
  // Sprint 2.1 — cross-stage flow:
  //   1. If the picked Next Stage differs from the lead's current
  //      stage, call `leadsApi.moveStage` first. The server-side
  //      contract is unchanged — RBAC, lifecycle reclassification,
  //      activity emission, SLA reset all run as before.
  //   2. If a Next Status was picked, write it AFTER the move so
  //      the status row attaches to the new current stage (the
  //      server stamps the lead's currentStageStatusId post-move).
  //   3. If the rule asks for a follow-up, create it last so a
  //      failed earlier step doesn't leave an orphan follow-up.
  // A picked status is optional in cross-stage mode (some agents
  // just want to move the stage); same-stage mode still requires
  // a status pick (without one, there's nothing to save).
  const submit = useCallback(async () => {
    if (!current || !nextStage) return;
    if (!isCrossStage && !nextStatusCode) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      // 1. Cross-stage move (when needed).
      if (isCrossStage) {
        // Server-side lost-stage handling requires a lostReasonId.
        // That capture lives in the existing LostReasonModal (a
        // Sprint 3 unification); for now, block with a clear
        // message and route the agent to the existing surface.
        if (nextStage.terminalKind === 'lost') {
          setSubmitError(t('lostStageBlocker'));
          setSubmitting(false);
          return;
        }
        await leadsApi.moveStage(lead.id, { pipelineStageId: nextStage.id });
      }

      // 2. Status write (optional in cross-stage mode).
      if (nextStatusCode) {
        // Compose the notes string with the communication-method
        // prefix so the activity timeline shows how the agent
        // reached the captain. Backend gap: no dedicated column
        // for communication method yet — flagged for a later
        // sprint.
        const methodTag = `[via ${communicationMethod}]`;
        const composedNotes = notes.trim().length > 0 ? `${methodTag} ${notes.trim()}` : methodTag;
        await leadsApi.setStageStatus(lead.id, {
          status: nextStatusCode,
          notes: composedNotes,
        });

        // 3. Optional follow-up auto-creation when the rule asks for it.
        if (selectedRule?.requiresFollowUp && followUpDueAt) {
          const dueLocal = new Date(followUpDueAt);
          if (!Number.isNaN(dueLocal.getTime())) {
            await followUpsApi.create(lead.id, {
              actionType: mapCommunicationToActionType(communicationMethod),
              dueAt: dueLocal.toISOString(),
              note:
                selectedRule.defaultNextActionTitle ??
                composedNotes.replace(`${methodTag} `, '') ??
                '',
            });
          }
        }
      }

      onApplied();
      onClose();
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }, [
    current,
    nextStage,
    isCrossStage,
    nextStatusCode,
    selectedRule,
    notes,
    communicationMethod,
    followUpDueAt,
    lead.id,
    onApplied,
    onClose,
    t,
  ]);

  // ─────── Loading / empty / error states ───────
  if (loading) {
    return <p className="text-sm text-ink-secondary">{tCommon('loading')}</p>;
  }
  if (loadError) {
    return <Notice tone="error">{loadError}</Notice>;
  }
  if (!current) {
    return <Notice tone="info">{t('noData')}</Notice>;
  }

  // Disable the save button when the form is in an unsubmittable
  // state: same-stage with no status picked (nothing to save) or
  // cross-stage to a stage with no catalogue when no status was
  // chosen (the move itself is still saveable — that's allowed).
  const saveDisabled = submitting || !nextStage || (!isCrossStage && nextStatusCode.length === 0);

  return (
    <div className="flex flex-col gap-4">
      {/* ───── Current state read-out ───── */}
      <section className="rounded-lg border border-surface-border bg-surface-card p-3">
        <p className="text-xs uppercase tracking-wide text-ink-tertiary">{t('currentLabel')}</p>
        <p className="mt-1 text-sm">
          <span className="font-medium text-ink-primary">{current.stage.name}</span>
          {currentStatusLabel ? (
            <>
              <span className="mx-2 text-ink-tertiary">·</span>
              <span className="text-ink-secondary">{currentStatusLabel}</span>
            </>
          ) : (
            <>
              <span className="mx-2 text-ink-tertiary">·</span>
              <span className="italic text-ink-tertiary">{t('noStatusYet')}</span>
            </>
          )}
        </p>
      </section>

      {/* ───── Next Stage picker (Sprint 2.1) ─────
          Lists every stage in the lead's pipeline (ordered).
          Defaults to the current stage so opening the drawer +
          picking only a status is a same-stage update; choosing
          a different stage promotes the save to a cross-stage
          move + (optional) status write. */}
      <Field label={t('nextStageLabel')}>
        <Select
          value={nextStageId}
          onChange={(e) => setNextStageId(e.target.value)}
          disabled={submitting}
        >
          {stages.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
              {s.id === current.stage.id ? ` (${t('sameStageHint')})` : ''}
            </option>
          ))}
        </Select>
      </Field>

      {/* ───── Cross-stage transition preview ───── */}
      {isCrossStage && nextStage ? (
        <Notice tone="info">
          <p className="text-sm font-medium">{t('transitionPreviewTitle')}</p>
          <p className="mt-1 text-xs text-ink-secondary">
            {t('transitionPreviewBody', {
              from: current.stage.name,
              to: nextStage.name,
            })}
          </p>
          {nextStage.terminalKind === 'lost' ? (
            <p className="mt-2 text-xs font-medium text-status-breach">{t('lostStageBlocker')}</p>
          ) : null}
        </Notice>
      ) : null}

      {/* ───── Next Status picker ─────
          Driven by the SELECTED stage's allowedStatuses, not the
          lead's current one. Empty-state hint replaces the picker
          when the chosen stage has nothing configured. */}
      {nextStageAllowedStatuses.length > 0 ? (
        <Field label={t('nextStatusLabel')}>
          <Select
            value={nextStatusCode}
            onChange={(e) => setNextStatusCode(e.target.value)}
            disabled={submitting}
          >
            <option value="">
              {isCrossStage ? t('nextStatusOptionalPlaceholder') : t('nextStatusPlaceholder')}
            </option>
            {nextStageAllowedStatuses.map((s) => (
              <option key={s.code} value={s.code}>
                {labelFor(s)}
              </option>
            ))}
          </Select>
        </Field>
      ) : (
        <Notice tone="info">
          <p className="text-sm font-medium">{t('noStatusesTitle')}</p>
          <p className="mt-1 text-xs text-ink-secondary">{t('noStatusesDescription')}</p>
        </Notice>
      )}

      {/* ───── Communication method ───── */}
      <Field label={t('communicationLabel')}>
        <Select
          value={communicationMethod}
          onChange={(e) => setCommunicationMethod(e.target.value as CommunicationMethod)}
          disabled={submitting}
        >
          {COMMUNICATION_METHODS.map((m) => (
            <option key={m} value={m}>
              {t(`communication.${m}`)}
            </option>
          ))}
        </Select>
      </Field>

      {/* ───── Smart-rule banners + auxiliary fields ───── */}
      {selectedRule ? (
        <RuleBanners
          rule={selectedRule}
          followUpDueAt={followUpDueAt}
          onFollowUpDueAtChange={setFollowUpDueAt}
          submitting={submitting}
        />
      ) : null}

      {/* ───── Notes ───── */}
      <Field label={t('notesLabel')}>
        <Textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          maxLength={1000}
          placeholder={t('notesPlaceholder')}
          disabled={submitting}
        />
      </Field>

      {submitError ? <Notice tone="error">{submitError}</Notice> : null}

      {/* ───── Action buttons ───── */}
      <div className="flex items-center justify-end gap-2">
        <Button variant="secondary" onClick={onClose} disabled={submitting}>
          {tCommon('cancel')}
        </Button>
        <Button onClick={() => void submit()} loading={submitting} disabled={saveDisabled}>
          {isCrossStage && nextStatusCode.length === 0 ? t('submitMoveOnly') : t('submit')}
        </Button>
      </div>
    </div>
  );
}

/**
 * Maps the communication method picked by the agent to the
 * `FollowUpActionType` the follow-up engine accepts. Methods that
 * don't map cleanly (manual / partner_sheet / system) fall back
 * to "other" — captures intent without inventing a new value
 * the backend doesn't recognise.
 */
function mapCommunicationToActionType(
  method: CommunicationMethod,
): 'call' | 'whatsapp' | 'visit' | 'other' {
  switch (method) {
    case 'call':
      return 'call';
    case 'whatsapp':
      return 'whatsapp';
    case 'manual':
      return 'visit';
    default:
      return 'other';
  }
}

/**
 * Renders the inline banners + supplementary fields that surface
 * when a status' Smart Status Rule flags fire. Kept inline (not a
 * separate component file) because the panel is the only caller
 * and the banners are tightly coupled to the panel's form state.
 */
function RuleBanners({
  rule,
  followUpDueAt,
  onFollowUpDueAtChange,
  submitting,
}: {
  rule: AllowedStatusEntry;
  followUpDueAt: string;
  onFollowUpDueAtChange: (v: string) => void;
  submitting: boolean;
}): JSX.Element | null {
  const t = useTranslations('admin.leads.detail.addAction.areas.lifecycle.rules');

  const banners: React.ReactNode[] = [];

  if (rule.requiresFollowUp) {
    banners.push(
      <Notice key="followup" tone="info">
        <div className="flex flex-col gap-2">
          <p className="flex items-center gap-1 text-sm font-medium">
            <CalendarPlus className="h-4 w-4" aria-hidden="true" />
            {t('requiresFollowUp.title')}
          </p>
          {rule.defaultNextActionTitle ? (
            <p className="text-xs text-ink-secondary">
              {t('requiresFollowUp.suggested', { title: rule.defaultNextActionTitle })}
            </p>
          ) : null}
          <Field label={t('requiresFollowUp.dueAtLabel')}>
            <input
              type="datetime-local"
              value={followUpDueAt}
              onChange={(e) => onFollowUpDueAtChange(e.target.value)}
              disabled={submitting}
              className="h-9 w-full rounded-md border border-surface-border bg-surface-card px-3 text-sm text-ink-primary focus-visible:border-brand-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-200"
            />
          </Field>
        </div>
      </Notice>,
    );
  }

  if (rule.requiresReason) {
    banners.push(
      <Notice key="reason" tone="info">
        <p className="flex items-center gap-1 text-sm font-medium">
          <AlertTriangle className="h-4 w-4" aria-hidden="true" />
          {t('requiresReason.title')}
        </p>
        <p className="mt-1 text-xs text-ink-secondary">
          {rule.reasonGroup
            ? t('requiresReason.descriptionWithGroup', { group: rule.reasonGroup })
            : t('requiresReason.description')}
        </p>
      </Notice>,
    );
  }

  if (rule.closeJourney) {
    banners.push(
      <Notice key="close" tone="error">
        <p className="flex items-center gap-1 text-sm font-medium">
          <XCircle className="h-4 w-4" aria-hidden="true" />
          {t(`closeJourney.${rule.closeType ?? 'lost'}.title`)}
        </p>
        <p className="mt-1 text-xs text-ink-secondary">
          {t(`closeJourney.${rule.closeType ?? 'lost'}.description`)}
        </p>
      </Notice>,
    );
  }

  if (rule.convertToCaptain) {
    banners.push(
      <Notice key="convert" tone="success">
        <p className="flex items-center gap-1 text-sm font-medium">
          <Trophy className="h-4 w-4" aria-hidden="true" />
          {t('convertToCaptain.title')}
        </p>
        <p className="mt-1 text-xs text-ink-secondary">{t('convertToCaptain.description')}</p>
      </Notice>,
    );
  }

  if (rule.requiresApproval) {
    banners.push(
      <Notice key="approval" tone="info">
        <p className="flex items-center gap-1 text-sm font-medium">
          <ShieldCheck className="h-4 w-4" aria-hidden="true" />
          {t('requiresApproval.title')}
        </p>
        <p className="mt-1 text-xs text-ink-secondary">{t('requiresApproval.description')}</p>
      </Notice>,
    );
  }

  if (rule.autoMoveStage && rule.nextStageCode) {
    banners.push(
      <Notice key="automove" tone="info">
        <p className="flex items-center gap-1 text-sm font-medium">
          <ArrowRightCircle className="h-4 w-4" aria-hidden="true" />
          {t('autoMoveStage.title')}
        </p>
        <p className="mt-1 text-xs text-ink-secondary">
          {t('autoMoveStage.description', { next: rule.nextStageCode })}
        </p>
      </Notice>,
    );
  }

  if (rule.requiredChecks && rule.requiredChecks.length > 0) {
    banners.push(
      <Notice key="checks" tone="info">
        <p className="flex items-center gap-1 text-sm font-medium">
          <CheckCheck className="h-4 w-4" aria-hidden="true" />
          {t('requiredChecks.title')}
        </p>
        <ul className="mt-1 list-disc ps-4 text-xs text-ink-secondary">
          {rule.requiredChecks.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      </Notice>,
    );
  }

  if (banners.length === 0) return null;
  return <div className="flex flex-col gap-2">{banners}</div>;
}
