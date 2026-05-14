'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import Image from 'next/image';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { useToast } from '@/components/ui/toast';
import { ApiError, tenantSettingsApi, type TenantBranding } from '@/lib/api';
import { hasCapability } from '@/lib/auth';
import { refreshBranding } from '@/lib/branding';

/**
 * Sprint 15 (D15) — Branding & Asset Settings page.
 *
 * URL-only this sprint: operators paste safe http(s) URLs (or relative
 * `/...` paths into /public). Binary upload is a future sprint — a
 * visible Notice block at the top of the form names the gap so nobody
 * mistakes URL fields for a place to upload bytes.
 *
 * Server-side validation lives in `branding.dto.ts` (rejects javascript:
 * / data: URLs, requires #rrggbb for colors). The client mirrors the
 * regex for UX so the operator sees inline errors immediately, but the
 * server remains the source of truth — UI checks are courtesy only.
 *
 * Capability:
 *   - Read mirrors `tenant.settings.read` — anyone in the tenant can
 *     fetch (so the sidebar/login render the right brand even for
 *     unauthenticated-but-tenant-scoped flows).
 *   - Write requires `tenant.settings.write` (Ops Manager / Account
 *     Manager / Super Admin). When the caller lacks it, the Save
 *     button is hidden and the form is read-only.
 */

const URL_RE = /^(?:https?:\/\/|\/).+/iu;
const HEX_RE = /^#[0-9a-f]{6}$/iu;

type FormState = {
  systemName: string;
  workspaceName: string;
  logoUrl: string;
  faviconUrl: string;
  loginImageUrl: string;
  primaryColor: string;
  accentColor: string;
  sidebarBgColor: string;
  sidebarHoverColor: string;
};

const EMPTY_FORM: FormState = {
  systemName: '',
  workspaceName: '',
  logoUrl: '',
  faviconUrl: '',
  loginImageUrl: '',
  primaryColor: '',
  accentColor: '',
  sidebarBgColor: '',
  sidebarHoverColor: '',
};

function brandingToForm(b: TenantBranding | null): FormState {
  if (!b) return EMPTY_FORM;
  return {
    systemName: b.systemName ?? '',
    workspaceName: b.workspaceName ?? '',
    logoUrl: b.logoUrl ?? '',
    faviconUrl: b.faviconUrl ?? '',
    loginImageUrl: b.loginImageUrl ?? '',
    primaryColor: b.primaryColor ?? '',
    accentColor: b.accentColor ?? '',
    sidebarBgColor: b.sidebarBgColor ?? '',
    sidebarHoverColor: b.sidebarHoverColor ?? '',
  };
}

