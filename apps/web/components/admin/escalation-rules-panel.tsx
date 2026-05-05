'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, RotateCcw, Save } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Notice } from '@/components/ui/notice';
import { useToast } from '@/components/ui/toast';
import { ApiError, tenantSettingsApi } from '@/lib/api';
import type {
  EscalationAction,
  EscalationHandoverMode,
  EscalationRulesConfig,
  EscalationThresholdPolicy,
} from '@/lib/api-types';
import { hasCapability } from '@/lib/auth';
import { cn } from '@/lib/utils';

/**
 * Phase D3 — D3.7: tenant SLA escalation rules editor.
 *
 * Operational decision panel — NOT a JSON editor. Four threshold
 * cards (t75 / t100 / t150 / t200) explain operational impact in
 * plain language; each card picks one action from a small radio
 * group. The default-handover-mode picker sits below the cards. A
 * confirmation modal reminds the operator that saving rewires
 * SLA-driven rotation behaviour.
 *
 * Read access: `tenant.settings.read` — every TL+ role already
 * holds it. Write access: `tenant.settings.write` (Ops Manager /
 * Account Manager / Super Admin auto-bypass). When the actor lacks
 * write, the panel renders read-only — no Save / Reset buttons,
 * inputs disabled, neutral banner explaining why.
 */

const THRESHOLDS = ['t75', 't100', 't150', 't200'] as const;
type ThresholdKey = (typeof THRESHOLDS)[number];

const ACTIONS: readonly EscalationAction[] = [
  'notify_only',
  'notify_and_tag',
  'rotate',
  'rotate_or_review',
  'raise_review',
];

const HANDOVER_MODES: readonly EscalationHandoverMode[] = ['full', 'summary', 'clean'];

/**
 * Locked product defaults — kept in sync with
 * `apps/api/src/crm/escalation-rules.dto.ts:DEFAULT_ESCALATION_RULES`.
 * The "Reset to defaults" button writes exactly this object.
 */
const LOCKED_DEFAULTS: EscalationRulesConfig = {
  thresholds: {
    t75: { action: 'notify_only', rotateOnFirst: true, reviewOnRepeatWithinHours: 24 },
    t100: { action: 'notify_and_tag', rotateOnFirst: true, reviewOnRepeatWithinHours: 24 },
    t150: { action: 'rotate_or_review', rotateOnFirst: true, reviewOnRepeatWithinHours: 24 },
    t200: { action: 'raise_review', rotateOnFirst: true, reviewOnRepeatWithinHours: 24 },
  },
  defaultHandoverMode: 'full',
};

