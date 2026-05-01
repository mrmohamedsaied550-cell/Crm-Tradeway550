'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  AlertTriangle,
  Calendar,
  Contact,
  Download,
  Loader2,
  TrendingUp,
  Trophy,
} from 'lucide-react';

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
  type TimeseriesMetric,
  type TimeseriesReport,
} from '@/lib/api';
import { getAccessToken } from '@/lib/auth';
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
  const [series, setSeries] = useState<TimeseriesReport | null>(null);
  const [metric, setMetric] = useState<TimeseriesMetric>('leads_created');
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState<boolean>(false);

  const reload = useCallback(
    async (next: FormState = form, nextMetric: TimeseriesMetric = metric): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        const filters = toFilters(next);
        const [summary, ts] = await Promise.all([
          reportsApi.summary(filters),
          reportsApi.timeseries({ ...filters, metric: nextMetric }),
        ]);
        setData(summary);
        setSeries(ts);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [form, metric],
  );

  /**
   * P2-11 — CSV export. We can't use a plain anchor `download` because
   * the server endpoint requires the JWT. So fetch with the bearer
   * header, blob the response, and trigger a synthetic <a> click.
   */
  async function downloadCsv(): Promise<void> {
    setExporting(true);
    setError(null);
    try {
      const url = reportsApi.exportCsvUrl(toFilters(form));
      const token = getAccessToken();
      const res = await fetch(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        cache: 'no-store',
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = `crm-report-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
    }
  }

  // First mount — load filter options + initial summary + timeseries.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [c, ctry, ts, summary, initialSeries] = await Promise.all([
          companiesApi.list(),
          countriesApi.list(),
          teamsApi.list(),
          reportsApi.summary({}),
          reportsApi.timeseries({ metric: 'leads_created' }),
        ]);
        if (cancelled) return;
        setCompanies(c);
        setCountries(ctry);
        setTeams(ts);
        setData(summary);
        setSeries(initialSeries);
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
          <div className="flex-1" />
          <Button variant="secondary" onClick={() => void downloadCsv()} loading={exporting}>
            <Download className="h-4 w-4" />
            {t('exportCsv')}
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

          {/* Time-series chart */}
          <section className="rounded-lg border border-surface-border bg-surface-card p-4 shadow-card">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-ink-primary">
                  {t('timeseries.title')}
                </h2>
                <p className="mt-1 text-xs text-ink-secondary">{t('timeseries.subtitle')}</p>
              </div>
              <div className="w-full max-w-xs">
                <Field label={t('timeseries.metric')}>
                  <Select
                    value={metric}
                    onChange={(e) => {
                      const m = e.target.value as TimeseriesMetric;
                      setMetric(m);
                      void reload(form, m);
                    }}
                  >
                    <option value="leads_created">{t('timeseries.metrics.leads_created')}</option>
                    <option value="activations">{t('timeseries.metrics.activations')}</option>
                    <option value="first_trips">{t('timeseries.metrics.first_trips')}</option>
                  </Select>
                </Field>
              </div>
            </div>
            <div className="mt-4">
              <TimeseriesChart series={series} emptyLabel={t('timeseries.empty')} />
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}

/**
 * Inline-SVG line chart. Deliberately minimal — no chart-lib
 * dependency, no animation. Renders the points along an X axis
 * spaced evenly per day, Y axis scaled to the max value (with a
 * minimum of 1 so a flat-zero series still draws an axis).
 *
 * Hover bubble: a circle marker per point, with a small tooltip
 * (`<title>`) so the SVG is screen-reader friendly without React
 * portals.
 */
function TimeseriesChart({
  series,
  emptyLabel,
}: {
  series: TimeseriesReport | null;
  emptyLabel: string;
}): JSX.Element {
  if (!series || series.points.length === 0) {
    return <p className="text-sm text-ink-tertiary">{emptyLabel}</p>;
  }
  const points = series.points;
  const max = Math.max(1, ...points.map((p) => p.count));
  const W = 720;
  const H = 200;
  const padX = 36;
  const padY = 24;
  const innerW = W - padX * 2;
  const innerH = H - padY * 2;
  const stepX = points.length > 1 ? innerW / (points.length - 1) : innerW / 2;
  const xy = points.map((p, i) => {
    const x = padX + (points.length === 1 ? innerW / 2 : i * stepX);
    const y = padY + innerH - (p.count / max) * innerH;
    return { x, y, p };
  });
  const linePath = xy
    .map(({ x, y }, i) => `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`)
    .join(' ');
  // Pick a few x-axis labels evenly so a 30-day chart isn't crammed.
  const labelStride = Math.max(1, Math.floor(points.length / 6));
  const total = points.reduce((acc, p) => acc + p.count, 0);
  return (
    <div className="overflow-x-auto">
      <svg
        role="img"
        aria-label="time-series chart"
        viewBox={`0 0 ${W} ${H}`}
        className="w-full min-w-[540px] max-w-full"
      >
        {/* Y axis ticks */}
        {[0, 0.5, 1].map((t) => {
          const y = padY + innerH * (1 - t);
          const label = Math.round(max * t);
          return (
            <g key={t}>
              <line x1={padX} y1={y} x2={W - padX / 2} y2={y} stroke="#e5e7eb" strokeWidth="1" />
              <text x={padX - 6} y={y + 3} textAnchor="end" fontSize="10" fill="#6b7280">
                {label}
              </text>
            </g>
          );
        })}
        {/* Line */}
        <path d={linePath} fill="none" stroke="#2563eb" strokeWidth="2" />
        {/* Markers */}
        {xy.map(({ x, y, p }) => (
          <circle key={p.date} cx={x} cy={y} r={2.5} fill="#2563eb">
            <title>{`${p.date} — ${p.count}`}</title>
          </circle>
        ))}
        {/* X axis labels */}
        {xy.map(({ x, p }, i) =>
          i % labelStride === 0 || i === xy.length - 1 ? (
            <text key={p.date} x={x} y={H - 6} textAnchor="middle" fontSize="10" fill="#6b7280">
              {p.date.slice(5)}
            </text>
          ) : null,
        )}
      </svg>
      <p className="mt-2 text-xs text-ink-tertiary">
        Σ {total} · {new Date(series.from).toISOString().slice(0, 10)} →{' '}
        {new Date(series.to).toISOString().slice(0, 10)}
      </p>
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
