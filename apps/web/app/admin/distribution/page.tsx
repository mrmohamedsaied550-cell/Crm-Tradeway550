'use client';

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Pencil, Plus, Trash2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataTable, type Column } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input, Select } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import {
  ApiError,
  companiesApi,
  countriesApi,
  distributionApi,
  teamsApi,
  usersApi,
  type CreateDistributionRuleInput,
  type UpsertAgentCapacityInput,
} from '@/lib/api';
import {
  ALL_DISTRIBUTION_STRATEGIES,
  type AdminUser,
  type AgentCapacityRow,
  type Company,
  type Country,
  type DistributionExclusionReason,
  type DistributionRuleRow,
  type DistributionStrategyName,
  type LeadRoutingLogRow,
  type LeadSource,
  type Team,
} from '@/lib/api-types';
import { hasCapability } from '@/lib/auth';

/**
 * /admin/distribution (Phase 1A — A9) — single admin surface for the
 * Distribution Engine. Three tabs:
 *   • Rules        — CRUD over distribution_rules in priority order.
 *   • Capacities   — per-user weight / availability / OOF / max active.
 *   • Logs         — read-only audit trail of routing decisions.
 *
 * Capability gates (mirrored server-side):
 *   • distribution.read  → tab visibility + reads
 *   • distribution.write → create/update/delete rules + capacity upserts
 *
 * The legacy inline rule editor on /admin/tenant-settings is being
 * deprecated (A10) — this page is the canonical surface.
 */

const SOURCES: readonly LeadSource[] = ['manual', 'meta', 'tiktok', 'whatsapp', 'import'] as const;

type TabKey = 'rules' | 'capacities' | 'logs';