export function EscalationRulesPanel(): JSX.Element {
  const t = useTranslations('admin.escalationRules');
  const tCommon = useTranslations('admin.common');
  const { toast } = useToast();

  const canRead = hasCapability('tenant.settings.read');
  const canWrite = hasCapability('tenant.settings.write');

  const [persisted, setPersisted] = useState<EscalationRulesConfig | null>(null);
  const [draft, setDraft] = useState<EscalationRulesConfig | null>(null);
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
    tenantSettingsApi
      .getEscalationRules()
      .then((row) => {
        if (cancelled) return;
        setPersisted(row);
        setDraft(row);
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
    return JSON.stringify(persisted) !== JSON.stringify(draft);
  }, [persisted, draft]);

  function setThresholdField<K extends keyof EscalationThresholdPolicy>(
    key: ThresholdKey,
    field: K,
    value: EscalationThresholdPolicy[K],
  ): void {
    setDraft((d) =>
      d
        ? {
            ...d,
            thresholds: {
              ...d.thresholds,
              [key]: { ...d.thresholds[key], [field]: value },
            },
          }
        : d,
    );
  }

  async function persist(next: EscalationRulesConfig): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      const updated = await tenantSettingsApi.updateEscalationRules(next);
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

      {/* ─── Threshold cards ────────────────────────────────────── */}
      <div className="flex flex-col gap-3">
        {THRESHOLDS.map((key) => {
          const policy = draft.thresholds[key];
          const showRotateOrReviewExtras = policy.action === 'rotate_or_review';
          return (
            <fieldset
              key={key}
              className="flex flex-col gap-3 rounded-md border border-surface-border bg-surface p-3"
            >
              <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-ink-tertiary">
                {t(`thresholds.${key}.label` as 'thresholds.t75.label')}
              </legend>
              <p className="text-sm text-ink-secondary">
                {t(`thresholds.${key}.helper` as 'thresholds.t75.helper')}
              </p>

              <div
                role="radiogroup"
                aria-label={t(`thresholds.${key}.label` as 'thresholds.t75.label')}
                className="flex flex-col gap-2"
              >
                {ACTIONS.map((action) => (
                  <button
                    key={action}
                    type="button"
                    role="radio"
                    aria-checked={policy.action === action}
                    onClick={() => canWrite && setThresholdField(key, 'action', action)}
                    disabled={!canWrite}
                    className={cn(
                      'flex flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-start transition-colors',
                      policy.action === action
                        ? 'border-brand-600 bg-brand-50/60'
                        : 'border-surface-border hover:bg-brand-50/30',
                      !canWrite && 'cursor-not-allowed opacity-70',
                    )}
                  >
                    <span className="text-sm font-medium text-ink-primary">
                      {t(`actions.${action}.label` as 'actions.notify_only.label')}
                    </span>
                    <span className="text-xs text-ink-tertiary">
                      {t(`actions.${action}.helper` as 'actions.notify_only.helper')}
                    </span>
                  </button>
                ))}
              </div>

              {showRotateOrReviewExtras ? (
                <div className="grid grid-cols-1 gap-3 rounded-md border border-status-warning/30 bg-status-warning/5 p-3 sm:grid-cols-2">
                  <label className="flex items-start gap-2 text-sm text-ink-primary">
                    <input
                      type="checkbox"
                      className="mt-1 h-4 w-4 rounded border-surface-border text-brand-600 focus:ring-brand-600"
                      checked={policy.rotateOnFirst}
                      onChange={(e) => setThresholdField(key, 'rotateOnFirst', e.target.checked)}
                      disabled={!canWrite}
                    />
                    <span className="flex flex-col gap-0.5">
                      <span className="font-medium">{t('rotateOnFirst.label')}</span>
                      <span className="text-xs text-ink-secondary">
                        {t('rotateOnFirst.helper')}
                      </span>
                    </span>
                  </label>
                  <Field
                    label={t('reviewOnRepeatWithinHours.label')}
                    hint={t('reviewOnRepeatWithinHours.helper')}
                  >
                    <Input
                      type="number"
                      min={1}
                      max={168}
                      value={String(policy.reviewOnRepeatWithinHours)}
                      onChange={(e) =>
                        setThresholdField(
                          key,
                          'reviewOnRepeatWithinHours',
                          Math.max(1, Math.min(168, Number.parseInt(e.target.value, 10) || 24)),
                        )
                      }
                      disabled={!canWrite}
                      className="max-w-[140px]"
                    />
                  </Field>
                </div>
              ) : null}
            </fieldset>
          );
        })}
      </div>

      {/* ─── Default handover mode ─────────────────────────────── */}
      <fieldset className="flex flex-col gap-2 rounded-md border border-surface-border bg-surface p-3">
        <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-ink-tertiary">
          {t('handoverMode.section')}
        </legend>
        <p className="text-xs text-ink-secondary">{t('handoverMode.intro')}</p>
        <div
          role="radiogroup"
          aria-label={t('handoverMode.section')}
          className="flex flex-col gap-2"
        >
          {HANDOVER_MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={draft.defaultHandoverMode === mode}
              onClick={() =>
                canWrite && setDraft((d) => (d ? { ...d, defaultHandoverMode: mode } : d))
              }
              disabled={!canWrite}
              className={cn(
                'flex flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-start transition-colors',
                draft.defaultHandoverMode === mode
                  ? 'border-brand-600 bg-brand-50/60'
                  : 'border-surface-border hover:bg-brand-50/30',
                !canWrite && 'cursor-not-allowed opacity-70',
              )}
            >
              <span className="text-sm font-medium text-ink-primary">
                {t(`handoverMode.options.${mode}.label` as 'handoverMode.options.full.label')}
              </span>
              <span className="text-xs text-ink-tertiary">
                {t(`handoverMode.options.${mode}.helper` as 'handoverMode.options.full.helper')}
              </span>
            </button>
          ))}
        </div>
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
            <Button size="sm" onClick={() => void persist(draft)} loading={saving}>
              {t('confirmSave.cta')}
            </Button>
          </>
        }
      >
        <div className="flex items-start gap-2 rounded-md border border-status-warning/40 bg-status-warning/10 px-3 py-2 text-xs text-status-warning">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{t('confirmSave.body')}</span>
        </div>
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
              onClick={() => void persist(LOCKED_DEFAULTS)}
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
