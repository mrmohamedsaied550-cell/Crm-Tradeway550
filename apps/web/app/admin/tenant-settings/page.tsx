'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { ApiError, tenantSettingsApi } from '@/lib/api';
import type { TenantSettingsRow } from '@/lib/api-types';

/**
 * P2-08 — tenant-level configuration:
 *   - timezone (IANA, e.g. "Africa/Cairo")
 *   - SLA window in minutes (1..1440)
 *   - default dial code (E.164 prefix)
 *
 * Reads `pipeline.read`-equivalent visibility (every CRM-touching role
 * has `tenant.settings.read`); the Save button is wired to
 * `tenant.settings.write` on the server, so non-admin users see the
 * form populated but get a 403 if they submit.
 */
export default function TenantSettingsPage(): JSX.Element {
  const t = useTranslations('admin.tenantSettings');

  const [row, setRow] = useState<TenantSettingsRow | null>(null);
  const [form, setForm] = useState<{
    timezone: string;
    slaMinutes: string;
    defaultDialCode: string;
  }>({ timezone: '', slaMinutes: '', defaultDialCode: '' });
  const [loading, setLoading] = useState<boolean>(true);
  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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
    setNotice(null);
    const minutes = Number.parseInt(form.slaMinutes, 10);
    try {
      const updated = await tenantSettingsApi.update({
        timezone: form.timezone.trim(),
        slaMinutes: Number.isFinite(minutes) ? minutes : undefined,
        defaultDialCode: form.defaultDialCode.trim(),
      });
      setRow(updated);
      setNotice(t('saved'));
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
      {notice ? <Notice tone="success">{notice}</Notice> : null}

      <form
        onSubmit={onSubmit}
        className="flex max-w-xl flex-col gap-4 rounded-lg border border-surface-border bg-surface-card p-4 shadow-card"
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
    </div>
  );
}