export default function DistributionPage(): JSX.Element {
  const t = useTranslations('admin.distributionPage');
  const tCommon = useTranslations('admin.common');
  const canRead = hasCapability('distribution.read');
  const canWrite = hasCapability('distribution.write');

  const [tab, setTab] = useState<TabKey>('rules');

  // Shared lookups — every tab needs a user list, the rule form also
  // needs companies / countries / teams. Loaded once on mount and
  // passed down to the tab subviews.
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [countries, setCountries] = useState<Country[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [lookupsLoaded, setLookupsLoaded] = useState<boolean>(false);

  useEffect(() => {
    if (!canRead) return;
    void (async () => {
      const [u, c, co, tm] = await Promise.all([
        usersApi
          .list({ limit: 200 })
          .catch(() => ({ items: [] as AdminUser[], total: 0, limit: 200, offset: 0 })),
        companiesApi.list().catch(() => [] as Company[]),
        countriesApi.list().catch(() => [] as Country[]),
        teamsApi.list().catch(() => [] as Team[]),
      ]);
      setUsers(u.items);
      setCompanies(c);
      setCountries(co);
      setTeams(tm);
      setLookupsLoaded(true);
    })();
  }, [canRead]);

  if (!canRead) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title={t('title')} subtitle={t('subtitle')} />
        <Notice tone="error">{t('noAccess')}</Notice>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={t('title')} subtitle={t('subtitle')} />

      <div className="flex border-b border-surface-border">
        {(['rules', 'capacities', 'logs'] as const).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={cn(
              'border-b-2 px-3 py-2 text-sm font-medium',
              tab === key
                ? 'border-brand-500 text-brand-700'
                : 'border-transparent text-ink-secondary hover:text-ink-primary',
            )}
          >
            {t(`tabs.${key}`)}
          </button>
        ))}
      </div>

      {tab === 'rules' ? (
        <RulesTab
          canWrite={canWrite}
          users={users}
          companies={companies}
          countries={countries}
          teams={teams}
          lookupsLoaded={lookupsLoaded}
          t={t}
          tCommon={tCommon}
        />
      ) : null}

      {tab === 'capacities' ? (
        <CapacitiesTab
          canWrite={canWrite}
          users={users}
          lookupsLoaded={lookupsLoaded}
          t={t}
          tCommon={tCommon}
        />
      ) : null}

      {tab === 'logs' ? (
        <LogsTab users={users} lookupsLoaded={lookupsLoaded} t={t} tCommon={tCommon} />
      ) : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Rules tab
// ─────────────────────────────────────────────────────────────────────

interface RuleFormState {
  name: string;
  isActive: boolean;
  priority: string; // string-bound for the input; coerced on submit
  source: '' | LeadSource;
  companyId: string;
  countryId: string;
  targetTeamId: string;
  strategy: DistributionStrategyName;
  targetUserId: string;
}

const EMPTY_RULE_FORM: RuleFormState = {
  name: '',
  isActive: true,
  priority: '100',
  source: '',
  companyId: '',
  countryId: '',
  targetTeamId: '',
  strategy: 'round_robin',
  targetUserId: '',
};

interface RulesTabProps {
  canWrite: boolean;
  users: readonly AdminUser[];
  companies: readonly Company[];
  countries: readonly Country[];
  teams: readonly Team[];
  lookupsLoaded: boolean;
  t: ReturnType<typeof useTranslations>;
  tCommon: ReturnType<typeof useTranslations>;
}

function RulesTab({
  canWrite,
  users,
  companies,
  countries,
  teams,
  lookupsLoaded,
  t,
  tCommon,
}: RulesTabProps): JSX.Element {
  const { toast } = useToast();
  const [rows, setRows] = useState<DistributionRuleRow[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const [open, setOpen] = useState<boolean>(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<RuleFormState>(EMPTY_RULE_FORM);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [formError, setFormError] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const items = await distributionApi.rules.list();
      setRows(items);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const userById = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);
  const companyById = useMemo(() => new Map(companies.map((c) => [c.id, c])), [companies]);
  const countryById = useMemo(() => new Map(countries.map((c) => [c.id, c])), [countries]);
  const teamById = useMemo(() => new Map(teams.map((t2) => [t2.id, t2])), [teams]);

  function openCreate(): void {
    setEditingId(null);
    setForm(EMPTY_RULE_FORM);
    setFormError(null);
    setOpen(true);
  }

  function openEdit(row: DistributionRuleRow): void {
    setEditingId(row.id);
    setForm({
      name: row.name,
      isActive: row.isActive,
      priority: String(row.priority),
      source: row.source ?? '',
      companyId: row.companyId ?? '',
      countryId: row.countryId ?? '',
      targetTeamId: row.targetTeamId ?? '',
      strategy: row.strategy,
      targetUserId: row.targetUserId ?? '',
    });
    setFormError(null);
    setOpen(true);
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setFormError(null);

    const trimmedName = form.name.trim();
    if (!trimmedName) {
      setFormError(t('rules.errors.nameRequired'));
      return;
    }
    const priorityNum = Number(form.priority);
    if (!Number.isFinite(priorityNum) || priorityNum < 1 || priorityNum > 1000) {
      setFormError(t('rules.errors.priorityRange'));
      return;
    }
    if (form.strategy === 'specific_user' && !form.targetUserId) {
      setFormError(t('rules.errors.targetUserRequired'));
      return;
    }
    if (form.strategy !== 'specific_user' && form.targetUserId) {
      setFormError(t('rules.errors.targetUserOnlyForSpecific'));
      return;
    }

    const body: CreateDistributionRuleInput = {
      name: trimmedName,
      isActive: form.isActive,
      priority: priorityNum,
      source: form.source === '' ? null : form.source,
      companyId: form.companyId || null,
      countryId: form.countryId || null,
      targetTeamId: form.targetTeamId || null,
      strategy: form.strategy,
      targetUserId: form.targetUserId || null,
    };

    setSubmitting(true);
    try {
      if (editingId) {
        await distributionApi.rules.update(editingId, body);
        toast({ tone: 'success', title: t('rules.updated') });
      } else {
        await distributionApi.rules.create(body);
        toast({ tone: 'success', title: t('rules.created') });
      }
      setOpen(false);
      await reload();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function onDelete(row: DistributionRuleRow): Promise<void> {
    if (!window.confirm(t('rules.confirmDelete', { name: row.name }))) return;
    try {
      await distributionApi.rules.remove(row.id);
      toast({ tone: 'success', title: t('rules.deleted') });
      await reload();
    } catch (err) {
      toast({ tone: 'error', title: err instanceof ApiError ? err.message : String(err) });
    }
  }

  const columns: ReadonlyArray<Column<DistributionRuleRow>> = useMemo(
    () => [
      {
        key: 'priority',
        header: t('rules.cols.priority'),
        className: 'w-16 text-center',
        render: (r) => <span className="font-mono text-xs">{r.priority}</span>,
      },
      {
        key: 'name',
        header: t('rules.cols.name'),
        render: (r) => (
          <div className="flex flex-col leading-tight">
            <span className="font-medium text-ink-primary">{r.name}</span>
            <span className="text-xs text-ink-tertiary">
              {r.isActive ? t('rules.statusActive') : t('rules.statusInactive')}
            </span>
          </div>
        ),
      },
      {
        key: 'conditions',
        header: t('rules.cols.conditions'),
        render: (r) => {
          const parts: string[] = [];
          if (r.source) parts.push(`${t('rules.field.source')}=${r.source}`);
          if (r.companyId)
            parts.push(
              `${t('rules.field.company')}=${companyById.get(r.companyId)?.name ?? r.companyId.slice(0, 8)}`,
            );
          if (r.countryId)
            parts.push(
              `${t('rules.field.country')}=${countryById.get(r.countryId)?.name ?? r.countryId.slice(0, 8)}`,
            );
          if (r.targetTeamId)
            parts.push(
              `${t('rules.field.team')}=${teamById.get(r.targetTeamId)?.name ?? r.targetTeamId.slice(0, 8)}`,
            );
          return parts.length === 0 ? (
            <span className="text-xs text-ink-tertiary">{t('rules.matchesAll')}</span>
          ) : (
            <span className="text-xs">{parts.join(' · ')}</span>
          );
        },
      },
      {
        key: 'strategy',
        header: t('rules.cols.strategy'),
        render: (r) => (
          <div className="flex flex-col gap-0.5 leading-tight">
            <span className="text-xs font-medium uppercase">{r.strategy}</span>
            {r.strategy === 'specific_user' && r.targetUserId ? (
              <span className="text-xs text-ink-tertiary">
                → {userById.get(r.targetUserId)?.name ?? r.targetUserId.slice(0, 8)}
              </span>
            ) : null}
          </div>
        ),
      },
      {
        key: 'status',
        header: t('rules.cols.status'),
        render: (r) =>
          r.isActive ? (
            <Badge tone="healthy">{t('rules.statusActive')}</Badge>
          ) : (
            <Badge tone="inactive">{t('rules.statusInactive')}</Badge>
          ),
      },
    ],
    [t, userById, companyById, countryById, teamById],
  );

  // The form's country dropdown is filtered by selected company so
  // admins can't pick a country/company combination that doesn't exist.
  const countriesForCompany = useMemo(() => {
    if (!form.companyId) return countries;
    return countries.filter((c) => c.companyId === form.companyId);
  }, [countries, form.companyId]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-ink-secondary">{t('rules.intro')}</p>
        {canWrite ? (
          <Button onClick={openCreate} disabled={!lookupsLoaded}>
            <Plus className="h-4 w-4" />
            {t('rules.newButton')}
          </Button>
        ) : null}
      </div>

      {error ? (
        <Notice tone="error">
          <div className="flex items-start justify-between gap-3">
            <span>{error}</span>
            <Button variant="ghost" size="sm" onClick={() => void reload()}>
              {tCommon('retry')}
            </Button>
          </div>
        </Notice>
      ) : null}

      {!loading && rows.length === 0 ? (
        <EmptyState
          title={t('rules.empty')}
          body={t('rules.emptyHint')}
          action={
            canWrite ? (
              <Button variant="secondary" size="sm" onClick={openCreate}>
                <Plus className="h-4 w-4" />
                {t('rules.newButton')}
              </Button>
            ) : null
          }
        />
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          keyOf={(r) => r.id}
          loading={loading}
          skeletonRows={4}
          rowActions={(row) =>
            canWrite ? (
              <>
                <Button variant="ghost" size="sm" onClick={() => openEdit(row)}>
                  <Pencil className="h-3.5 w-3.5" />
                  {t('rules.edit')}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => void onDelete(row)}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </>
            ) : null
          }
        />
      )}

      <Modal
        open={open}
        title={editingId ? t('rules.editTitle') : t('rules.newTitle')}
        onClose={() => setOpen(false)}
        width="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {tCommon('cancel')}
            </Button>
            <Button type="submit" form="distributionRuleForm" loading={submitting}>
              {tCommon('save')}
            </Button>
          </>
        }
      >
        <form id="distributionRuleForm" className="flex flex-col gap-3" onSubmit={onSubmit}>
          {formError ? <Notice tone="error">{formError}</Notice> : null}

          <Field label={t('rules.form.name')} required>
            <Input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              required
              maxLength={120}
              placeholder={t('rules.form.namePlaceholder')}
            />
          </Field>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={t('rules.form.priority')} required hint={t('rules.form.priorityHint')}>
              <Input
                type="number"
                min={1}
                max={1000}
                value={form.priority}
                onChange={(e) => setForm((f) => ({ ...f, priority: e.target.value }))}
                required
              />
            </Field>
            <Field label={t('rules.form.isActive')}>
              <label className="flex h-9 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.isActive}
                  onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))}
                />
                {t('rules.form.isActiveLabel')}
              </label>
            </Field>
          </div>

          <fieldset className="flex flex-col gap-3 rounded-md border border-surface-border p-3">
            <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-ink-secondary">
              {t('rules.form.conditions')}
            </legend>
            <p className="text-xs text-ink-tertiary">{t('rules.form.conditionsHint')}</p>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label={t('rules.form.source')}>
                <Select
                  value={form.source}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, source: e.target.value as '' | LeadSource }))
                  }
                >
                  <option value="">{t('rules.form.anySource')}</option>
                  {SOURCES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label={t('rules.form.company')}>
                <Select
                  value={form.companyId}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      companyId: e.target.value,
                      // Drop the country if it no longer matches the new company.
                      countryId: '',
                    }))
                  }
                >
                  <option value="">{t('rules.form.anyCompany')}</option>
                  {companies.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label={t('rules.form.country')}>
                <Select
                  value={form.countryId}
                  onChange={(e) => setForm((f) => ({ ...f, countryId: e.target.value }))}
                >
                  <option value="">{t('rules.form.anyCountry')}</option>
                  {countriesForCompany.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label={t('rules.form.team')}>
                <Select
                  value={form.targetTeamId}
                  onChange={(e) => setForm((f) => ({ ...f, targetTeamId: e.target.value }))}
                >
                  <option value="">{t('rules.form.anyTeam')}</option>
                  {teams.map((tm) => (
                    <option key={tm.id} value={tm.id}>
                      {tm.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          </fieldset>

          <fieldset className="flex flex-col gap-3 rounded-md border border-surface-border p-3">
            <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-ink-secondary">
              {t('rules.form.strategySection')}
            </legend>

            <Field label={t('rules.form.strategy')} required hint={t('rules.form.strategyHint')}>
              <Select
                value={form.strategy}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    strategy: e.target.value as DistributionStrategyName,
                    // Clear target user when leaving specific_user.
                    targetUserId:
                      (e.target.value as DistributionStrategyName) === 'specific_user'
                        ? f.targetUserId
                        : '',
                  }))
                }
                required
              >
                {ALL_DISTRIBUTION_STRATEGIES.map((s) => (
                  <option key={s} value={s}>
                    {t(`rules.strategy.${s}`)}
                  </option>
                ))}
              </Select>
            </Field>

            {form.strategy === 'specific_user' ? (
              <Field
                label={t('rules.form.targetUser')}
                required
                hint={t('rules.form.targetUserHint')}
              >
                <Select
                  value={form.targetUserId}
                  onChange={(e) => setForm((f) => ({ ...f, targetUserId: e.target.value }))}
                  required
                >
                  <option value="">{tCommon('select')}</option>
                  {users
                    .filter((u) => u.status === 'active')
                    .map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name} ({u.email})
                      </option>
                    ))}
                </Select>
              </Field>
            ) : null}
          </fieldset>
        </form>
      </Modal>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Capacities tab
