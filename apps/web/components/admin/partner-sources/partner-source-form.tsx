'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Building2, Globe, KeyRound, Save, ShieldOff } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import { ApiError, companiesApi, countriesApi } from '@/lib/api';
import type {
  Company,
  Country,
  CreatePartnerSourceInput,
  PartnerSourceRow,
  PartnerTabDiscoveryRule,
} from '@/lib/api-types';
import { hasCapability } from '@/lib/auth';
import { cn } from '@/lib/utils';

/**
 * Phase D4 — D4.2: PartnerSource create / edit form.
 *
 * Four sections:
 *   1. Identity            — display name / partner code / company / country
 *   2. Adapter & creds     — adapter picker + credentials sub-form +
 *                            "credentials configured / not configured"
 *                            indicator. Plaintext NEVER shown after save.
 *   3. Schedule & tabs     — manual / cron + fixed / new-per-period
 *   4. (Mappings)          — rendered separately on the detail page
 *                            (only meaningful once the source exists)
 *
 * The form intentionally does NOT echo back any credentials — once
 * an admin saves them they are stored encrypted on the server and
 * the response carries only `hasCredentials = true`. The form
 * shows a "Replace credentials" toggle to re-enter; an
 * "Erase credentials" button writes `credentials: null`.
 */

export type PartnerSourceFormMode = 'create' | 'edit';

interface FormState {
  partnerCode: string;
  displayName: string;
  adapter: 'google_sheets' | 'manual_upload';
  companyId: string;
  countryId: string;
  scheduleKind: 'manual' | 'cron';
  cronSpec: string;
  tabMode: 'fixed' | 'new_per_period';
  fixedTabName: string;
  tabDiscoveryKind: 'name_pattern' | 'most_recently_modified';
  tabDiscoveryPattern: string;
  isActive: boolean;
  /** Local-only; never echoed from API. */
  credentialsServiceAccountEmail: string;
  credentialsPrivateKey: string;
  credentialsSheetId: string;
}

const PARTNER_CODES = ['uber', 'indrive', 'didi', 'other'] as const;

function emptyForm(): FormState {
  return {
    partnerCode: '',
    displayName: '',
    adapter: 'google_sheets',
    companyId: '',
    countryId: '',
    scheduleKind: 'manual',
    cronSpec: '',
    tabMode: 'fixed',
    fixedTabName: '',
    tabDiscoveryKind: 'name_pattern',
    tabDiscoveryPattern: '',
    isActive: true,
    credentialsServiceAccountEmail: '',
    credentialsPrivateKey: '',
    credentialsSheetId: '',
  };
}

function formFromRow(row: PartnerSourceRow): FormState {
  const f = emptyForm();
  f.partnerCode = row.partnerCode;
  f.displayName = row.displayName;
  f.adapter = (row.adapter as FormState['adapter']) || 'google_sheets';
  f.companyId = row.companyId ?? '';
  f.countryId = row.countryId ?? '';
  f.scheduleKind = (row.scheduleKind as FormState['scheduleKind']) || 'manual';
  f.cronSpec = row.cronSpec ?? '';
  f.tabMode = (row.tabMode as FormState['tabMode']) || 'fixed';
  f.fixedTabName = row.fixedTabName ?? '';
  if (row.tabDiscoveryRule) {
    if (row.tabDiscoveryRule.kind === 'name_pattern') {
      f.tabDiscoveryKind = 'name_pattern';
      f.tabDiscoveryPattern = row.tabDiscoveryRule.pattern;
    } else {
      f.tabDiscoveryKind = 'most_recently_modified';
      f.tabDiscoveryPattern = '';
    }
  }
  f.isActive = row.isActive;
  return f;
}