export default function BrandingSettingsPage(): JSX.Element {
  const t = useTranslations('admin.branding');
  const tCommon = useTranslations('admin.common');
  const { toast } = useToast();

  const canWrite = hasCapability('tenant.settings.write');

  const [branding, setBranding] = useState<TenantBranding | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [loading, setLoading] = useState<boolean>(true);
  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof FormState, string>>>({});

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const cur = await tenantSettingsApi.getBranding();
      setBranding(cur);
      setForm(brandingToForm(cur));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  function validate(): boolean {
    const errs: Partial<Record<keyof FormState, string>> = {};
    for (const key of ['logoUrl', 'faviconUrl', 'loginImageUrl'] as const) {
      const value = form[key].trim();
      if (value && !URL_RE.test(value)) errs[key] = t('errors.invalidUrl');
    }
    for (const key of [
      'primaryColor',
      'accentColor',
      'sidebarBgColor',
      'sidebarHoverColor',
    ] as const) {
      const value = form[key].trim();
      if (value && !HEX_RE.test(value)) errs[key] = t('errors.invalidColor');
    }
    setFieldErrors(errs);
    return Object.keys(errs).length === 0;
  }

  /**
   * Build the PATCH body. Three-way semantics:
   *   - field unchanged from server → omit
   *   - field cleared by the user    → null
   *   - field has a value            → trimmed string
   */
  function buildPatch(): Record<string, string | null> {
    const out: Record<string, string | null> = {};
    const keys: (keyof FormState)[] = [
      'systemName',
      'workspaceName',
      'logoUrl',
      'faviconUrl',
      'loginImageUrl',
      'primaryColor',
      'accentColor',
      'sidebarBgColor',
      'sidebarHoverColor',
    ];
    for (const key of keys) {
      const next = form[key].trim();
      const prev = branding ? ((branding[key] as string | null) ?? '') : '';
      if (next === prev) continue;
      out[key] = next === '' ? null : next;
    }
    return out;
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (!canWrite) return;
    if (!validate()) return;
    const patch = buildPatch();
    if (Object.keys(patch).length === 0) {
      toast({ tone: 'info', title: t('toast.noChanges') });
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const updated = await tenantSettingsApi.updateBranding(patch);
      setBranding(updated);
      setForm(brandingToForm(updated));
      await refreshBranding();
      toast({ tone: 'success', title: t('toast.saved') });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  function onReset(): void {
    setForm(brandingToForm(branding));
    setFieldErrors({});
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          <Button variant="ghost" size="sm" onClick={() => void reload()} disabled={loading}>
            {tCommon('refresh')}
          </Button>
        }
      />

      {!canWrite ? <Notice tone="info">{t('readOnlyHint')}</Notice> : null}

      <Notice tone="info">
        <p className="text-sm font-medium">{t('uploadGap.title')}</p>
        <p className="mt-1 text-xs text-ink-secondary">{t('uploadGap.body')}</p>
      </Notice>

      {error ? <Notice tone="error">{error}</Notice> : null}

      <form className="flex flex-col gap-6" onSubmit={(e) => void onSubmit(e)}>
        {/* ─── System Identity ─── */}
        <section className="flex flex-col gap-3 rounded-lg border border-surface-border bg-surface-card p-4 shadow-card">
          <h2 className="text-sm font-semibold text-ink-primary">{t('sections.identity')}</h2>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Field label={t('fields.systemName')} hint={t('fields.systemNameHint')}>
              <Input
                value={form.systemName}
                onChange={(e) => setForm({ ...form, systemName: e.target.value })}
                placeholder={t('fields.systemNamePlaceholder')}
                disabled={!canWrite || loading}
                maxLength={120}
              />
            </Field>
            <Field label={t('fields.workspaceName')} hint={t('fields.workspaceNameHint')}>
              <Input
                value={form.workspaceName}
                onChange={(e) => setForm({ ...form, workspaceName: e.target.value })}
                placeholder={t('fields.workspaceNamePlaceholder')}
                disabled={!canWrite || loading}
                maxLength={120}
              />
            </Field>
          </div>

          <UrlField
            label={t('fields.logoUrl')}
            hint={t('fields.logoUrlHint')}
            value={form.logoUrl}
            disabled={!canWrite || loading}
            onChange={(v) => setForm({ ...form, logoUrl: v })}
            error={fieldErrors.logoUrl}
          />
          <UrlField
            label={t('fields.faviconUrl')}
            hint={t('fields.faviconUrlHint')}
            value={form.faviconUrl}
            disabled={!canWrite || loading}
            onChange={(v) => setForm({ ...form, faviconUrl: v })}
            error={fieldErrors.faviconUrl}
          />
          <UrlField
            label={t('fields.loginImageUrl')}
            hint={t('fields.loginImageUrlHint')}
            value={form.loginImageUrl}
            disabled={!canWrite || loading}
            onChange={(v) => setForm({ ...form, loginImageUrl: v })}
            error={fieldErrors.loginImageUrl}
          />
        </section>

        {/* ─── Theme colors ─── */}
        <section className="flex flex-col gap-3 rounded-lg border border-surface-border bg-surface-card p-4 shadow-card">
          <h2 className="text-sm font-semibold text-ink-primary">{t('sections.colors')}</h2>
          <p className="text-xs text-ink-secondary">{t('sections.colorsHint')}</p>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <HexField
              label={t('fields.primaryColor')}
              value={form.primaryColor}
              disabled={!canWrite || loading}
              onChange={(v) => setForm({ ...form, primaryColor: v })}
              error={fieldErrors.primaryColor}
            />
            <HexField
              label={t('fields.accentColor')}
              value={form.accentColor}
              disabled={!canWrite || loading}
              onChange={(v) => setForm({ ...form, accentColor: v })}
              error={fieldErrors.accentColor}
            />
            <HexField
              label={t('fields.sidebarBgColor')}
              value={form.sidebarBgColor}
              disabled={!canWrite || loading}
              onChange={(v) => setForm({ ...form, sidebarBgColor: v })}
              error={fieldErrors.sidebarBgColor}
            />
            <HexField
              label={t('fields.sidebarHoverColor')}
              value={form.sidebarHoverColor}
              disabled={!canWrite || loading}
              onChange={(v) => setForm({ ...form, sidebarHoverColor: v })}
              error={fieldErrors.sidebarHoverColor}
            />
          </div>
        </section>

        {/* ─── Preview ─── */}
        <section className="flex flex-col gap-3 rounded-lg border border-surface-border bg-surface-card p-4 shadow-card">
          <h2 className="text-sm font-semibold text-ink-primary">{t('sections.preview')}</h2>
          <BrandingPreview form={form} />
        </section>

        {canWrite ? (
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="secondary"
              type="button"
              onClick={onReset}
              disabled={saving || loading}
            >
              {t('actions.reset')}
            </Button>
            <Button type="submit" loading={saving} disabled={loading}>
              {t('actions.save')}
            </Button>
          </div>
        ) : null}
      </form>
    </div>
  );
}

function UrlField({
  label,
  hint,
  value,
  disabled,
  onChange,
  error,
}: {
  label: string;
  hint: string;
  value: string;
  disabled: boolean;
  onChange: (next: string) => void;
  error: string | undefined;
}): JSX.Element {
  return (
    <Field label={label} hint={hint} error={error}>
      <div className="flex items-start gap-3">
        <Input
          type="url"
          inputMode="url"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          placeholder="https://"
        />
        {value && !error ? (
          <span className="inline-flex h-10 w-10 items-center justify-center overflow-hidden rounded border border-surface-border bg-surface-muted">
            {/* Image preview — uses next/image with `unoptimized` so we
                don't have to whitelist arbitrary external hosts. */}
            <Image
              src={value}
              alt=""
              width={40}
              height={40}
              unoptimized
              className="h-full w-full object-contain"
              onError={(ev) => {
                (ev.target as HTMLImageElement).style.opacity = '0.2';
              }}
            />
          </span>
        ) : null}
      </div>
    </Field>
  );
}

function HexField({
  label,
  value,
  disabled,
  onChange,
  error,
}: {
  label: string;
  value: string;
  disabled: boolean;
  onChange: (next: string) => void;
  error: string | undefined;
}): JSX.Element {
  return (
    <Field label={label} error={error}>
      <div className="flex items-center gap-2">
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          placeholder="#1f3864"
          maxLength={7}
          className="font-mono uppercase"
        />
        <span
          className="inline-block h-9 w-9 shrink-0 rounded border border-surface-border"
          style={value && HEX_RE.test(value) ? { backgroundColor: value } : undefined}
          aria-hidden
        />
      </div>
    </Field>
  );
}

function BrandingPreview({ form }: { form: FormState }): JSX.Element {
  const sidebarBg = HEX_RE.test(form.sidebarBgColor) ? form.sidebarBgColor : '#0f172a';
  const sidebarHover = HEX_RE.test(form.sidebarHoverColor) ? form.sidebarHoverColor : '#1e293b';
  const primary = HEX_RE.test(form.primaryColor) ? form.primaryColor : '#1f3864';
  const accent = HEX_RE.test(form.accentColor) ? form.accentColor : '#3b82f6';
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-[160px_minmax(0,1fr)]">
      <div
        className="flex flex-col gap-1 rounded-md p-3 text-white"
        style={{ background: sidebarBg }}
      >
        <div className="flex items-center gap-2">
          {form.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={form.logoUrl}
              alt=""
              className="h-6 w-6 rounded-sm bg-white/10 object-contain"
              onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')}
            />
          ) : (
            <span
              className="inline-flex h-6 w-6 items-center justify-center rounded-sm text-xs font-bold"
              style={{ background: primary }}
            >
              {(form.systemName || 'T').slice(0, 1).toUpperCase()}
            </span>
          )}
          <span className="text-sm font-semibold">{form.systemName || 'System name'}</span>
        </div>
        <div className="mt-2 flex flex-col gap-1 text-xs">
          <span className="rounded px-2 py-1" style={{ background: sidebarHover }}>
            Leads
          </span>
          <span className="rounded px-2 py-1 opacity-80">WhatsApp</span>
          <span className="rounded px-2 py-1 opacity-80">Settings</span>
        </div>
      </div>
      <div className="flex flex-col gap-2 rounded-md border border-surface-border bg-surface-card p-3">
        <span className="text-xs text-ink-secondary">{form.workspaceName || 'Workspace'}</span>
        <div className="flex items-center gap-2">
          <span
            className="inline-flex items-center rounded-md px-3 py-1.5 text-xs font-medium text-white"
            style={{ background: primary }}
          >
            Primary action
          </span>
          <span
            className="inline-flex items-center rounded-md border px-3 py-1.5 text-xs font-medium"
            style={{ borderColor: accent, color: accent }}
          >
            Accent
          </span>
        </div>
      </div>
    </div>
  );
}
