'use client';

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Award, Plus } from 'lucide-react';

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
  bonusAccrualsApi,
  bonusesApi,
  companiesApi,
  countriesApi,
  teamsApi,
  type CreateBonusRuleInput,
} from '@/lib/api';
import type {
  BonusAccrual,
  BonusAccrualStatus,
  BonusRule,
  BonusType,
  Company,
  Country,
  Team,
} from '@/lib/api-types';

const BONUS_TYPES: readonly BonusType[] = [
  'first_trip',
  'activation',
  'trip_milestone',
  'conversion_rate',
  'manual',
];

interface FormState extends CreateBonusRuleInput {}

const EMPTY_FORM: FormState = {
  companyId: '',
  countryId: '',
  teamId: null,
  roleId: null,
  bonusType: 'first_trip',
  trigger: '',
  amount: '0',
  isActive: true,
};

export default function BonusesPage(): JSX.Element {
  const t = useTranslations('admin.bonuses');
  const tCommon = useTranslations('admin.common');

  const [rows, setRows] = useState<BonusRule[]>([]);
  const [accruals, setAccruals] = useState<BonusAccrual[]>([]);
  const [accrualStatusFilter, setAccrualStatusFilter] = useState<BonusAccrualStatus | 'all'>(
    'pending',
  );
  const [accrualBusy, setAccrualBusy] = useState<Set<string>>(new Set());
  const [companies, setCompanies] = useState<Company[]>([]);
  const [countries, setCountries] = useState<Country[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [editing, setEditing] = useState<BonusRule | null>(null);
  const [creating, setCreating] = useState<boolean>(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [formError, setFormError] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const [list, c, ctry, ts, acc] = await Promise.all([
        bonusesApi.list(),
        companiesApi.list(),
        countriesApi.list(),
        teamsApi.list(),
        bonusAccrualsApi
          .list(
            accrualStatusFilter === 'all'
              ? {}
              : { status: accrualStatusFilter as BonusAccrualStatus },
          )
          .catch(() => [] as BonusAccrual[]),
      ]);
      setRows(list);
      setCompanies(c);
      setCountries(ctry);
      setTeams(ts);
      setAccruals(acc);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [accrualStatusFilter]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function onAccrualStatus(id: string, status: BonusAccrualStatus): Promise<void> {
    if (accrualBusy.has(id)) return;
    setAccrualBusy((s) => new Set(s).add(id));
    setError(null);
    try {
      await bonusAccrualsApi.setStatus(id, status);
      setNotice(t('accruals.statusUpdated'));
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setAccrualBusy((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
    }
  }

  const countriesForCompany = useMemo(
    () => countries.filter((c) => !form.companyId || c.companyId === form.companyId),
    [countries, form.companyId],
  );

  const teamsForCountry = useMemo(
    () => teams.filter((t) => !form.countryId || t.countryId === form.countryId),
    [teams, form.countryId],
  );

  function openCreate(): void {
    const c0 = companies[0];
    const ctry0 = countries.find((c) => c.companyId === c0?.id);
    setForm({
      ...EMPTY_FORM,
      companyId: c0?.id ?? '',
      countryId: ctry0?.id ?? '',
    });
    setFormError(null);
    setEditing(null);
    setCreating(true);
  }

  function openEdit(b: BonusRule): void {
    setForm({
      companyId: b.companyId,
      countryId: b.countryId,
      teamId: b.teamId,
      roleId: b.roleId,
      bonusType: b.bonusType,
      trigger: b.trigger,
      amount: b.amount,
      isActive: b.isActive,
    });
    setFormError(null);
    setEditing(b);
    setCreating(false);
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setSubmitting(true);
    setFormError(null);
    try {
      if (editing) {
        await bonusesApi.update(editing.id, form);
        setNotice(t('updated'));
      } else {
        await bonusesApi.create(form);
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

  async function onToggle(b: BonusRule): Promise<void> {
    setNotice(null);
    setError(null);
    try {
      if (b.isActive) await bonusesApi.disable(b.id);
      else await bonusesApi.enable(b.id);
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  const columns: ReadonlyArray<Column<BonusRule>> = [
    {
      key: 'scope',
      header: t('cols.scope'),
      render: (b) => {
        const co = companies.find((c) => c.id === b.companyId);
        const ct = countries.find((c) => c.id === b.countryId);
        const tm = teams.find((t) => t.id === b.teamId);
        return (
          <div className="flex flex-col leading-tight text-xs">
            <span className="font-medium text-ink-primary">
              {co?.name ?? '—'} · {ct?.name ?? '—'}
            </span>
            <span className="text-ink-tertiary">{tm ? tm.name : t('teamAny')}</span>
          </div>
        );
      },
    },
    {
      key: 'type',
      header: t('cols.type'),
      render: (b) => (
        <span className="text-xs uppercase tracking-wide">{b.bonusType.replace(/_/g, ' ')}</span>
      ),
    },
    {
      key: 'trigger',
      header: t('cols.trigger'),
      render: (b) => <span className="text-sm">{b.trigger}</span>,
    },
    {
      key: 'amount',
      header: t('cols.amount'),
      render: (b) => <span className="font-mono text-sm">{Number(b.amount).toFixed(2)}</span>,
    },
    {
      key: 'status',
      header: t('cols.status'),
      render: (b) => (
        <Badge tone={b.isActive ? 'healthy' : 'inactive'}>
          {b.isActive ? t('statusActive') : t('statusInactive')}
        </Badge>
      ),
    },
    {
      key: 'actions',
      header: t('cols.actions'),
      render: (b) => (
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => openEdit(b)}>
            {tCommon('edit')}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void onToggle(b)}>
            {b.isActive ? t('actions.disable') : t('actions.enable')}
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
          icon={<Award className="h-7 w-7" aria-hidden="true" />}
          title={t('emptyTitle')}
          body={t('emptyBody')}
          action={<Button onClick={openCreate}>{t('createCta')}</Button>}
        />
      ) : (
        <DataTable<BonusRule> rows={rows} columns={columns} keyOf={(b) => b.id} />
      )}

      {/* P2-03 — accruals fired by the bonus engine */}
      <section className="rounded-lg border border-surface-border bg-surface-card shadow-card">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-surface-border px-3 py-2">
          <h2 className="text-sm font-semibold text-ink-primary">{t('accruals.title')}</h2>
          <div className="flex items-center gap-1.5">
            {(['pending', 'paid', 'void', 'all'] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setAccrualStatusFilter(s)}
                className={
                  s === accrualStatusFilter
                    ? 'rounded-md bg-brand-600 px-2.5 py-1 text-xs font-medium text-white'
                    : 'rounded-md border border-surface-border bg-surface px-2.5 py-1 text-xs font-medium text-ink-secondary hover:bg-brand-50 hover:text-brand-700'
                }
              >
                {t(`accruals.statuses.${s}`)}
              </button>
            ))}
          </div>
        </header>
        {accruals.length === 0 ? (
          <p className="p-4 text-center text-xs text-ink-tertiary">{t('accruals.empty')}</p>
        ) : (
          <ul className="divide-y divide-surface-border">
            {accruals.map((a) => (
              <li
                key={a.id}
                className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
              >
                <div className="flex flex-col leading-tight">
                  <span className="text-sm font-medium text-ink-primary">
                    {a.recipient?.name ?? a.recipientUserId.slice(0, 8)} ·{' '}
                    <span className="font-mono">{Number(a.amount).toFixed(2)}</span>
                  </span>
                  <span className="text-xs text-ink-tertiary">
                    {a.triggerKind} · {a.captain?.name ?? '—'}{' '}
                    {a.captain?.phone ? <code className="font-mono">{a.captain.phone}</code> : null}{' '}
                    · {new Date(a.createdAt).toLocaleString()}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <Badge
                    tone={
                      a.status === 'paid' ? 'healthy' : a.status === 'void' ? 'inactive' : 'warning'
                    }
                  >
                    {t(`accruals.statuses.${a.status}`)}
                  </Badge>
                  {a.status === 'pending' ? (
                    <>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void onAccrualStatus(a.id, 'paid')}
                        disabled={accrualBusy.has(a.id)}
                      >
                        {t('accruals.actions.markPaid')}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void onAccrualStatus(a.id, 'void')}
                        disabled={accrualBusy.has(a.id)}
                      >
                        {t('accruals.actions.void')}
                      </Button>
                    </>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

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

          <Field label={t('fields.company')} required>
            <Select
              value={form.companyId}
              onChange={(e) =>
                setForm({ ...form, companyId: e.target.value, countryId: '', teamId: null })
              }
              required
            >
              <option value="" disabled>
                {tCommon('select')}
              </option>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field label={t('fields.country')} required>
            <Select
              value={form.countryId}
              onChange={(e) => setForm({ ...form, countryId: e.target.value, teamId: null })}
              required
              disabled={!form.companyId}
            >
              <option value="" disabled>
                {tCommon('select')}
              </option>
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
              <option value="">{t('teamAny')}</option>
              {teamsForCountry.map((tm) => (
                <option key={tm.id} value={tm.id}>
                  {tm.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field label={t('fields.bonusType')} required>
            <Select
              value={form.bonusType}
              onChange={(e) => setForm({ ...form, bonusType: e.target.value as BonusType })}
              required
            >
              {BONUS_TYPES.map((bt) => (
                <option key={bt} value={bt}>
                  {bt.replace(/_/g, ' ')}
                </option>
              ))}
            </Select>
          </Field>

          <Field label={t('fields.trigger')} required>
            <Input
              value={form.trigger}
              onChange={(e) => setForm({ ...form, trigger: e.target.value })}
              placeholder={t('triggerPlaceholder')}
              required
            />
          </Field>

          <Field label={t('fields.amount')} required>
            <Input
              value={form.amount}
              onChange={(e) => setForm({ ...form, amount: e.target.value })}
              placeholder="100.00"
              required
            />
          </Field>

          <div className="flex items-center gap-2 sm:col-span-2">
            <input
              id="bonus-active"
              type="checkbox"
              checked={form.isActive ?? true}
              onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
            />
            <label htmlFor="bonus-active" className="text-sm">
              {t('fields.active')}
            </label>
          </div>

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
    </div>
  );
}
