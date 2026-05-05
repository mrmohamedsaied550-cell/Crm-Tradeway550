'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Download, Flag, Plus, Power, Save, X } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input, Select } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { useToast } from '@/components/ui/toast';
import {
  ApiError,
  partnerMilestoneConfigsApi,
  partnerMilestoneProgressApi,
  partnerSourcesApi,
} from '@/lib/api';
import type {
  CreateMilestoneConfigInput,
  MilestoneAnchor,
  MilestoneConfigRow,
  PartnerSourceRow,
} from '@/lib/api-types';
import { hasCapability } from '@/lib/auth';
import { cn } from '@/lib/utils';

/**
 * Phase D4 — D4.7: Partner Milestones admin page.
 *
 * Operators with `partner.verification.read` see the list +
 * commission CSV exports. `partner.milestone.write` adds the
 * create / edit / disable controls. The page is locked-product-
 * decision read-only re: CRM truth — milestone progress NEVER
 * updates lead stage, captain status, or `Captain.tripCount` (the
 * helper line says so explicitly).
 */
const ANCHORS: readonly MilestoneAnchor[] = [
  'partner_active_date',
  'partner_dft_date',
  'first_seen_in_partner',
];

interface FormState {
  partnerSourceId: string;
  code: string;
  displayName: string;
  windowDays: string;
  /** Comma-separated step input — converted on submit. */
  milestoneSteps: string;
  anchor: MilestoneAnchor;
  riskHigh: string;
  riskMedium: string;
  isActive: boolean;
}

function emptyForm(): FormState {
  return {
    partnerSourceId: '',
    code: '',
    displayName: '',
    windowDays: '30',
    milestoneSteps: '1, 5, 25, 50',
    anchor: 'partner_active_date',
    riskHigh: '0.3',
    riskMedium: '0.6',
    isActive: true,
  };
}

function formFromRow(row: MilestoneConfigRow): FormState {
  return {
    partnerSourceId: row.partnerSourceId,
    code: row.code,
    displayName: row.displayName,
    windowDays: String(row.windowDays),
    milestoneSteps: row.milestoneSteps.join(', '),
    anchor: (row.anchor as MilestoneAnchor) || 'partner_active_date',
    riskHigh: row.riskThresholds ? String(row.riskThresholds.high) : '0.3',
    riskMedium: row.riskThresholds ? String(row.riskThresholds.medium) : '0.6',
    isActive: row.isActive,
  };
}

function parseSteps(raw: string): number[] {
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => Number.parseInt(s, 10))
    .filter((n) => Number.isFinite(n) && n > 0);
}

