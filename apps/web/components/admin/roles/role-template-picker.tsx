'use client';

import { useEffect, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import {
  ArrowLeft,
  ChevronRight,
  FileDown,
  Layers,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Input, Textarea } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Notice } from '@/components/ui/notice';
import { useToast } from '@/components/ui/toast';
import { DependencyWarningsPanel } from './dependency-warnings-panel';
import { ApiError, rolesApi } from '@/lib/api';
import type {
  RoleTemplateCategory,
  RoleTemplatePreviewResult,
  RoleTemplateRiskTag,
  RoleTemplateSummary,
} from '@/lib/api-types';

/**
 * Phase D5 — D5.16: role template picker.
 *
 * Three-stage modal:
 *
 *   1. **List** — every template grouped by category with a
 *      one-line description, a small risk-tag badge strip, and
 *      a "Preview" CTA.
 *   2. **Preview** — the template's full structural shape +
 *      D5.14 dependency-warnings panel + high-risk capability
 *      list. The admin sees exactly what they are about to
 *      grant before clicking Continue.
 *   3. **Form** — the admin supplies code / nameEn / nameAr /
 *      description (descriptionEn). When the preview reported
 *      `requiresTypedConfirmation`, the form also asks for the
 *      D5.14 typed phrase. The Create button calls
 *      `POST /rbac/roles/from-template`; success closes the
 *      modal and the parent page reloads the role list.
 *
 * No duplicate flow is removed — the picker sits next to the
 * existing "Duplicate role" CTA.
 */

type Step = 'list' | 'preview' | 'form';

