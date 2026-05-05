'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, RotateCcw, Save } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Notice } from '@/components/ui/notice';
import { useToast } from '@/components/ui/toast';
import { ApiError, lostReasonsApi, tenantSettingsApi } from '@/lib/api';
import type { DuplicateRulesConfig, DuplicateRulesPatch, OwnershipOnReactivation } from '@/lib/api';
import type { LostReason } from '@/lib/api-types';
import { hasCapability } from '@/lib/auth';
import { cn } from '@/lib/utils';

/**
 * Phase D2 — D2.4: tenant Duplicate Rules admin panel.
 *
 * Operational decision screen — NOT a JSON editor. Four sections:
 *   1. Reactivation Timing  — cool-off days for Lost / No Answer
 *   2. Review Policies      — Active captain + Won lead behaviors
 *   3. Ownership Rules      — radio cards for the three strategies
 *   4. Matching Scope       — cross-pipeline toggle with warning
 *
 * Read-only mode when the actor lacks `tenant.duplicate_rules.write`.
 * No-access mode when they lack `tenant.settings.read`.
 *
 * Every helper string is operationally written (not literal). Save
 * opens a confirmation modal that reminds the operator the rules
 * affect every create path.
 */

const LOCKED_DEFAULTS: DuplicateRulesConfig = {
  reactivateLostAfterDays: 30,
  reactivateNoAnswerAfterDays: 7,
  reactivateNoAnswerLostReasonCodes: ['no_answer', 'no_response'],
  captainBehavior: 'always_review',
  wonBehavior: 'always_review',
  ownershipOnReactivation: 'route_engine',
  crossPipelineMatch: false,
};