export default function PartnerMilestonesPage(): JSX.Element {
  const t = useTranslations('admin.partnerMilestones');
  const tCommon = useTranslations('admin.common');
  const { toast } = useToast();

  const canRead = hasCapability('partner.verification.read');
  const canWrite = hasCapability('partner.milestone.write');
  const canExport = hasCapability('partner.reconciliation.read');

  const [items, setItems] = useState<MilestoneConfigRow[]>([]);
  const [sources, setSources] = useState<PartnerSourceRow[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [featureDisabled, setFeatureDisabled] = useState<boolean>(false);

  // Editor modal state.
  const [editorOpen, setEditorOpen] = useState<boolean>(false);
  const [editing, setEditing] = useState<MilestoneConfigRow | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [saving, setSaving] = useState<boolean>(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    if (!canRead) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await partnerMilestoneConfigsApi.list({ limit: 100 });
      setItems(result.items);
      setFeatureDisabled(false);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'partner.feature.disabled') {
        setFeatureDisabled(true);
        setItems([]);
      } else {
        setError(err instanceof ApiError ? err.message : String(err));
      }
    } finally {
      setLoading(false);
    }
  }, [canRead]);

  useEffect(() => {
    if (!canRead) return;
    let cancelled = false;
    partnerSourcesApi
      .list({ isActive: true, limit: 100 })
      .then((res) => {
        if (!cancelled) setSources(res.items);
      })
      .catch(() => {
        // Best-effort — without sources the create form is
        // disabled; the operator can still see the existing list.
      });
    return () => {
      cancelled = true;
    };
  }, [canRead]);

  useEffect(() => {
    void reload();
  }, [reload]);

  function openCreate(): void {
    setEditing(null);
    setForm(emptyForm());
    setSaveError(null);
    setEditorOpen(true);
  }

  function openEdit(row: MilestoneConfigRow): void {
    setEditing(row);
    setForm(formFromRow(row));
    setSaveError(null);
    setEditorOpen(true);
  }

  async function onSave(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (!canWrite) return;
    setSaving(true);
    setSaveError(null);
    try {
      const steps = parseSteps(form.milestoneSteps);
      if (steps.length === 0) {
        throw new Error(t('errors.invalidSteps'));
      }
      const windowDays = Number.parseInt(form.windowDays, 10);
      if (!Number.isFinite(windowDays) || windowDays < 1) {
        throw new Error(t('errors.invalidWindowDays'));
      }
      const high = Number.parseFloat(form.riskHigh);
      const medium = Number.parseFloat(form.riskMedium);
      const riskThresholds =
        Number.isFinite(high) &&
        Number.isFinite(medium) &&
        high >= 0 &&
        medium <= 1 &&
        high < medium
          ? { high, medium }
          : undefined;

      if (editing) {
        await partnerMilestoneConfigsApi.update(editing.id, {
          code: form.code.trim(),
          displayName: form.displayName.trim(),
          windowDays,
          milestoneSteps: steps,
          anchor: form.anchor,
          ...(riskThresholds && { riskThresholds }),
          isActive: form.isActive,
        });
        toast({ tone: 'success', title: t('savedToast') });
      } else {
        if (!form.partnerSourceId) {
          throw new Error(t('errors.partnerSourceRequired'));
        }
        const payload: CreateMilestoneConfigInput = {
          partnerSourceId: form.partnerSourceId,
          code: form.code.trim(),
          displayName: form.displayName.trim(),
          windowDays,
          milestoneSteps: steps,
          anchor: form.anchor,
          ...(riskThresholds && { riskThresholds }),
          isActive: form.isActive,
        };
        await partnerMilestoneConfigsApi.create(payload);
        toast({ tone: 'success', title: t('createdToast') });
      }
      setEditorOpen(false);
      setEditing(null);
      await reload();
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function onDisable(row: MilestoneConfigRow): Promise<void> {
    if (!canWrite) return;
    try {
      await partnerMilestoneConfigsApi.disable(row.id);
      toast({ tone: 'success', title: t('disabledToast') });
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  if (!canRead) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title={t('title')} subtitle={t('subtitle')} />
        <EmptyState
          icon={<Flag className="h-7 w-7" aria-hidden="true" />}
          title={t('noAccessTitle')}
          body={t('noAccessBody')}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          <div className="flex items-center gap-2">
            {canExport ? (
              <>
                <a
                  href={partnerMilestoneProgressApi.progressCsvUrl()}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Button variant="ghost" size="sm" disabled={featureDisabled}>
                    <Download className="h-3.5 w-3.5" aria-hidden="true" />
                    {t('exportProgress')}
                  </Button>
                </a>
                <a
                  href={partnerMilestoneProgressApi.riskCsvUrl()}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Button variant="secondary" size="sm" disabled={featureDisabled}>
                    <Download className="h-3.5 w-3.5" aria-hidden="true" />
                    {t('exportRisk')}
                  </Button>
                </a>
              </>
            ) : null}
            {canWrite ? (
              <Button size="sm" onClick={openCreate} disabled={featureDisabled}>
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                {t('newCta')}
              </Button>
            ) : null}
          </div>
        }
      />

      <Notice tone="info">{t('helper')}</Notice>

      {featureDisabled ? <Notice tone="info">{t('featureDisabled')}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}

      {loading ? (
        <p className="text-sm text-ink-tertiary">{tCommon('loading')}</p>
      ) : items.length === 0 ? (
        <EmptyState
          icon={<Flag className="h-7 w-7" aria-hidden="true" />}
          title={t('emptyTitle')}
          body={t('emptyBody')}
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((row) => (
            <li key={row.id}>
              <ConfigCard
                row={row}
                t={t}
                canWrite={canWrite}
                onEdit={openEdit}
                onDisable={onDisable}
              />
            </li>
          ))}
        </ul>
      )}

      {/* Create / edit modal */}
      <Modal
        open={editorOpen}
        title={editing ? t('editorTitle.edit') : t('editorTitle.create')}
        onClose={() => (saving ? undefined : setEditorOpen(false))}
        width="lg"
      >
        <form onSubmit={onSave} className="flex flex-col gap-3">
          {saveError ? <Notice tone="error">{saveError}</Notice> : null}

          <Field label={t('form.partnerSource.label')} required>
            <Select
              value={form.partnerSourceId}
              onChange={(e) => setForm((f) => ({ ...f, partnerSourceId: e.target.value }))}
              disabled={!canWrite || editing !== null}
              required
            >
              <option value="" disabled>
                {t('form.partnerSource.placeholder')}
              </option>
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.displayName}
                </option>
              ))}
            </Select>
          </Field>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={t('form.code.label')} hint={t('form.code.helper')} required>
              <Input
                value={form.code}
                onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))}
                disabled={!canWrite}
                required
                pattern="[a-z0-9_]+"
                maxLength={64}
                placeholder="commission_50_30"
              />
            </Field>
            <Field label={t('form.displayName.label')} required>
              <Input
                value={form.displayName}
                onChange={(e) => setForm((f) => ({ ...f, displayName: e.target.value }))}
                disabled={!canWrite}
                required
                maxLength={200}
              />
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={t('form.windowDays.label')} hint={t('form.windowDays.helper')} required>
              <Input
                type="number"
                min={1}
                max={3650}
                value={form.windowDays}
                onChange={(e) => setForm((f) => ({ ...f, windowDays: e.target.value }))}
                disabled={!canWrite}
                required
              />
            </Field>
            <Field label={t('form.anchor.label')} hint={t('form.anchor.helper')} required>
              <Select
                value={form.anchor}
                onChange={(e) =>
                  setForm((f) => ({ ...f, anchor: e.target.value as MilestoneAnchor }))
                }
                disabled={!canWrite}
              >
                {ANCHORS.map((a) => (
                  <option key={a} value={a}>
                    {t(`anchors.${a}` as 'anchors.partner_active_date')}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <Field label={t('form.steps.label')} hint={t('form.steps.helper')} required>
            <Input
              value={form.milestoneSteps}
              onChange={(e) => setForm((f) => ({ ...f, milestoneSteps: e.target.value }))}
              disabled={!canWrite}
              required
              placeholder="1, 5, 25, 50"
            />
          </Field>

          <fieldset className="flex flex-col gap-2 rounded-md border border-surface-border bg-surface p-3">
            <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-ink-tertiary">
              {t('form.risk.section')}
            </legend>
            <p className="text-xs text-ink-secondary">{t('form.risk.helper')}</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label={t('form.risk.high.label')}>
                <Input
                  type="number"
                  step="0.05"
                  min={0}
                  max={1}
                  value={form.riskHigh}
                  onChange={(e) => setForm((f) => ({ ...f, riskHigh: e.target.value }))}
                  disabled={!canWrite}
                />
              </Field>
              <Field label={t('form.risk.medium.label')}>
                <Input
                  type="number"
                  step="0.05"
                  min={0}
                  max={1}
                  value={form.riskMedium}
                  onChange={(e) => setForm((f) => ({ ...f, riskMedium: e.target.value }))}
                  disabled={!canWrite}
                />
              </Field>
            </div>
          </fieldset>

          <label className="flex items-center gap-2 text-sm text-ink-primary">
            <input
              type="checkbox"
              checked={form.isActive}
              onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))}
              disabled={!canWrite}
            />
            {t('form.isActive.label')}
          </label>

          <div className="flex items-center justify-end gap-2">
            <Button
              variant="ghost"
              type="button"
              onClick={() => setEditorOpen(false)}
              disabled={saving}
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
              {tCommon('cancel')}
            </Button>
            <Button type="submit" loading={saving} disabled={!canWrite}>
              <Save className="h-3.5 w-3.5" aria-hidden="true" />
              {editing ? tCommon('save') : tCommon('create')}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