export function RoleTemplatePicker({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  /** Called with the new role's id after a successful create. */
  onCreated: (newRoleId: string) => Promise<void> | void;
}): JSX.Element | null {
  const t = useTranslations('admin.roles.templates');
  const { toast } = useToast();

  const [step, setStep] = useState<Step>('list');
  const [templates, setTemplates] = useState<readonly RoleTemplateSummary[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<RoleTemplatePreviewResult | null>(null);

  // Form state — populated when stepping into 'form'.
  const [formCode, setFormCode] = useState<string>('');
  const [formNameEn, setFormNameEn] = useState<string>('');
  const [formNameAr, setFormNameAr] = useState<string>('');
  const [formDescription, setFormDescription] = useState<string>('');
  const [confirmationPhrase, setConfirmationPhrase] = useState<string>('');
  const [submitting, setSubmitting] = useState<boolean>(false);

  // Reset everything when the modal closes.
  useEffect(() => {
    if (!open) {
      setStep('list');
      setPreview(null);
      setFormCode('');
      setFormNameEn('');
      setFormNameAr('');
      setFormDescription('');
      setConfirmationPhrase('');
      setError(null);
    }
  }, [open]);

  // Load the registry on first open.
  useEffect(() => {
    if (!open || templates.length > 0) return;
    setLoading(true);
    setError(null);
    rolesApi
      .listTemplates()
      .then((res) => setTemplates(res.templates))
      .catch((err) => setError(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [open, templates.length]);

  const grouped = useMemo(() => groupByCategory(templates), [templates]);

  async function startPreview(code: string): Promise<void> {
    setStep('preview');
    setLoading(true);
    setError(null);
    try {
      const res = await rolesApi.previewTemplate(code);
      setPreview(res);
      setFormNameEn(res.template.nameEn);
      setFormNameAr(res.template.nameAr);
      setFormDescription(res.template.descriptionEn);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function submitCreate(): Promise<void> {
    if (!preview) return;
    setSubmitting(true);
    setError(null);
    try {
      const created = await rolesApi.createFromTemplate({
        templateCode: preview.template.code,
        code: formCode.trim(),
        nameEn: formNameEn.trim(),
        nameAr: formNameAr.trim(),
        descriptionEn: formDescription.trim() || null,
        ...(confirmationPhrase ? { confirmation: confirmationPhrase } : {}),
      });
      toast({ tone: 'success', title: t('createdToast', { name: created.nameEn }) });
      await onCreated(created.id);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) return null;

  const requiresPhrase = preview?.dependencyAnalysis.requiresTypedConfirmation ?? false;
  const requiredPhrase = preview?.typedConfirmationPhrase ?? '';
  const phraseMatches = !requiresPhrase || confirmationPhrase === requiredPhrase;
  const formValid =
    formCode.trim().length >= 2 &&
    /^[a-z0-9_]+$/.test(formCode.trim()) &&
    formNameEn.trim().length > 0 &&
    formNameAr.trim().length > 0 &&
    phraseMatches;

  return (
    <Modal
      open={open}
      title={
        step === 'list'
          ? t('list.title')
          : step === 'preview'
            ? t('preview.title', { name: preview?.template.nameEn ?? '' })
            : t('form.title')
      }
      onClose={onClose}
      width="lg"
      footer={
        step === 'list' ? (
          <Button variant="ghost" onClick={onClose}>
            {t('list.close')}
          </Button>
        ) : step === 'preview' ? (
          <>
            <Button variant="ghost" onClick={() => setStep('list')}>
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
              {t('preview.back')}
            </Button>
            <Button onClick={() => setStep('form')} disabled={!preview || loading}>
              {t('preview.continue')}
              <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={() => setStep('preview')} disabled={submitting}>
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
              {t('form.back')}
            </Button>
            <Button
              onClick={() => void submitCreate()}
              loading={submitting}
              disabled={!formValid || submitting}
              data-testid="role-template-create"
            >
              {t('form.create')}
            </Button>
          </>
        )
      }
    >
      {error ? <Notice tone="error">{error}</Notice> : null}

      {step === 'list' ? (
        <ListView
          loading={loading}
          grouped={grouped}
          onPreview={(code) => void startPreview(code)}
        />
      ) : null}

      {step === 'preview' ? <PreviewView preview={preview} loading={loading} /> : null}

      {step === 'form' && preview ? (
        <FormView
          preview={preview}
          formCode={formCode}
          setFormCode={setFormCode}
          formNameEn={formNameEn}
          setFormNameEn={setFormNameEn}
          formNameAr={formNameAr}
          setFormNameAr={setFormNameAr}
          formDescription={formDescription}
          setFormDescription={setFormDescription}
          requiresPhrase={requiresPhrase}
          requiredPhrase={requiredPhrase}
          confirmationPhrase={confirmationPhrase}
          setConfirmationPhrase={setConfirmationPhrase}
        />
      ) : null}
    </Modal>
  );
}

// ─── List view ─────────────────────────────────────────────────

function ListView({
  loading,
  grouped,
  onPreview,
}: {
  loading: boolean;
  grouped: ReadonlyArray<{ category: RoleTemplateCategory; items: readonly RoleTemplateSummary[] }>;
  onPreview: (code: string) => void;
}): JSX.Element {
  const t = useTranslations('admin.roles.templates');
  const tCommon = useTranslations('admin.common');
  const locale = useLocale();
  const isAr = locale === 'ar';

  if (loading && grouped.length === 0) {
    return (
      <p className="rounded-md border border-surface-border bg-surface px-4 py-6 text-center text-sm text-ink-secondary">
        {tCommon('loading')}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-4" data-testid="role-template-picker-list">
      <Notice tone="info">
        <span>{t('list.intro')}</span>
      </Notice>
      {grouped.map(({ category, items }) => (
        <section key={category} className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-tertiary">
            {t(`categories.${category}` as 'categories.agent')}
          </h3>
          <ul className="flex flex-col gap-2">
            {items.map((tpl) => (
              <li key={tpl.code}>
                <button
                  type="button"
                  onClick={() => onPreview(tpl.code)}
                  className="flex w-full flex-col gap-2 rounded-md border border-surface-border bg-surface px-3 py-2 text-start hover:border-brand-200 hover:bg-brand-50/30"
                  data-testid="role-template-card"
                  data-template-code={tpl.code}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex flex-col leading-tight">
                      <span className="text-sm font-medium text-ink-primary">
                        {isAr ? tpl.nameAr : tpl.nameEn}
                      </span>
                      <code className="font-mono text-[11px] text-ink-tertiary">{tpl.code}</code>
                    </div>
                    <ChevronRight
                      className="mt-0.5 h-4 w-4 shrink-0 text-ink-tertiary"
                      aria-hidden="true"
                    />
                  </div>
                  <p className="text-xs text-ink-secondary">
                    {isAr ? tpl.descriptionAr : tpl.descriptionEn}
                  </p>
                  <div className="flex flex-wrap items-center gap-2 text-[11px] text-ink-tertiary">
                    <span className="inline-flex items-center gap-1">
                      <Sparkles className="h-3 w-3" aria-hidden="true" />
                      {t('list.capabilityCount', { n: tpl.capabilityCount })}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <Layers className="h-3 w-3" aria-hidden="true" />
                      {t('list.scopeCount', { n: tpl.scopeCount })}
                    </span>
                    {tpl.riskTags.length === 0 ? (
                      <span className="inline-flex items-center gap-1 rounded-full border border-status-healthy/40 bg-status-healthy/5 px-2 py-0.5 text-status-healthy">
                        <ShieldCheck className="h-3 w-3" aria-hidden="true" />
                        {t('list.safeBadge')}
                      </span>
                    ) : (
                      tpl.riskTags.map((tag) => <RiskBadge key={tag} tag={tag} />)
                    )}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

// ─── Preview view ─────────────────────────────────────────────

function PreviewView({
  preview,
  loading,
}: {
  preview: RoleTemplatePreviewResult | null;
  loading: boolean;
}): JSX.Element | null {
  const t = useTranslations('admin.roles.templates.preview');
  const tCommon = useTranslations('admin.common');
  const locale = useLocale();
  const isAr = locale === 'ar';

  if (loading || !preview) {
    return (
      <p className="rounded-md border border-surface-border bg-surface px-4 py-6 text-center text-sm text-ink-secondary">
        {tCommon('loading')}
      </p>
    );
  }
  const tpl = preview.template;
  return (
    <div className="flex flex-col gap-4" data-testid="role-template-picker-preview">
      <Notice tone="info">
        <span>{isAr ? tpl.descriptionAr : tpl.descriptionEn}</span>
      </Notice>

      {tpl.riskTags.length > 0 ? (
        <ul className="flex flex-wrap gap-2" data-testid="role-template-risk-tags">
          {tpl.riskTags.map((tag) => (
            <li key={tag}>
              <RiskBadge tag={tag} />
            </li>
          ))}
        </ul>
      ) : (
        <Notice tone="success">
          <span>{t('safeNotice')}</span>
        </Notice>
      )}

      <DependencyWarningsPanel analysis={preview.dependencyAnalysis} />

      <section className="flex flex-col gap-1">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-tertiary">
          {t('capabilities', { n: tpl.capabilities.length })}
        </h3>
        <ul className="flex flex-wrap gap-1">
          {tpl.capabilities.map((c) => (
            <li
              key={c}
              className="inline-flex items-center rounded-md border border-surface-border bg-surface px-2 py-0.5 font-mono text-[11px] text-ink-secondary"
            >
              {c}
            </li>
          ))}
        </ul>
      </section>

      <section className="flex flex-col gap-1">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-tertiary">
          {t('scopes')}
        </h3>
        <ul className="flex flex-col gap-1">
          {tpl.scopes.map((s) => (
            <li
              key={s.resource}
              className="flex items-center justify-between rounded-md border border-surface-border bg-surface px-3 py-1.5 text-xs"
            >
              <code className="font-mono text-ink-primary">{s.resource}</code>
              <code className="font-mono text-ink-secondary">{s.scope}</code>
            </li>
          ))}
        </ul>
      </section>

      {tpl.fieldPermissions.length > 0 ? (
        <section className="flex flex-col gap-1">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-tertiary">
            {t('fieldDenies', { n: tpl.fieldPermissions.length })}
          </h3>
          <ul className="flex flex-col gap-1">
            {tpl.fieldPermissions.map((p) => (
              <li
                key={`${p.resource}::${p.field}`}
                className="flex items-center justify-between rounded-md border border-status-warning/40 bg-status-warning/5 px-3 py-1.5 text-xs"
              >
                <code className="font-mono text-ink-primary">
                  {p.resource}.{p.field}
                </code>
                <span className="inline-flex items-center gap-1 text-[11px] text-ink-secondary">
                  <span className={p.canRead ? 'text-status-healthy' : 'text-status-breach'}>
                    {p.canRead ? 'R' : 'r̶'}
                  </span>
                  <span className={p.canWrite ? 'text-status-healthy' : 'text-status-breach'}>
                    {p.canWrite ? 'W' : 'w̶'}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

// ─── Form view ─────────────────────────────────────────────────

function FormView({
  preview,
  formCode,
  setFormCode,
  formNameEn,
  setFormNameEn,
  formNameAr,
  setFormNameAr,
  formDescription,
  setFormDescription,
  requiresPhrase,
  requiredPhrase,
  confirmationPhrase,
  setConfirmationPhrase,
}: {
  preview: RoleTemplatePreviewResult;
  formCode: string;
  setFormCode: (s: string) => void;
  formNameEn: string;
  setFormNameEn: (s: string) => void;
  formNameAr: string;
  setFormNameAr: (s: string) => void;
  formDescription: string;
  setFormDescription: (s: string) => void;
  requiresPhrase: boolean;
  requiredPhrase: string;
  confirmationPhrase: string;
  setConfirmationPhrase: (s: string) => void;
}): JSX.Element {
  const t = useTranslations('admin.roles.templates.form');
  return (
    <div className="flex flex-col gap-3" data-testid="role-template-picker-form">
      <Notice tone="info">
        <span>{t('intro', { template: preview.template.nameEn })}</span>
      </Notice>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label={t('codeLabel')} hint={t('codeHint')}>
          <Input
            value={formCode}
            onChange={(e) => setFormCode(e.target.value)}
            placeholder="my_custom_role"
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            data-testid="role-template-code"
          />
        </Field>
        <Field label={t('nameEnLabel')}>
          <Input
            value={formNameEn}
            onChange={(e) => setFormNameEn(e.target.value)}
            data-testid="role-template-name-en"
          />
        </Field>
        <Field label={t('nameArLabel')}>
          <Input
            value={formNameAr}
            onChange={(e) => setFormNameAr(e.target.value)}
            data-testid="role-template-name-ar"
          />
        </Field>
      </div>
      <Field label={t('descriptionLabel')}>
        <Textarea
          value={formDescription}
          onChange={(e) => setFormDescription(e.target.value)}
          rows={3}
          maxLength={500}
        />
      </Field>
      {requiresPhrase ? (
        <div className="rounded-md border border-status-breach/40 bg-status-breach/5 p-3">
          <Field
            label={t('typedConfirmation.fieldLabel', { phrase: requiredPhrase })}
            hint={t('typedConfirmation.fieldHint')}
          >
            <Input
              value={confirmationPhrase}
              onChange={(e) => setConfirmationPhrase(e.target.value)}
              spellCheck={false}
              autoComplete="off"
              data-testid="role-template-confirmation"
            />
          </Field>
        </div>
      ) : null}
    </div>
  );
}

// ─── Risk badge helper ────────────────────────────────────────

function RiskBadge({ tag }: { tag: RoleTemplateRiskTag }): JSX.Element {
  const t = useTranslations('admin.roles.templates.risks');
  const tone = tag === 'high_privilege' ? 'breach' : 'warning';
  return (
    <Badge tone={tone}>
      {tag === 'export_capability' || tag === 'tenant_export' ? (
        <FileDown className="me-1 inline h-3 w-3" aria-hidden="true" />
      ) : (
        <ShieldAlert className="me-1 inline h-3 w-3" aria-hidden="true" />
      )}
      {t(tag)}
    </Badge>
  );
}

function groupByCategory(
  templates: readonly RoleTemplateSummary[],
): ReadonlyArray<{ category: RoleTemplateCategory; items: readonly RoleTemplateSummary[] }> {
  const order: RoleTemplateCategory[] = [
    'agent',
    'team_lead',
    'qa',
    'partner',
    'finance',
    'admin',
    'viewer',
  ];
  const map = new Map<RoleTemplateCategory, RoleTemplateSummary[]>();
  for (const cat of order) map.set(cat, []);
  for (const tpl of templates) {
    const arr = map.get(tpl.category);
    if (arr) arr.push(tpl);
  }
  return order
    .filter((cat) => (map.get(cat)?.length ?? 0) > 0)
    .map((category) => ({ category, items: map.get(category) ?? [] }));
}
