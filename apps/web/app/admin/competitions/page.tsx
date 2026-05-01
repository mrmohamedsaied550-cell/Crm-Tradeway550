'use client';

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Flag, Plus, Trophy } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataTable, type Column } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input, Select } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import {
  ApiError,
  competitionsApi,
  companiesApi,
  countriesApi,
  teamsApi,
  type CreateCompetitionInput,
  type LeaderboardEntry,
} from '@/lib/api';
import type {
  Competition,
  CompetitionMetric,
  CompetitionStatus,
  Company,
  Country,
  Team,
} from '@/lib/api-types';

const METRICS: readonly CompetitionMetric[] = [
  'leads_created',
  'activations',
  'first_trips',
  'conversion_rate',
];

const STATUSES: readonly CompetitionStatus[] = ['draft', 'active', 'closed'];

interface FormState extends CreateCompetitionInput {}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function inDaysIso(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

const EMPTY_FORM: FormState = {
  name: '',
  companyId: null,
  countryId: null,
  teamId: null,
  startDate: todayIso(),
  endDate: inDaysIso(14),
  metric: 'leads_created',
  reward: '',
  status: 'draft',
};

export default function CompetitionsPage(): JSX.Element {
  const t = useTranslations('admin.competitions');
  const tCommon = useTranslations('admin.common');

  const [rows, setRows] = useState<Competition[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [countries, setCountries] = useState<Country[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [editing, setEditing] = useState<Competition | null>(null);
  const [creating, setCreating] = useState<boolean>(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [boardFor, setBoardFor] = useState<Competition | null>(null);
  const [board, setBoard] = useState<LeaderboardEntry[]>([]);
  const [boardLoading, setBoardLoading] = useState<boolean>(false);

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const [list, c, ctry, ts] = await Promise.all([
        competitionsApi.list(),
        companiesApi.list(),
        countriesApi.list(),
        teamsApi.list(),
      ]);
      setRows(list);
      setCompanies(c);
      setCountries(ctry);
      setTeams(ts);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const countriesForCompany = useMemo(
    () => countries.filter((c) => !form.companyId || c.companyId === form.companyId),
    [countries, form.companyId],
  );

  const teamsForCountry = useMemo(
    () => teams.filter((tm) => !form.countryId || tm.countryId === form.countryId),
    [teams, form.countryId],
  );

  function openCreate(): void {
    setForm({ ...EMPTY_FORM });
    setFormError(null);
    setEditing(null);
    setCreating(true);
  }

  function openEdit(c: Competition): void {
    setForm({
      name: c.name,
      companyId: c.companyId,
      countryId: c.countryId,
      teamId: c.teamId,
      startDate: c.startDate.slice(0, 10),
      endDate: c.endDate.slice(0, 10),
      metric: c.metric,
      reward: c.reward,
      status: c.status,
    });
    setFormError(null);
    setEditing(c);
    setCreating(false);
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setSubmitting(true);
    setFormError(null);
    try {
      // ISO-fy the date inputs (yyyy-mm-dd → date-only ISO).
      const payload: CreateCompetitionInput = {
        ...form,
        startDate: new Date(`${form.startDate}T00:00:00Z`).toISOString(),
        endDate: new Date(`${form.endDate}T23:59:59Z`).toISOString(),
      };
      if (editing) {
        await competitionsApi.update(editing.id, payload);
        setNotice(t('updated'));
      } else {
        await competitionsApi.create(payload);
        setNotice(t('created'));
      }
      setCreating(false);
      setEditing(null);
      await reload();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function setStatus(c: Competition, status: CompetitionStatus): Promise<void> {
    setNotice(null);
    setError(null);
    try {
      await competitionsApi.setStatus(c.id, status);
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  async function openLeaderboard(c: Competition): Promise<void> {
    setBoardFor(c);
    setBoard([]);
    setBoardLoading(true);
    try {
      const items = await competitionsApi.leaderboard(c.id);
      setBoard(items);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBoardLoading(false);
    }
  }

  function statusTone(s: CompetitionStatus): 'healthy' | 'warning' | 'inactive' {
    if (s === 'active') return 'healthy';
    if (s === 'draft') return 'warning';
    return 'inactive';
  }

  const columns: ReadonlyArray<Column<Competition>> = [
    {
      key: 'name',
      header: t('cols.name'),
      render: (c) => <span className="font-medium text-ink-primary">{c.name}</span>,
    },
    {
      key: 'scope',
      header: t('cols.scope'),
      render: (c) => {
        const co = companies.find((x) => x.id === c.companyId);
        const ct = countries.find((x) => x.id === c.countryId);
        const tm = teams.find((x) => x.id === c.teamId);
        return (
          <span className="text-xs text-ink-secondary">
            {[co?.name, ct?.name, tm?.name].filter(Boolean).join(' · ') || '—'}
          </span>
        );
      },
    },
    {
      key: 'window',
      header: t('cols.window'),
      render: (c) => (
        <span className="text-xs">
          {c.startDate.slice(0, 10)} → {c.endDate.slice(0, 10)}
        </span>
      ),
    },
    {
      key: 'metric',
      header: t('cols.metric'),
      render: (c) => <span className="text-xs">{t(`metrics.${c.metric}`)}</span>,
    },
    {
      key: 'status',
      header: t('cols.status'),
      render: (c) => <Badge tone={statusTone(c.status)}>{t(`statuses.${c.status}`)}</Badge>,
    },
    {
      key: 'actions',
      header: t('cols.actions'),
      render: (c) => (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => openEdit(c)}>
            {tCommon('edit')}
          </Button>
          {c.status !== 'active' ? (
            <Button variant="ghost" size="sm" onClick={() => void setStatus(c, 'active')}>
              {t('actions.activate')}
            </Button>
          ) : null}
          {c.status !== 'closed' ? (
            <Button variant="ghost" size="sm" onClick={() => void setStatus(c, 'closed')}>
              {t('actions.close')}
            </Button>
          ) : null}
          <Button variant="ghost" size="sm" onClick={() => void openLeaderboard(c)}>
            <Trophy className="h-3.5 w-3.5" aria-hidden="true" />
            {t('actions.leaderboard')}
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          <Button onClick={openCreate}>
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            {t('createCta')}
          </Button>
        }
      />

      {notice ? <Notice tone="success">{notice}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}

      {loading ? (
        <p className="rounded-lg border border-surface-border bg-surface-card p-8 text-center text-sm text-ink-secondary">
          {tCommon('loading')}
        </p>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Flag className="h-7 w-7" aria-hidden="true" />}
          title={t('emptyTitle')}
          body={t('emptyBody')}
          action={<Button onClick={openCreate}>{t('createCta')}</Button>}
        />
      ) : (
        <DataTable<Competition> rows={rows} columns={columns} keyOf={(c) => c.id} />
      )}

      <Modal
        open={creating || editing !== null}
        title={editing ? t('editTitle') : t('createTitle')}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
        width="lg"
      >
        <form onSubmit={onSubmit} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {formError ? (
            <div className="sm:col-span-2">
              <Notice tone="error">{formError}</Notice>
            </div>
          ) : null}

          <div className="sm:col-span-2">
            <Field label={t('fields.name')} required>
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                required
              />
            </Field>
          </div>

          <Field label={t('fields.company')}>
            <Select
              value={form.companyId ?? ''}
              onChange={(e) =>
                setForm({
                  ...form,
                  companyId: e.target.value || null,
                  countryId: null,
                  teamId: null,
                })
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

          <Field label={t('fields.country')}>
            <Select
              value={form.countryId ?? ''}
              onChange={(e) =>
                setForm({ ...form, countryId: e.target.value || null, teamId: null })
              }
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

          <Field label={t('fields.team')}>
            <Select
              value={form.teamId ?? ''}
              onChange={(e) => setForm({ ...form, teamId: e.target.value || null })}
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

          <Field label={t('fields.metric')} required>
            <Select
              value={form.metric}
              onChange={(e) => setForm({ ...form, metric: e.target.value as CompetitionMetric })}
              required
            >
              {METRICS.map((m) => (
                <option key={m} value={m}>
                  {t(`metrics.${m}`)}
                </option>
              ))}
            </Select>
          </Field>

          <Field label={t('fields.startDate')} required>
            <Input
              type="date"
              value={form.startDate.slice(0, 10)}
              onChange={(e) => setForm({ ...form, startDate: e.target.value })}
              required
            />
          </Field>

          <Field label={t('fields.endDate')} required>
            <Input
              type="date"
              value={form.endDate.slice(0, 10)}
              onChange={(e) => setForm({ ...form, endDate: e.target.value })}
              required
            />
          </Field>

          <div className="sm:col-span-2">
            <Field label={t('fields.reward')} required>
              <Input
                value={form.reward}
                onChange={(e) => setForm({ ...form, reward: e.target.value })}
                required
              />
            </Field>
          </div>

          <Field label={t('fields.status')}>
            <Select
              value={form.status ?? 'draft'}
              onChange={(e) => setForm({ ...form, status: e.target.value as CompetitionStatus })}
            >
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(`statuses.${s}`)}
                </option>
              ))}
            </Select>
          </Field>

          <div className="flex items-center justify-end gap-2 sm:col-span-2">
            <Button
              variant="secondary"
              type="button"
              onClick={() => {
                setCreating(false);
                setEditing(null);
              }}
            >
              {tCommon('cancel')}
            </Button>
            <Button type="submit" loading={submitting}>
              {tCommon('save')}
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        open={boardFor !== null}
        title={`${t('leaderboardTitle')} — ${boardFor?.name ?? ''}`}
        onClose={() => setBoardFor(null)}
        width="md"
      >
        {boardLoading ? (
          <p className="text-sm text-ink-secondary">{tCommon('loading')}</p>
        ) : board.length === 0 ? (
          <p className="text-sm text-ink-secondary">{t('leaderboardEmpty')}</p>
        ) : (
          <ol className="flex flex-col divide-y divide-surface-border">
            {board.map((row, i) => (
              <li
                key={row.userId ?? `row-${i}`}
                className="flex items-center justify-between gap-3 py-2"
              >
                <div className="flex items-center gap-3">
                  <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-brand-50 text-xs font-semibold text-brand-700">
                    {i + 1}
                  </span>
                  <div className="flex flex-col leading-tight">
                    <span className="text-sm font-medium text-ink-primary">{row.name}</span>
                    {row.email ? (
                      <span className="text-xs text-ink-tertiary">{row.email}</span>
                    ) : null}
                  </div>
                </div>
                <span className="font-mono text-sm">{row.score}</span>
              </li>
            ))}
          </ol>
        )}
      </Modal>
    </div>
  );
}