function ConfigCard({
  row,
  t,
  canWrite,
  onEdit,
  onDisable,
}: {
  row: MilestoneConfigRow;
  t: ReturnType<typeof useTranslations>;
  canWrite: boolean;
  onEdit: (row: MilestoneConfigRow) => void;
  onDisable: (row: MilestoneConfigRow) => void;
}): JSX.Element {
  return (
    <article
      className={cn(
        'flex flex-col gap-2 rounded-lg border bg-surface-card p-4 shadow-sm',
        row.isActive ? 'border-surface-border' : 'border-status-warning/20 opacity-80',
      )}
    >
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <div className="inline-flex flex-wrap items-center gap-2">
            <span className="text-base font-semibold text-ink-primary">{row.displayName}</span>
            <Badge tone={row.isActive ? 'info' : 'neutral'}>
              {row.isActive ? t('badges.active') : t('badges.disabled')}
            </Badge>
            <Badge tone="neutral">
              <code className="font-mono">{row.code}</code>
            </Badge>
          </div>
          <p className="text-xs text-ink-tertiary">
            {row.partnerSource?.displayName ?? '—'} ·{' '}
            {t('summary.window', { days: row.windowDays })} ·{' '}
            {t(`anchors.${row.anchor}` as 'anchors.partner_active_date')}
          </p>
        </div>
        {canWrite ? (
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => onEdit(row)}>
              {t('cardActions.edit')}
            </Button>
            {row.isActive ? (
              <Button variant="ghost" size="sm" onClick={() => onDisable(row)}>
                <Power className="h-3.5 w-3.5" aria-hidden="true" />
                {t('cardActions.disable')}
              </Button>
            ) : null}
          </div>
        ) : null}
      </header>

      <ul className="flex flex-wrap items-center gap-1">
        {row.milestoneSteps.map((step) => (
          <li
            key={step}
            className="inline-flex items-center gap-1 rounded-full border border-surface-border bg-surface px-2 py-0.5 text-[11px] font-medium text-ink-secondary"
          >
            {step}
          </li>
        ))}
      </ul>
    </article>
  );
}
