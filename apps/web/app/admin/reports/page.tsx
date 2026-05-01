'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Calendar, Contact, Loader2, TrendingUp, Trophy } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import {
  ApiError,
  companiesApi,
  countriesApi,
  reportsApi,
  teamsApi,
  type ReportFilters,
  type SummaryReport,
} from '@/lib/api';
import type { Company, Country, Team } from '@/lib/api-types';

/**
 * /admin/reports (C38) — manager dashboard.
 *
 * Single endpoint (`/reports/summary`) returns every count + the
 * leads-by-stage breakdown so the page is a one round-trip render.
 * Filters are client-side and re-fetch on submit.
 */

interface FormState {
  companyId: string;
  countryId: string;
  teamId: string;
  from: string;
  to: string;
}

const EMPTY_FORM: FormState = {
  companyId: '',
  countryId: '',
  teamId: '',
  from: '',
  to: '',
};

function toFilters(form: FormState): ReportFilters {
  return {
    ...(form.companyId ? { companyId: form.companyId } : {}),
    ...(form.countryId ? { countryId: form.countryId } : {}),
    ...(form.teamId ? { teamId: form.teamId } : {}),
    ...(form.from ? { from: new Date(`${form.from}T00:00:00Z`).toISOString() } : {}),
    ...(form.to ? { to: new Date(`${form.to}T23:59:59Z`).toISOString() } : {}),
  };
}

