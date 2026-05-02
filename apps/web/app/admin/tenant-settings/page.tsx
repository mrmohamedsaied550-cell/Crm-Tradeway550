'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Plus, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { useToast } from '@/components/ui/toast';
import { ApiError, tenantSettingsApi, usersApi } from '@/lib/api';
import type { AdminUser, DistributionRule, LeadSource, TenantSettingsRow } from '@/lib/api-types';

/**
 * P2-08 — tenant-level configuration:
 *   - timezone (IANA, e.g. "Africa/Cairo")
 *   - SLA window in minutes (1..1440)
 *   - default dial code (E.164 prefix)
 *
 * PL-3 (final-sprint) addition:
 *   - distribution rules: per-source overrides for the auto-assign
 *     path. Rule shape is `{source, assigneeUserId}`. When a rule
 *     matches the lead's source AND the named user is still
 *     active + sales-eligible, autoAssign routes there directly;
 *     otherwise it falls back to round-robin.
 *
 * Reads `pipeline.read`-equivalent visibility (every CRM-touching role
 * has `tenant.settings.read`); the Save button is wired to
 * `tenant.settings.write` on the server, so non-admin users see the
 * form populated but get a 403 if they submit.
 */

const SOURCES: readonly LeadSource[] = ['manual', 'meta', 'tiktok', 'whatsapp', 'import'] as const;

export default function TenantSettingsPage(): JSX.Element {
  const t = useTranslations('admin.tenantSettings');
  const { toast } = useToast();

  const [row, setRow] = useState<TenantSettingsRow | null>(null);
  const [form, setForm] = useState<{
    timezone: string;
    slaMinutes: string;
    defaultDialCode: string;
  }>({ timezone: '', slaMinutes: '', defaultDialCode: '' });
  const [rules, setRules] = useState<DistributionRule[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const [cur, page] = await Promise.all([
        tenantSettingsApi.get(),
        usersApi
          .list({ status: 'active', limit: 200 })
          .catch(() => ({ items: [] as AdminUser[], total: 0, limit: 200, offset: 0 })),
      ]);
      setRow(cur);
      setForm({
        timezone: cur.timezone,
        slaMinutes: String(cur.slaMinutes),
        defaultDialCode: cur.defaultDialCode,
      });
      setRules(cur.distributionRules ?? []);
      setUsers(page.items);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /**
   * PL-3 — sources NOT yet covered by a rule. Used to gate the
   * "Add rule" button: if every source already has a rule, adding
   * another would just trigger the duplicate-source server error.
   */
  const usedSources = new Set(rules.map((r) => r.source));
  const availableSources = SOURCES.filter((s) => !usedSources.has(s));

  function addRule(): void {
    if (availableSources.length === 0 || users.length === 0) return;
    setRules((prev) => [...prev, { source: availableSources[0]!, assigneeUserId: users[0]!.id }]);
  }

  function updateRule(index: number, patch: Partial<DistributionRule>): void {
    setRules((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  function removeRule(index: number): void {
    setRules((prev) => prev.filter((_, i) => i !== index));
  }

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
        distributionRules: rules,
      });
      setRow(updated);
      setRules(updated.distributionRules ?? []);
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

        {/* PL-3 — distribution rules */}
        <div className="flex flex-col gap-2 rounded-md border border-surface-border bg-surface p-3">
          <header className="flex items-start justify-between gap-2">
            <div className="flex flex-col leading-tight">
              <span className="text-sm font-semibold text-ink-primary">
                {t('distribution.title')}
              </span>
              <span className="text-xs text-ink-tertiary">{t('distribution.hint')}</span>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={addRule}
              disabled={loading || availableSources.length === 0 || users.length === 0}
              title={
                availableSources.length === 0
                  ? t('distribution.allCovered')
                  : users.length === 0
                    ? t('distribution.noUsers')
                    : undefined
              }
            >
              <Plus className="h-3.5 w-3.5" />
              {t('distribution.add')}
            </Button>
          </header>
          {rules.length === 0 ? (
            <p className="text-xs text-ink-tertiary">{t('distribution.empty')}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {rules.map((rule, i) => {
                // The "available for THIS rule" set must include the
                // source the rule already uses, otherwise the picker
                // can't show the current selection.
                const sourceOptions = SOURCES.filter(
                  (s) => s === rule.source || !usedSources.has(s),
                );
                return (
                  <li
                    key={i}
                    className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto]"
                  >
                    <Field label={t('distribution.source')}>
                      <Select
                        value={rule.source}
                        onChange={(e) => updateRule(i, { source: e.target.value as LeadSource })}
                      >
                        {sourceOptions.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label={t('distribution.assignee')}>
                      <Select
                        value={rule.assigneeUserId}
                        onChange={(e) => updateRule(i, { assigneeUserId: e.target.value })}
                      >
                        {users.map((u) => (
                          <option key={u.id} value={u.id}>
                            {u.name} — {u.email}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => removeRule(i)}
                      aria-label={t('distribution.remove')}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="text-xs text-ink-tertiary">{t('distribution.fallback')}</p>
        </div>

        <div className="flex items-center justify-end gap-2">
          <Button type="submit" loading={saving} disabled={loading || saving || row === null}>
            {t('save')}
          </Button>
        </div>
      </form>
    </div>
  );
}
