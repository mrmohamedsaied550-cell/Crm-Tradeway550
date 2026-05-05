'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowRight } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { DuplicateRulesPanel } from '@/components/admin/duplicate-rules-panel';
import { EscalationRulesPanel } from '@/components/admin/escalation-rules-panel';
import { Field, Input } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { useToast } from '@/components/ui/toast';
import { ApiError, tenantSettingsApi } from '@/lib/api';
import type { TenantSettingsRow } from '@/lib/api-types';

/**
 * P2-08 — tenant-level configuration:
 *   - timezone (IANA, e.g. "Africa/Cairo")
 *   - SLA window in minutes (1..1440)
 *   - default dial code (E.164 prefix)
 *
 * Phase 1A — A10: the legacy inline distribution-rules editor (PL-3)
 * has been replaced by the dedicated /admin/distribution page, which
 * supports the full rule shape (priority, conditions on company /
 * country / team, four routing strategies, capacities, audit log).
 * The `tenantSettings.distributionRules` JSONB column is intentionally
 * left in place — older tenants that still hold legacy values can
 * read them via the API, but new tenants should manage routing
 * exclusively through the new page.
 */

export default function TenantSettingsPage(): JSX.Element {
  const t = useTranslations('admin.tenantSettings');
  const { toast } = useToast();

  const [row, setRow] = useState<TenantSettingsRow | null>(null);
  const [form, setForm] = useState<{
    timezone: string;
    slaMinutes: string;
    defaultDialCode: string;
  }>({ timezone: '', slaMinutes: '', defaultDialCode: '' });
  const [loading, setLoading] = useState<boolean>(true);
  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const cur = await tenantSettingsApi.get();
      setRow(cur);
      setForm({
        timezone: cur.timezone,
        slaMinutes: String(cur.slaMinutes),
        defaultDialCode: cur.defaultDialCode,
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const minutes = Number.parseInt(form.slaMinutes, 10);
    try {
      const updated = await tenantSettingsApi.update({
        timezone: form.timezone.trim(),
        slaMinutes: Number.isFinite(minutes) ? minutes : undefined,
        defaultDialCode: form.defaultDialCode.trim(),
      });
      setRow(updated);
      toast({ tone: 'success', title: t('saved') });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={t('title')} subtitle={t('subtitle')} />

      {error ? <Notice tone="error">{error}</Notice> : null}

      <form
        onSubmit={onSubmit}
        className="flex max-w-3xl flex-col gap-4 rounded-lg border border-surface-border bg-surface-card p-4 shadow-card"
      >
        <Field label={t('timezone')} hint={t('timezoneHint')} required>
          <Input
            value={form.timezone}
            onChange={(e) => setForm((f) => ({ ...f, timezone: e.target.value }))}
            disabled={loading}
            required
            maxLength={64}
          />
        </Field>
        <Field label={t('slaMinutes')} hint={t('slaMinutesHint')} required>
          <Input
            type="number"
            min={1}
            max={1440}
            value={form.slaMinutes}
            onChange={(e) => setForm((f) => ({ ...f, slaMinutes: e.target.value }))}
            disabled={loading}
            required
          />
        </Field>
        <Field label={t('defaultDialCode')} hint={t('defaultDialCodeHint')} required>
          <Input
            value={form.defaultDialCode}
            onChange={(e) => setForm((f) => ({ ...f, defaultDialCode: e.target.value }))}
            disabled={loading}
            required
            pattern="\+\d{1,4}"
            placeholder="+20"
          />
        </Field>

        <div className="flex items-center justify-end gap-2">
          <Button type="submit" loading={saving} disabled={loading || saving || row === null}>
            {t('save')}
          </Button>
        </div>
      </form>

      {/* Phase D2 — D2.4: tenant Duplicate / Reactivation Rules.
          Operational decision panel — separate from the core SLA /
          dial-code form because the capability gate is distinct
          (`tenant.duplicate_rules.write`) and the audience usually
          differs (Ops Manager vs. tenant admin). */}
      <DuplicateRulesPanel />

      {/* Phase D3 — D3.7: SLA escalation rules. Reuses the core
          `tenant.settings.write` capability — the audience is Ops
          Manager / Account Manager / Super Admin (the same matrix
          that owns timezone / SLA window). */}
      <EscalationRulesPanel />

      {/* Phase 1A — A10: the legacy inline rules editor moved to
          /admin/distribution. Keep a visible deprecation pointer here
          so admins who deep-link or bookmark the old surface know
          where the controls went. */}
      <Notice tone="info">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-col leading-tight">
            <span className="text-sm font-semibold text-ink-primary">
              {t('distributionMoved.title')}
            </span>
            <span className="text-xs text-ink-secondary">{t('distributionMoved.body')}</span>
          </div>
          <Link
            href="/admin/distribution"
            className="inline-flex items-center gap-1 self-start text-sm font-medium text-brand-700 hover:text-brand-800 sm:self-auto"
          >
            {t('distributionMoved.cta')}
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </Notice>
    </div>
  );
}