// ─────────────────────────────────────────────────────────────────────

interface CapacityFormState {
  weight: string;
  isAvailable: boolean;
  outOfOfficeUntil: string; // datetime-local; '' clears
  maxActiveLeads: string; // '' = no cap
}

interface CapacitiesTabProps {
  canWrite: boolean;
  users: readonly AdminUser[];
  lookupsLoaded: boolean;
  t: ReturnType<typeof useTranslations>;
  tCommon: ReturnType<typeof useTranslations>;
}

function CapacitiesTab({
  canWrite,
  users,
  lookupsLoaded,
  t,
  tCommon,
}: CapacitiesTabProps): JSX.Element {
  const { toast } = useToast();
  const [rows, setRows] = useState<AgentCapacityRow[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const [open, setOpen] = useState<boolean>(false);
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [form, setForm] = useState<CapacityFormState>({
    weight: '10',
    isAvailable: true,
    outOfOfficeUntil: '',
    maxActiveLeads: '',
  });
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [formError, setFormError] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const items = await distributionApi.capacities.list();
      setRows(items);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const capByUser = useMemo(() => new Map(rows.map((r) => [r.userId, r])), [rows]);

  // Joined view: every active user, with their capacity (or defaults
  // implied: weight=10, available=true, no cap, no OOF).
  const joined = useMemo(
    () =>
      users
        .filter((u) => u.status === 'active')
        .map((u) => ({
          user: u,
          cap: capByUser.get(u.id) ?? null,
        })),
    [users, capByUser],
  );

  function openEditFor(userId: string, existing: AgentCapacityRow | null): void {
    setEditingUserId(userId);
    setForm({
      weight: String(existing?.weight ?? 10),
      isAvailable: existing?.isAvailable ?? true,
      outOfOfficeUntil: existing?.outOfOfficeUntil
        ? // Convert ISO → "YYYY-MM-DDTHH:MM" for <input type="datetime-local">.
          existing.outOfOfficeUntil.slice(0, 16)
        : '',
      maxActiveLeads:
        existing?.maxActiveLeads === null || existing?.maxActiveLeads === undefined
          ? ''
          : String(existing.maxActiveLeads),
    });
    setFormError(null);
    setOpen(true);
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (!editingUserId) return;
    setFormError(null);

    const weightNum = Number(form.weight);
    if (!Number.isFinite(weightNum) || weightNum < 0 || weightNum > 100) {
      setFormError(t('capacities.errors.weightRange'));
      return;
    }
    let maxActiveLeads: number | null = null;
    if (form.maxActiveLeads.trim() !== '') {
      const n = Number(form.maxActiveLeads);
      if (!Number.isFinite(n) || n < 0 || n > 10_000) {
        setFormError(t('capacities.errors.maxActiveRange'));
        return;
      }
      maxActiveLeads = n;
    }
    let outOfOfficeUntil: string | null = null;
    if (form.outOfOfficeUntil.trim() !== '') {
      // datetime-local omits seconds + tz; round-trip through Date for ISO output.
      const d = new Date(form.outOfOfficeUntil);
      if (Number.isNaN(d.getTime())) {
        setFormError(t('capacities.errors.oofInvalid'));
        return;
      }
      outOfOfficeUntil = d.toISOString();
    }

    const body: UpsertAgentCapacityInput = {
      weight: weightNum,
      isAvailable: form.isAvailable,
      outOfOfficeUntil,
      maxActiveLeads,
    };

    setSubmitting(true);
    try {
      await distributionApi.capacities.upsert(editingUserId, body);
      toast({ tone: 'success', title: t('capacities.saved') });
      setOpen(false);
      await reload();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  const editingUser = users.find((u) => u.id === editingUserId) ?? null;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-ink-secondary">{t('capacities.intro')}</p>

      {error ? (
        <Notice tone="error">
          <div className="flex items-start justify-between gap-3">
            <span>{error}</span>
            <Button variant="ghost" size="sm" onClick={() => void reload()}>
              {tCommon('retry')}
            </Button>
          </div>
        </Notice>
      ) : null}

      <DataTable<{ user: AdminUser; cap: AgentCapacityRow | null }>
        columns={[
          {
            key: 'name',
            header: t('capacities.cols.user'),
            render: (r) => (
              <div className="flex flex-col leading-tight">
                <span className="font-medium text-ink-primary">{r.user.name}</span>
                <span className="text-xs text-ink-tertiary">{r.user.email}</span>
              </div>
            ),
          },
          {
            key: 'weight',
            header: t('capacities.cols.weight'),
            className: 'w-20 text-center',
            render: (r) => <span className="font-mono text-xs">{r.cap?.weight ?? 10}</span>,
          },
          {
            key: 'maxActive',
            header: t('capacities.cols.maxActive'),
            className: 'w-28 text-center',
            render: (r) =>
              r.cap?.maxActiveLeads === null || r.cap?.maxActiveLeads === undefined ? (
                <span className="text-xs text-ink-tertiary">{t('capacities.noCap')}</span>
              ) : (
                <span className="font-mono text-xs">{r.cap.maxActiveLeads}</span>
              ),
          },
          {
            key: 'oof',
            header: t('capacities.cols.oof'),
            render: (r) =>
              r.cap?.outOfOfficeUntil ? (
                <span className="text-xs">{new Date(r.cap.outOfOfficeUntil).toLocaleString()}</span>
              ) : (
                <span className="text-xs text-ink-tertiary">—</span>
              ),
          },
          {
            key: 'available',
            header: t('capacities.cols.availability'),
            className: 'w-32',
            render: (r) =>
              r.cap?.isAvailable === false ? (
                <Badge tone="inactive">{t('capacities.unavailable')}</Badge>
              ) : (
                <Badge tone="healthy">{t('capacities.available')}</Badge>
              ),
          },
        ]}
        rows={joined}
        keyOf={(r) => r.user.id}
        loading={loading || !lookupsLoaded}
        skeletonRows={6}
        emptyMessage={t('capacities.empty')}
        rowActions={(r) =>
          canWrite ? (
            <Button variant="ghost" size="sm" onClick={() => openEditFor(r.user.id, r.cap)}>
              <Pencil className="h-3.5 w-3.5" />
              {t('capacities.edit')}
            </Button>
          ) : null
        }
      />

      <Modal
        open={open}
        title={editingUser ? t('capacities.editTitle', { name: editingUser.name }) : ''}
        onClose={() => setOpen(false)}
        width="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {tCommon('cancel')}
            </Button>
            <Button type="submit" form="capacityForm" loading={submitting}>
              {tCommon('save')}
            </Button>
          </>
        }
      >
        <form id="capacityForm" className="flex flex-col gap-3" onSubmit={onSubmit}>
          {formError ? <Notice tone="error">{formError}</Notice> : null}

          <Field
            label={t('capacities.form.weight')}
            required
            hint={t('capacities.form.weightHint')}
          >
            <Input
              type="number"
              min={0}
              max={100}
              value={form.weight}
              onChange={(e) => setForm((f) => ({ ...f, weight: e.target.value }))}
              required
            />
          </Field>

          <Field label={t('capacities.form.maxActive')} hint={t('capacities.form.maxActiveHint')}>
            <Input
              type="number"
              min={0}
              max={10000}
              value={form.maxActiveLeads}
              onChange={(e) => setForm((f) => ({ ...f, maxActiveLeads: e.target.value }))}
              placeholder={t('capacities.form.maxActivePlaceholder')}
            />
          </Field>

          <Field label={t('capacities.form.oof')} hint={t('capacities.form.oofHint')}>
            <Input
              type="datetime-local"
              value={form.outOfOfficeUntil}
              onChange={(e) => setForm((f) => ({ ...f, outOfOfficeUntil: e.target.value }))}
            />
          </Field>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.isAvailable}
              onChange={(e) => setForm((f) => ({ ...f, isAvailable: e.target.checked }))}
            />
            {t('capacities.form.isAvailable')}
          </label>
        </form>
      </Modal>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Logs tab
// ─────────────────────────────────────────────────────────────────────

interface LogsTabProps {
  users: readonly AdminUser[];
  lookupsLoaded: boolean;
  t: ReturnType<typeof useTranslations>;
  tCommon: ReturnType<typeof useTranslations>;
}

function LogsTab({ users, t, tCommon }: LogsTabProps): JSX.Element {
  const [filterLeadId, setFilterLeadId] = useState<string>('');
  const [filterFrom, setFilterFrom] = useState<string>('');
  const [filterLimit, setFilterLimit] = useState<string>('50');

  const [rows, setRows] = useState<LeadRoutingLogRow[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const limitNum = Number(filterLimit);
      const items = await distributionApi.logs.list({
        ...(filterLeadId.trim() && { leadId: filterLeadId.trim() }),
        ...(filterFrom.trim() && { from: new Date(filterFrom).toISOString() }),
        ...(Number.isFinite(limitNum) && limitNum > 0 ? { limit: Math.min(limitNum, 200) } : {}),
      });
      setRows(items);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [filterLeadId, filterFrom, filterLimit]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const userById = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);

  function userLabel(id: string | null): string {
    if (!id) return '—';
    const u = userById.get(id);
    return u ? `${u.name}` : id.slice(0, 8);
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-ink-secondary">{t('logs.intro')}</p>

      <div className="flex flex-wrap items-end gap-3 rounded-md border border-surface-border bg-surface-card p-3">
        <Field label={t('logs.filter.leadId')}>
          <Input
            value={filterLeadId}
            onChange={(e) => setFilterLeadId(e.target.value)}
            placeholder={t('logs.filter.leadIdPlaceholder')}
            className="w-72"
          />
        </Field>
        <Field label={t('logs.filter.from')}>
          <Input
            type="datetime-local"
            value={filterFrom}
            onChange={(e) => setFilterFrom(e.target.value)}
          />
        </Field>
        <Field label={t('logs.filter.limit')}>
          <Input
            type="number"
            min={1}
            max={200}
            value={filterLimit}
            onChange={(e) => setFilterLimit(e.target.value)}
            className="w-24"
          />
        </Field>
        <Button variant="secondary" size="sm" onClick={() => void reload()}>
          {tCommon('filter')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setFilterLeadId('');
            setFilterFrom('');
            setFilterLimit('50');
          }}
        >
          {tCommon('clearFilters')}
        </Button>
      </div>

      {error ? (
        <Notice tone="error">
          <div className="flex items-start justify-between gap-3">
            <span>{error}</span>
            <Button variant="ghost" size="sm" onClick={() => void reload()}>
              {tCommon('retry')}
            </Button>
          </div>
        </Notice>
      ) : null}

      {!loading && rows.length === 0 ? (
        <EmptyState title={t('logs.empty')} body={t('logs.emptyHint')} />
      ) : (
        <div className="overflow-hidden rounded-lg border border-surface-border bg-surface-card shadow-card">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-surface-border text-sm">
              <thead className="bg-surface text-xs uppercase tracking-wide text-ink-secondary">
                <tr>
                  <th className="px-4 py-2 text-start font-medium">{t('logs.cols.decidedAt')}</th>
                  <th className="px-4 py-2 text-start font-medium">{t('logs.cols.lead')}</th>
                  <th className="px-4 py-2 text-start font-medium">{t('logs.cols.strategy')}</th>
                  <th className="px-4 py-2 text-start font-medium">{t('logs.cols.assigned')}</th>
                  <th className="px-4 py-2 text-center font-medium">{t('logs.cols.candidates')}</th>
                  <th className="px-4 py-2 text-center font-medium">{t('logs.cols.excluded')}</th>
                  <th className="w-20 px-4 py-2 text-end font-medium">&nbsp;</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border">
                {loading
                  ? Array.from({ length: 5 }).map((_, i) => (
                      <tr key={`__skeleton_${i}`} aria-hidden="true">
                        <td colSpan={7} className="px-4 py-3">
                          <span className="block h-3 w-full animate-pulse rounded bg-surface-border/60" />
                        </td>
                      </tr>
                    ))
                  : rows.flatMap((r) => {
                      const expanded = expandedId === r.id;
                      const reasonEntries = Object.entries(r.excludedReasons);
                      const main = (
                        <tr key={r.id} className="hover:bg-brand-50/40">
                          <td className="px-4 py-2 align-middle">
                            <span className="text-xs">
                              {new Date(r.decidedAt).toLocaleString()}
                            </span>
                          </td>
                          <td className="px-4 py-2 align-middle">
                            <span className="font-mono text-xs text-ink-secondary">
                              {r.leadId.slice(0, 8)}
                            </span>
                          </td>
                          <td className="px-4 py-2 align-middle">
                            <span className="text-xs font-medium uppercase">{r.strategy}</span>
                          </td>
                          <td className="px-4 py-2 align-middle">
                            {r.chosenUserId ? (
                              <span className="text-xs">{userLabel(r.chosenUserId)}</span>
                            ) : (
                              <Badge tone="warning">{t('logs.unassigned')}</Badge>
                            )}
                          </td>
                          <td className="px-4 py-2 text-center align-middle">
                            <span className="font-mono text-xs">{r.candidateCount}</span>
                          </td>
                          <td className="px-4 py-2 text-center align-middle">
                            <span className="font-mono text-xs">{r.excludedCount}</span>
                          </td>
                          <td className="px-4 py-2 text-end align-middle">
                            {reasonEntries.length > 0 ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setExpandedId(expanded ? null : r.id)}
                              >
                                {expanded ? t('logs.hide') : t('logs.show')}
                              </Button>
                            ) : null}
                          </td>
                        </tr>
                      );
                      if (!expanded || reasonEntries.length === 0) return [main];
                      const detail = (
                        <tr key={`${r.id}__detail`} className="bg-surface/60">
                          <td colSpan={7} className="px-4 py-3">
                            <div className="flex flex-col gap-1.5">
                              <span className="text-xs font-semibold uppercase tracking-wide text-ink-secondary">
                                {t('logs.exclusionsTitle')}
                              </span>
                              <ul className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                                {reasonEntries.map(([uid, reason]) => (
                                  <li
                                    key={uid}
                                    className="flex items-center justify-between gap-3 rounded border border-surface-border bg-surface-card px-2 py-1 text-xs"
                                  >
                                    <span>{userLabel(uid)}</span>
                                    <Badge tone={reasonTone(reason)}>
                                      {t(`logs.reasons.${reason}`)}
                                    </Badge>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          </td>
                        </tr>
                      );
                      return [main, detail];
                    })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function reasonTone(reason: DistributionExclusionReason): 'warning' | 'inactive' | 'breach' {
  switch (reason) {
    case 'at_capacity':
    case 'out_of_office':
    case 'unavailable':
    case 'outside_working_hours':
      return 'warning';
    case 'inactive_user':
    case 'not_eligible_role':
      return 'inactive';
    case 'wrong_team':
    case 'excluded_by_caller':
      return 'breach';
  }
}