export function PartnerSourceForm({
  mode,
  initial,
  onSubmit,
  onEraseCredentials,
}: {
  mode: PartnerSourceFormMode;
  initial?: PartnerSourceRow;
  onSubmit: (input: CreatePartnerSourceInput) => Promise<void>;
  onEraseCredentials?: () => Promise<void>;
}): JSX.Element {
  const t = useTranslations('admin.partnerSources.form');
  const tList = useTranslations('admin.partnerSources');
  const tCommon = useTranslations('admin.common');

  const canWrite = hasCapability('partner.source.write');

  const [form, setForm] = useState<FormState>(() => (initial ? formFromRow(initial) : emptyForm()));
  const [companies, setCompanies] = useState<Company[]>([]);
  const [countries, setCountries] = useState<Country[]>([]);
  const [enterCredentials, setEnterCredentials] = useState<boolean>(mode === 'create');
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (initial) setForm(formFromRow(initial));
  }, [initial]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      companiesApi.list().catch(() => [] as Company[]),
      countriesApi.list().catch(() => [] as Country[]),
    ])
      .then(([cps, cs]) => {
        if (cancelled) return;
        setCompanies(cps);
        setCountries(cs);
      })
      .catch(() => {
        // Best-effort — the create form still works without these
        // catalogues; the operator can leave the IDs blank for a
        // tenant-wide source.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const filteredCountries = useMemo(
    () => (form.companyId ? countries.filter((c) => c.companyId === form.companyId) : countries),
    [countries, form.companyId],
  );

  function setField<K extends keyof FormState>(key: K, value: FormState[K]): void {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (!canWrite) return;
    setSubmitting(true);
    setError(null);
    try {
      const tabDiscoveryRule: PartnerTabDiscoveryRule | null =
        form.tabMode === 'new_per_period'
          ? form.tabDiscoveryKind === 'name_pattern'
            ? { kind: 'name_pattern', pattern: form.tabDiscoveryPattern.trim() }
            : { kind: 'most_recently_modified' }
          : null;
      const credentials =
        enterCredentials && form.adapter === 'google_sheets'
          ? {
              serviceAccountEmail: form.credentialsServiceAccountEmail.trim(),
              privateKey: form.credentialsPrivateKey,
              sheetId: form.credentialsSheetId.trim(),
            }
          : undefined;
      const payload: CreatePartnerSourceInput = {
        partnerCode: form.partnerCode.trim(),
        displayName: form.displayName.trim(),
        adapter: form.adapter,
        companyId: form.companyId || null,
        countryId: form.countryId || null,
        scheduleKind: form.scheduleKind,
        cronSpec: form.scheduleKind === 'cron' ? form.cronSpec.trim() : null,
        tabMode: form.tabMode,
        fixedTabName: form.tabMode === 'fixed' ? form.fixedTabName.trim() : null,
        tabDiscoveryRule,
        isActive: form.isActive,
        ...(credentials !== undefined && { credentials }),
      };
      await onSubmit(payload);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      {!canWrite ? <Notice tone="info">{t('readOnlyBanner')}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}

      {/* ── 1. Identity ──────────────────────────────────────────── */}
      <fieldset className="flex flex-col gap-3 rounded-md border border-surface-border bg-surface p-4">
        <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-ink-tertiary">
          {t('sections.identity')}
        </legend>

        <Field label={t('displayName.label')} hint={t('displayName.helper')} required>
          <Input
            value={form.displayName}
            onChange={(e) => setField('displayName', e.target.value)}
            disabled={!canWrite}
            required
            maxLength={200}
          />
        </Field>

        <Field label={t('partnerCode.label')} hint={t('partnerCode.helper')} required>
          <Select
            value={form.partnerCode}
            onChange={(e) => setField('partnerCode', e.target.value)}
            disabled={!canWrite}
            required
          >
            <option value="" disabled>
              {t('partnerCode.placeholder')}
            </option>
            {PARTNER_CODES.map((code) => (
              <option key={code} value={code}>
                {t(`partnerCode.options.${code}` as 'partnerCode.options.uber')}
              </option>
            ))}
          </Select>
        </Field>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={t('company.label')} hint={t('company.helper')}>
            <Select
              value={form.companyId}
              onChange={(e) => {
                setField('companyId', e.target.value);
                setField('countryId', '');
              }}
              disabled={!canWrite}
            >
              <option value="">{t('company.any')}</option>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field label={t('country.label')} hint={t('country.helper')}>
            <Select
              value={form.countryId}
              onChange={(e) => setField('countryId', e.target.value)}
              disabled={!canWrite}
            >
              <option value="">{t('country.any')}</option>
              {filteredCountries.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <label className="flex items-center gap-2 text-sm text-ink-primary">
          <input
            type="checkbox"
            checked={form.isActive}
            onChange={(e) => setField('isActive', e.target.checked)}
            disabled={!canWrite}
          />
          {t('isActive.label')}
        </label>
      </fieldset>

      {/* ── 2. Adapter & credentials ─────────────────────────────── */}
      <fieldset className="flex flex-col gap-3 rounded-md border border-surface-border bg-surface p-4">
        <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-ink-tertiary">
          {t('sections.adapter')}
        </legend>

        <Field label={t('adapter.label')} hint={t('adapter.helper')} required>
          <Select
            value={form.adapter}
            onChange={(e) => setField('adapter', e.target.value as FormState['adapter'])}
            disabled={!canWrite}
          >
            <option value="google_sheets">{t('adapter.options.google_sheets')}</option>
            <option value="manual_upload">{t('adapter.options.manual_upload')}</option>
          </Select>
        </Field>

        {/* Credentials state indicator. The plaintext is NEVER shown
            back from the API; we only know hasCredentials. */}
        {form.adapter === 'google_sheets' ? (
          <div className="flex flex-col gap-2 rounded-md border border-surface-border bg-surface-card p-3">
            <div className="inline-flex items-center gap-2 text-sm">
              {initial?.hasCredentials ? (
                <Badge tone="info">
                  <KeyRound className="me-1 h-3 w-3" aria-hidden="true" />
                  {tList('credentials.configured')}
                </Badge>
              ) : (
                <Badge tone="neutral">
                  <ShieldOff className="me-1 h-3 w-3" aria-hidden="true" />
                  {tList('credentials.notConfigured')}
                </Badge>
              )}
              {initial?.credentialUpdatedAt && initial.hasCredentials ? (
                <span className="text-xs text-ink-tertiary">
                  {t('credentials.updatedAt')}:{' '}
                  {new Date(initial.credentialUpdatedAt).toLocaleString()}
                </span>
              ) : null}
            </div>
            <p className="text-xs text-ink-secondary">{t('credentials.privacyHelper')}</p>
            {mode === 'edit' && initial?.hasCredentials && !enterCredentials ? (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => setEnterCredentials(true)}
                  disabled={!canWrite}
                >
                  {t('credentials.replaceCta')}
                </Button>
                {onEraseCredentials ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => void onEraseCredentials()}
                    disabled={!canWrite}
                  >
                    {t('credentials.eraseCta')}
                  </Button>
                ) : null}
              </div>
            ) : null}

            {enterCredentials ? (
              <div className="flex flex-col gap-3">
                <Field label={t('credentials.serviceAccountEmail.label')} required>
                  <Input
                    type="email"
                    value={form.credentialsServiceAccountEmail}
                    onChange={(e) => setField('credentialsServiceAccountEmail', e.target.value)}
                    disabled={!canWrite}
                    required
                    placeholder="partner-sync@project-id.iam.gserviceaccount.com"
                  />
                </Field>
                <Field
                  label={t('credentials.privateKey.label')}
                  hint={t('credentials.privateKey.helper')}
                  required
                >
                  <Textarea
                    value={form.credentialsPrivateKey}
                    onChange={(e) => setField('credentialsPrivateKey', e.target.value)}
                    disabled={!canWrite}
                    rows={6}
                    required
                    placeholder={t('credentials.privateKey.placeholder')}
                  />
                </Field>
                <Field
                  label={t('credentials.sheetId.label')}
                  hint={t('credentials.sheetId.helper')}
                  required
                >
                  <Input
                    value={form.credentialsSheetId}
                    onChange={(e) => setField('credentialsSheetId', e.target.value)}
                    disabled={!canWrite}
                    required
                  />
                </Field>
                {mode === 'edit' && initial?.hasCredentials ? (
                  <button
                    type="button"
                    onClick={() => setEnterCredentials(false)}
                    className="self-start text-xs font-medium text-brand-700 hover:underline"
                  >
                    {t('credentials.cancelReplace')}
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : (
          <Notice tone="info">{t('adapter.manualUploadNotice')}</Notice>
        )}
      </fieldset>

      {/* ── 3. Schedule & tabs ───────────────────────────────────── */}
      <fieldset className="flex flex-col gap-3 rounded-md border border-surface-border bg-surface p-4">
        <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-ink-tertiary">
          {t('sections.schedule')}
        </legend>

        <Field label={t('schedule.kind.label')} required>
          <Select
            value={form.scheduleKind}
            onChange={(e) => setField('scheduleKind', e.target.value as FormState['scheduleKind'])}
            disabled={!canWrite}
          >
            <option value="manual">{t('schedule.kind.options.manual')}</option>
            <option value="cron">{t('schedule.kind.options.cron')}</option>
          </Select>
        </Field>

        {form.scheduleKind === 'cron' ? (
          <Field label={t('schedule.cronSpec.label')} hint={t('schedule.cronSpec.helper')} required>
            <Input
              value={form.cronSpec}
              onChange={(e) => setField('cronSpec', e.target.value)}
              disabled={!canWrite}
              placeholder="0 11 * * *"
              required
            />
          </Field>
        ) : null}

        <Field label={t('tabMode.label')} hint={t('tabMode.helper')} required>
          <Select
            value={form.tabMode}
            onChange={(e) => setField('tabMode', e.target.value as FormState['tabMode'])}
            disabled={!canWrite}
          >
            <option value="fixed">{t('tabMode.options.fixed')}</option>
            <option value="new_per_period">{t('tabMode.options.new_per_period')}</option>
          </Select>
        </Field>

        {form.tabMode === 'fixed' ? (
          <Field label={t('fixedTabName.label')} hint={t('fixedTabName.helper')} required>
            <Input
              value={form.fixedTabName}
              onChange={(e) => setField('fixedTabName', e.target.value)}
              disabled={!canWrite}
              required
            />
          </Field>
        ) : (
          <div className="flex flex-col gap-3 rounded-md border border-status-warning/30 bg-status-warning/5 p-3">
            <Field label={t('tabDiscovery.kind.label')} hint={t('tabDiscovery.kind.helper')}>
              <Select
                value={form.tabDiscoveryKind}
                onChange={(e) =>
                  setField('tabDiscoveryKind', e.target.value as FormState['tabDiscoveryKind'])
                }
                disabled={!canWrite}
              >
                <option value="name_pattern">{t('tabDiscovery.kind.options.name_pattern')}</option>
                <option value="most_recently_modified">
                  {t('tabDiscovery.kind.options.most_recently_modified')}
                </option>
              </Select>
            </Field>

            {form.tabDiscoveryKind === 'name_pattern' ? (
              <Field
                label={t('tabDiscovery.pattern.label')}
                hint={t('tabDiscovery.pattern.helper')}
                required
              >
                <Input
                  value={form.tabDiscoveryPattern}
                  onChange={(e) => setField('tabDiscoveryPattern', e.target.value)}
                  disabled={!canWrite}
                  placeholder="Activations YYYY-MM-DD"
                  required
                />
              </Field>
            ) : null}
          </div>
        )}
      </fieldset>

      {canWrite ? (
        <div className={cn('flex items-center justify-end gap-2')}>
          <Button type="submit" loading={submitting}>
            <Save className="h-3.5 w-3.5" aria-hidden="true" />
            {mode === 'create' ? tCommon('create') : tCommon('save')}
          </Button>
        </div>
      ) : null}

      <p className="text-xs text-ink-tertiary">
        <span className="inline-flex items-center gap-1">
          <Building2 className="h-3 w-3" aria-hidden="true" />
          <Globe className="h-3 w-3" aria-hidden="true" />
          {t('scopeHint')}
        </span>
      </p>
    </form>
  );
}