export function DuplicateRulesPanel(): JSX.Element {
  const t = useTranslations('admin.duplicateRules');
  const tCommon = useTranslations('admin.common');
  const { toast } = useToast();

  const canRead = hasCapability('tenant.settings.read');
  const canWrite = hasCapability('tenant.duplicate_rules.write');

  const [persisted, setPersisted] = useState<DuplicateRulesConfig | null>(null);
  const [draft, setDraft] = useState<DuplicateRulesConfig | null>(null);
  // Phase D3 — D3.7: surface the active lost-reason catalogue so
  // operators can pick which reasons count as "no answer" for
  // faster reactivation. Falls back gracefully when the listAll
  // endpoint is denied (read-only / partial-permission users see
  // the codes as plain chips with no friendly labels).
  const [lostReasons, setLostReasons] = useState<LostReason[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState<boolean>(false);
  const [resetOpen, setResetOpen] = useState<boolean>(false);

  useEffect(() => {
    if (!canRead) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    Promise.all([
      tenantSettingsApi.getDuplicateRules(),
      // Best-effort: a TL with read-only access may lack the admin
      // lost-reasons endpoint. Fall back to the agent-visible active
      // list when that happens; the chip editor still works because
      // it only needs codes + labels.
      lostReasonsApi
        .listAll()
        .catch(() => lostReasonsApi.listActive().catch(() => [] as LostReason[])),
    ])
      .then(([row, reasons]) => {
        if (cancelled) return;
        setPersisted(row);
        setDraft(row);
        setLostReasons(reasons);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : t('loadFailed'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [canRead, t]);

  const isDirty = useMemo(() => {
    if (!persisted || !draft) return false;
    return (
      persisted.reactivateLostAfterDays !== draft.reactivateLostAfterDays ||
      persisted.reactivateNoAnswerAfterDays !== draft.reactivateNoAnswerAfterDays ||
      persisted.ownershipOnReactivation !== draft.ownershipOnReactivation ||
      persisted.crossPipelineMatch !== draft.crossPipelineMatch ||
      persisted.captainBehavior !== draft.captainBehavior ||
      persisted.wonBehavior !== draft.wonBehavior ||
      JSON.stringify(persisted.reactivateNoAnswerLostReasonCodes) !==
        JSON.stringify(draft.reactivateNoAnswerLostReasonCodes)
    );
  }, [persisted, draft]);

  function setField<K extends keyof DuplicateRulesConfig>(
    key: K,
    value: DuplicateRulesConfig[K],
  ): void {
    setDraft((d) => (d ? { ...d, [key]: value } : d));
  }

  async function persist(patch: DuplicateRulesPatch): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      const updated = await tenantSettingsApi.updateDuplicateRules(patch);
      setPersisted(updated);
      setDraft(updated);
      toast({ tone: 'success', title: t('saved') });
      setConfirmOpen(false);
      setResetOpen(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  async function onConfirmSave(): Promise<void> {
    if (!draft) return;
    // Send the full draft so the backend audit captures the operator's
    // intent for every field, not just the changed ones — the backend
    // computes the diff itself for the audit row.
    await persist({
      reactivateLostAfterDays: draft.reactivateLostAfterDays,
      reactivateNoAnswerAfterDays: draft.reactivateNoAnswerAfterDays,
      reactivateNoAnswerLostReasonCodes: draft.reactivateNoAnswerLostReasonCodes,
      captainBehavior: draft.captainBehavior,
      wonBehavior: draft.wonBehavior,
      ownershipOnReactivation: draft.ownershipOnReactivation,
      crossPipelineMatch: draft.crossPipelineMatch,
    });
  }

  async function onConfirmReset(): Promise<void> {
    await persist({
      reactivateLostAfterDays: LOCKED_DEFAULTS.reactivateLostAfterDays,
      reactivateNoAnswerAfterDays: LOCKED_DEFAULTS.reactivateNoAnswerAfterDays,
      reactivateNoAnswerLostReasonCodes: [...LOCKED_DEFAULTS.reactivateNoAnswerLostReasonCodes],
      captainBehavior: LOCKED_DEFAULTS.captainBehavior,
      wonBehavior: LOCKED_DEFAULTS.wonBehavior,
      ownershipOnReactivation: LOCKED_DEFAULTS.ownershipOnReactivation,
      crossPipelineMatch: LOCKED_DEFAULTS.crossPipelineMatch,
    });
  }

  if (!canRead) {
    return (
      <section className="flex max-w-3xl flex-col gap-3 rounded-lg border border-surface-border bg-surface-card p-4 shadow-card">
        <h2 className="text-base font-semibold text-ink-primary">{t('title')}</h2>
        <Notice tone="error">{t('noAccess')}</Notice>
      </section>
    );
  }

  if (loading || !draft) {
    return (
      <section className="flex max-w-3xl flex-col gap-3 rounded-lg border border-surface-border bg-surface-card p-4 shadow-card">
        <h2 className="text-base font-semibold text-ink-primary">{t('title')}</h2>
        <p className="text-sm text-ink-secondary">{tCommon('loading')}</p>
      </section>
    );
  }

  return (
    <section className="flex max-w-3xl flex-col gap-4 rounded-lg border border-surface-border bg-surface-card p-4 shadow-card">
      <header className="flex flex-col gap-1">
        <h2 className="text-base font-semibold text-ink-primary">{t('title')}</h2>
        <p className="text-sm text-ink-secondary">{t('subtitle')}</p>
      </header>

      {error ? <Notice tone="error">{error}</Notice> : null}
      {!canWrite ? <Notice tone="info">{t('readOnlyBanner')}</Notice> : null}

      {/* ─── 1. Reactivation Timing ─────────────────────────────── */}
      <fieldset className="flex flex-col gap-3 rounded-md border border-surface-border bg-surface p-3">
        <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-ink-tertiary">
          {t('sections.timing')}
        </legend>

        <Field label={t('lostDays.label')} hint={t('lostDays.helper')}>
          <Input
            type="number"
            min={0}
            max={3650}
            value={String(draft.reactivateLostAfterDays)}
            onChange={(e) =>
              setField('reactivateLostAfterDays', Number.parseInt(e.target.value, 10) || 0)
            }
            disabled={!canWrite}
            className="max-w-[140px]"
          />
        </Field>

        <Field label={t('noAnswerDays.label')} hint={t('noAnswerDays.helper')}>
          <Input
            type="number"
            min={0}
            max={3650}
            value={String(draft.reactivateNoAnswerAfterDays)}
            onChange={(e) =>
              setField('reactivateNoAnswerAfterDays', Number.parseInt(e.target.value, 10) || 0)
            }
            disabled={!canWrite}
            className="max-w-[140px]"
          />
        </Field>

        {/* Phase D3 — D3.7: lost-reason chips that should be treated
            as No-Answer-equivalent for faster reactivation. The
            saved value already round-trips on the API; this surface
            simply makes it editable. Falls back to the persisted
            codes when the lost-reason catalogue can't be fetched. */}
        <Field label={t('noAnswerCodes.label')} hint={t('noAnswerCodes.helper')}>
          <div className="flex flex-wrap items-center gap-2">
            {(lostReasons.length > 0
              ? lostReasons
              : draft.reactivateNoAnswerLostReasonCodes.map(
                  (code) =>
                    ({
                      id: code,
                      code,
                      labelEn: code,
                      labelAr: code,
                      isActive: true,
                    }) as Pick<LostReason, 'id' | 'code' | 'labelEn' | 'labelAr' | 'isActive'>,
                )
            ).map((reason) => {
              const selected = draft.reactivateNoAnswerLostReasonCodes.includes(reason.code);
              return (
                <button
                  key={reason.id ?? reason.code}
                  type="button"
                  onClick={() => {
                    if (!canWrite) return;
                    const codes = new Set(draft.reactivateNoAnswerLostReasonCodes);
                    if (selected) {
                      codes.delete(reason.code);
                    } else {
                      codes.add(reason.code);
                    }
                    setField('reactivateNoAnswerLostReasonCodes', Array.from(codes));
                  }}
                  disabled={!canWrite}
                  aria-pressed={selected}
                  className={cn(
                    'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                    selected
                      ? 'border-brand-600 bg-brand-50 text-brand-700'
                      : 'border-surface-border bg-surface-card text-ink-secondary hover:bg-brand-50/30',
                    !canWrite && 'cursor-not-allowed opacity-70',
                  )}
                  title={reason.code}
                >
                  {reason.labelEn || reason.code}
                </button>
              );
            })}
            {lostReasons.length === 0 && draft.reactivateNoAnswerLostReasonCodes.length === 0 ? (
              <span className="text-xs italic text-ink-tertiary">{t('noAnswerCodes.empty')}</span>
            ) : null}
          </div>
        </Field>
      </fieldset>

      {/* ─── 2. Review Policies ─────────────────────────────────── */}
      <fieldset className="flex flex-col gap-3 rounded-md border border-surface-border bg-surface p-3">
        <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-ink-tertiary">
          {t('sections.review')}
        </legend>

        <div className="flex flex-col gap-1 rounded-md border border-status-warning/40 bg-status-warning/5 px-3 py-2">
          <p className="text-sm font-medium text-ink-primary">{t('captain.label')}</p>
          <p className="text-xs text-ink-secondary">{t('captain.helper')}</p>
          <p className="text-[11px] italic text-ink-tertiary">{t('captain.lockedHint')}</p>
        </div>

        <div className="flex flex-col gap-1 rounded-md border border-status-warning/40 bg-status-warning/5 px-3 py-2">
          <p className="text-sm font-medium text-ink-primary">{t('won.label')}</p>
          <p className="text-xs text-ink-secondary">{t('won.helper')}</p>
          <p className="text-[11px] italic text-ink-tertiary">{t('won.lockedHint')}</p>
        </div>
      </fieldset>

      {/* ─── 3. Ownership Rules ─────────────────────────────────── */}
      <fieldset className="flex flex-col gap-2 rounded-md border border-surface-border bg-surface p-3">
        <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-ink-tertiary">
          {t('sections.ownership')}
        </legend>
        <p className="text-xs text-ink-secondary">{t('ownership.intro')}</p>
        <div role="radiogroup" aria-label={t('sections.ownership')} className="flex flex-col gap-2">
          {(['route_engine', 'previous_owner', 'unassigned'] as OwnershipOnReactivation[]).map(
            (opt) => (
              <button
                key={opt}
                type="button"
                role="radio"
                aria-checked={draft.ownershipOnReactivation === opt}
                onClick={() => canWrite && setField('ownershipOnReactivation', opt)}
                disabled={!canWrite}
                className={cn(
                  'flex flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-start transition-colors',
                  draft.ownershipOnReactivation === opt
                    ? 'border-brand-600 bg-brand-50/60'
                    : 'border-surface-border hover:bg-brand-50/30',
                  !canWrite && 'cursor-not-allowed opacity-70',
                )}
              >
                <span className="text-sm font-medium text-ink-primary">
                  {t(`ownership.options.${opt}.label` as 'ownership.options.route_engine.label')}
                </span>
                <span className="text-xs text-ink-tertiary">
                  {t(`ownership.options.${opt}.helper` as 'ownership.options.route_engine.helper')}
                </span>
              </button>
            ),
          )}
        </div>
      </fieldset>

      {/* ─── 4. Matching Scope ──────────────────────────────────── */}
      <fieldset className="flex flex-col gap-2 rounded-md border border-surface-border bg-surface p-3">
        <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-ink-tertiary">
          {t('sections.scope')}
        </legend>
        <label className="flex items-start gap-3 text-sm text-ink-primary">
          <input
            type="checkbox"
            className="mt-1 h-4 w-4 rounded border-surface-border text-brand-600 focus:ring-brand-600"
            checked={draft.crossPipelineMatch}
            onChange={(e) => setField('crossPipelineMatch', e.target.checked)}
            disabled={!canWrite}
          />
          <span className="flex flex-col gap-0.5">
            <span className="font-medium">{t('crossPipeline.label')}</span>
            <span className="text-xs text-ink-secondary">{t('crossPipeline.helper')}</span>
          </span>
        </label>
        {draft.crossPipelineMatch ? (
          <div
            role="status"
            className="flex items-start gap-2 rounded-md border border-status-warning/40 bg-status-warning/10 px-3 py-2 text-xs text-status-warning"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{t('crossPipeline.warning')}</span>
          </div>
        ) : null}
      </fieldset>

      {canWrite ? (
        <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
          <Button variant="ghost" size="sm" onClick={() => setResetOpen(true)} disabled={saving}>
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
            {t('resetCta')}
          </Button>
          <Button
            size="sm"
            onClick={() => setConfirmOpen(true)}
            disabled={!isDirty || saving}
            loading={saving}
          >
            <Save className="h-3.5 w-3.5" aria-hidden="true" />
            {t('saveCta')}
          </Button>
        </div>
      ) : null}

      {/* Confirmation modals */}
      <Modal
        open={confirmOpen}
        title={t('confirmSave.title')}
        onClose={() => (saving ? undefined : setConfirmOpen(false))}
        width="md"
        footer={
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirmOpen(false)}
              disabled={saving}
            >
              {tCommon('cancel')}
            </Button>
            <Button size="sm" onClick={() => void onConfirmSave()} loading={saving}>
              {t('confirmSave.cta')}
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-primary">{t('confirmSave.body')}</p>
      </Modal>

      <Modal
        open={resetOpen}
        title={t('confirmReset.title')}
        onClose={() => (saving ? undefined : setResetOpen(false))}
        width="md"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setResetOpen(false)} disabled={saving}>
              {tCommon('cancel')}
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={() => void onConfirmReset()}
              loading={saving}
            >
              {t('confirmReset.cta')}
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-primary">{t('confirmReset.body')}</p>
      </Modal>
    </section>
  );
}