export default function AdminReportsPage(): JSX.Element {
  const t = useTranslations('admin.reports');
  const tCommon = useTranslations('admin.common');

  const [companies, setCompanies] = useState<Company[]>([]);
  const [countries, setCountries] = useState<Country[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [data, setData] = useState<SummaryReport | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(
    async (next: FormState = form): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        const summary = await reportsApi.summary(toFilters(next));
        setData(summary);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [form],
  );

  // First mount — load filter options + initial summary.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [c, ctry, ts, summary] = await Promise.all([
          companiesApi.list(),
          countriesApi.list(),
          teamsApi.list(),
          reportsApi.summary({}),
        ]);
        if (cancelled) return;
        setCompanies(c);
        setCountries(ctry);
        setTeams(ts);
        setData(summary);
      } catch (err) {
        if (!cancelled) setError(err instanceof ApiError ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const countriesForCompany = useMemo(
    () => countries.filter((c) => !form.companyId || c.companyId === form.companyId),
    [countries, form.companyId],
  );
  const teamsForCountry = useMemo(
    () => teams.filter((tm) => !form.countryId || tm.countryId === form.countryId),
    [teams, form.countryId],
  );

  // Find the largest stage count so the bar widths are normalized.
  const maxStage = useMemo(
    () => Math.max(1, ...(data?.leadsByStage.map((s) => s.count) ?? [0])),
    [data],
  );

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={t('title')} subtitle={t('subtitle')} />

      {error ? (
        <Notice tone="error">
          <div className="flex items-start justify-between gap-2">
            <span>{error}</span>
            <Button variant="ghost" size="sm" onClick={() => void reload()}>
              {tCommon('retry')}
            </Button>
          </div>
        </Notice>
      ) : null}

      {/* Filters */}
      <section className="grid grid-cols-1 gap-3 rounded-lg border border-surface-border bg-surface-card p-3 shadow-card sm:grid-cols-5">
        <Field label={t('filters.company')}>
          <Select
            value={form.companyId}
            onChange={(e) =>
              setForm({ ...form, companyId: e.target.value, countryId: '', teamId: '' })
            }
          >
            <option value="">—</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('filters.country')}>
          <Select
            value={form.countryId}
            onChange={(e) => setForm({ ...form, countryId: e.target.value, teamId: '' })}
            disabled={!form.companyId}
          >
            <option value="">—</option>
            {countriesForCompany.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('filters.team')}>
          <Select
            value={form.teamId}
            onChange={(e) => setForm({ ...form, teamId: e.target.value })}
            disabled={!form.countryId}
          >
            <option value="">—</option>
            {teamsForCountry.map((tm) => (
              <option key={tm.id} value={tm.id}>
                {tm.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('filters.from')}>
          <Input
            type="date"
            value={form.from}
            onChange={(e) => setForm({ ...form, from: e.target.value })}
          />
        </Field>
        <Field label={t('filters.to')}>
          <Input
            type="date"
            value={form.to}
            onChange={(e) => setForm({ ...form, to: e.target.value })}
          />
        </Field>
        <div className="flex items-end gap-2 sm:col-span-5">
          <Button onClick={() => void reload(form)} loading={loading}>
            {t('apply')}
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              setForm(EMPTY_FORM);
              void reload(EMPTY_FORM);
            }}
          >
            {tCommon('clearFilters')}
          </Button>
        </div>
      </section>

      {loading && !data ? (
        <div className="flex items-center justify-center gap-2 rounded-lg border border-surface-border bg-surface-card p-8 text-sm text-ink-secondary">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          {tCommon('loading')}
        </div>
      ) : data ? (
        <>
          {/* Cards */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <Card
              icon={<Contact className="h-4 w-4" aria-hidden="true" />}
              label={t('cards.totalLeads')}
              value={data.totalLeads}
            />
            <Card
              icon={<AlertTriangle className="h-4 w-4 text-status-breach" aria-hidden="true" />}
              label={t('cards.overdue')}
              value={data.overdueCount}
              tone="breach"
            />
            <Card
              icon={<Calendar className="h-4 w-4 text-status-warning" aria-hidden="true" />}
              label={t('cards.dueToday')}
              value={data.dueTodayCount}
              tone="warning"
            />
            <Card
              icon={<Trophy className="h-4 w-4" aria-hidden="true" />}
              label={t('cards.activations')}
              value={data.activations}
            />
            <Card
              icon={<TrendingUp className="h-4 w-4" aria-hidden="true" />}
              label={t('cards.conversion')}
              value={data.conversionRate === null ? '—' : `${data.conversionRate.toFixed(1)}%`}
            />
          </div>

          {/* Follow-ups summary */}
          <section className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Card
              icon={<Calendar className="h-4 w-4" aria-hidden="true" />}
              label={t('cards.followUpsPending')}
              value={data.followUpsPending}
            />
            <Card
              icon={<Calendar className="h-4 w-4" aria-hidden="true" />}
              label={t('cards.followUpsDone')}
              value={data.followUpsDone}
            />
          </section>

          {/* Leads by stage — simple bars */}
          <section className="rounded-lg border border-surface-border bg-surface-card p-4 shadow-card">
            <h2 className="text-base font-semibold text-ink-primary">{t('leadsByStage.title')}</h2>
            <p className="mt-1 text-xs text-ink-secondary">{t('leadsByStage.subtitle')}</p>
            {data.leadsByStage.length === 0 ? (
              <p className="mt-3 text-sm text-ink-tertiary">{t('leadsByStage.empty')}</p>
            ) : (
              <ul className="mt-4 flex flex-col gap-2">
                {data.leadsByStage.map((s) => (
                  <li key={s.stageCode} className="flex items-center gap-3">
                    <span className="w-32 shrink-0 text-xs font-medium text-ink-primary">
                      {s.stageName}
                    </span>
                    <div className="flex h-5 flex-1 items-center overflow-hidden rounded bg-surface">
                      <div
                        className="h-full bg-brand-600/70"
                        style={{ width: `${(s.count / maxStage) * 100}%` }}
                      />
                    </div>
                    <span className="w-12 shrink-0 text-end font-mono text-xs">{s.count}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}

interface CardProps {
  icon: React.ReactNode;
  label: string;
  value: number | string;
  tone?: 'breach' | 'warning';
}

function Card({ icon, label, value, tone }: CardProps): JSX.Element {
  const ring =
    tone === 'breach'
      ? 'border-status-breach/30 bg-status-breach/5'
      : tone === 'warning'
        ? 'border-status-warning/30 bg-status-warning/5'
        : 'border-surface-border bg-surface-card';
  return (
    <div className={`rounded-lg border p-4 shadow-card ${ring}`}>
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-ink-tertiary">
        {icon}
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold text-ink-primary">{value}</div>
    </div>
  );
}
