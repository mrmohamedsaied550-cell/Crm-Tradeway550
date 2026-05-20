'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState, useCallback, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import {
  ChevronDown,
  Filter,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react';
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
  leadsApi,
  pipelineApi,
  usersApi,
  leadSearchApi,
} from '@/lib/api';
import type {
  AdminUser,
  FilterField,
  FilterOperator,
  Lead,
  LeadSource,
  LeadStageCode,
  PipelineStage,
  PipelineStageWithStatuses,
  SlaStatus,
} from '@/lib/api-types';
import { cn } from '@/lib/utils';

interface CreateForm {
  name: string;
  phone: string;
  email: string;
  source: LeadSource;
  stageCode: LeadStageCode | '';
  assignedToId: string;
}

const EMPTY_CREATE_FORM: CreateForm = {
  name: '',
  phone: '',
  email: '',
  source: 'manual',
  stageCode: '',
  assignedToId: '',
};

const SOURCES: readonly LeadSource[] = ['manual', 'meta', 'tiktok', 'whatsapp', 'import'] as const;

function slaTone(s: SlaStatus): 'healthy' | 'warning' | 'breach' | 'inactive' {
  if (s === 'breached') return 'breach';
  if (s === 'paused') return 'inactive';
  return 'healthy';
}

// Query Builder types
interface FilterCondition {
  id: string;
  field: string;
  operator: string;
  value: string;
}

const FILTER_FIELDS = [
  { key: 'stage', label: 'Stage' },
  { key: 'status', label: 'Status' },
  { key: 'assignee', label: 'Assignee' },
  { key: 'source', label: 'Source' },
  { key: 'sla', label: 'SLA Status' },
  { key: 'phone', label: 'Phone' },
  { key: 'name', label: 'Name' },
  { key: 'email', label: 'Email' },
  { key: 'createdAt', label: 'Created Date' },
];

const FILTER_OPERATORS = [
  { key: 'equals', label: '=' },
  { key: 'not_equals', label: '≠' },
  { key: 'contains', label: 'Contains' },
  { key: 'not_contains', label: 'Not Contains' },
  { key: 'greater_than', label: '>' },
  { key: 'less_than', label: '<' },
  { key: 'is_empty', label: 'Is Empty' },
  { key: 'is_not_empty', label: 'Is Not Empty' },
];

export default function LeadsPage(): JSX.Element {
  const t = useTranslations('admin.leads');
  const tCommon = useTranslations('admin.common');

  const [rows, setRows] = useState<Lead[]>([]);
  const [stages, setStages] = useState<PipelineStage[]>([]);
  const [stagesWithStatuses, setStagesWithStatuses] = useState<PipelineStageWithStatuses[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Filters
  const [filterStage, setFilterStage] = useState<LeadStageCode | ''>('');
  const [filterStatus, setFilterStatus] = useState<string>('');
  const [statusDropdownOpen, setStatusDropdownOpen] = useState<boolean>(false);
  const [search, setSearch] = useState<string>('');

  // Advanced filter
  const [advancedFilterOpen, setAdvancedFilterOpen] = useState<boolean>(false);
  const [andConditions, setAndConditions] = useState<FilterCondition[]>([]);
  const [orConditions, setOrConditions] = useState<FilterCondition[]>([]);

  // Create form
  const [creating, setCreating] = useState<boolean>(false);
  const [form, setForm] = useState<CreateForm>(EMPTY_CREATE_FORM);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [formError, setFormError] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const [page, st, stWithStatuses, usrs] = await Promise.all([
        leadsApi.list({
          stageCode: filterStage || undefined,
          statusCode: filterStatus || undefined,
          q: search.trim() || undefined,
          limit: 100,
        }),
        pipelineApi.listStages(),
        pipelineApi.listStagesWithStatuses().catch(() => [] as PipelineStageWithStatuses[]),
        usersApi
          .list({ status: 'active', limit: 200 })
          .catch(() => ({ items: [] as AdminUser[], total: 0, limit: 200, offset: 0 })),
      ]);
      setRows(page.items);
      setStages(st);
      setStagesWithStatuses(stWithStatuses);
      setUsers(usrs.items);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [filterStage, filterStatus, search]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const userById = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);

  // Get statuses for the currently selected stage filter
  const currentStageStatuses = useMemo(() => {
    if (!filterStage) return [];
    const found = stagesWithStatuses.find((s) => s.code === filterStage);
    return found?.statuses ?? [];
  }, [filterStage, stagesWithStatuses]);

  // Count leads per stage
  const _stageCountMap = useMemo(() => {
    const map = new Map<string, number>();
    // We'll show the count from the current filtered data
    rows.forEach((r) => {
      const code = r.stage.code;
      map.set(code, (map.get(code) ?? 0) + 1);
    });
    return map;
  }, [rows]);

  function openNew(): void {
    setForm(EMPTY_CREATE_FORM);
    setFormError(null);
    setCreating(true);
  }

  function closeForm(): void {
    setCreating(false);
  }

  async function onCreate(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setSubmitting(true);
    setFormError(null);
    try {
      await leadsApi.create({
        name: form.name,
        phone: form.phone,
        email: form.email || undefined,
        source: form.source,
        stageCode: form.stageCode || undefined,
        assignedToId: form.assignedToId || undefined,
      });
      setNotice(tCommon('created'));
      closeForm();
      await reload();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function onDelete(row: Lead): Promise<void> {
    const ok = window.confirm(tCommon('confirmDelete', { entity: 'lead' }));
    if (!ok) return;
    try {
      await leadsApi.remove(row.id);
      setNotice(tCommon('saved'));
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  // Advanced filter handlers
  function addCondition(type: 'and' | 'or'): void {
    const newCondition: FilterCondition = {
      id: crypto.randomUUID(),
      field: 'stage',
      operator: 'equals',
      value: '',
    };
    if (type === 'and') {
      setAndConditions((prev) => [...prev, newCondition]);
    } else {
      setOrConditions((prev) => [...prev, newCondition]);
    }
  }

  function updateCondition(type: 'and' | 'or', id: string, updates: Partial<FilterCondition>): void {
    const setter = type === 'and' ? setAndConditions : setOrConditions;
    setter((prev) => prev.map((c) => (c.id === id ? { ...c, ...updates } : c)));
  }

  function removeCondition(type: 'and' | 'or', id: string): void {
    const setter = type === 'and' ? setAndConditions : setOrConditions;
    setter((prev) => prev.filter((c) => c.id !== id));
  }

  async function applyAdvancedFilter(): Promise<void> {
    setAdvancedFilterOpen(false);
    setLoading(true);
    setError(null);
    try {
      const conditions = [
        ...andConditions.map((c) => ({ ...c, group: 'and' as const })),
        ...orConditions.map((c) => ({ ...c, group: 'or' as const })),
      ];
      if (conditions.length === 0) {
        await reload();
        return;
      }
      const result = await leadSearchApi.search({
        allConditions: andConditions.map((c) => ({
          field: c.field as FilterField,
          operator: c.operator as FilterOperator,
          value: c.value,
        })),
        anyConditions: orConditions.map((c) => ({
          field: c.field as FilterField,
          operator: c.operator as FilterOperator,
          value: c.value,
        })),
      });
      setRows(result.items);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      await reload();
    } finally {
      setLoading(false);
    }
  }

  // Stage filter click handler
  function handleStageFilterClick(code: LeadStageCode | ''): void {
    if (code === filterStage) {
      // Toggle status dropdown if same stage clicked again
      setStatusDropdownOpen(!statusDropdownOpen);
    } else {
      setFilterStage(code);
      setFilterStatus('');
      setStatusDropdownOpen(code !== '');
    }
  }

  const columns: ReadonlyArray<Column<Lead>> = [
    {
      key: 'name',
      header: t('name'),
      render: (r) => (
        <Link href={`/admin/leads/${r.id}`} className="font-medium text-brand-700 hover:underline">
          {r.name}
        </Link>
      ),
    },
    {
      key: 'phone',
      header: t('phone'),
      render: (r) => <code className="font-mono text-xs">{r.phone}</code>,
    },
    {
      key: 'stage',
      header: t('stage'),
      render: (r) => <Badge tone={r.stage.isTerminal ? 'inactive' : 'info'}>{r.stage.name}</Badge>,
    },
    {
      key: 'status',
      header: 'Status',
      render: (r) =>
        r.status ? (
          <Badge tone="warning">{r.status.name}</Badge>
        ) : (
          <span className="text-xs text-ink-tertiary">—</span>
        ),
    },
    {
      key: 'assignee',
      header: t('assignee'),
      render: (r) =>
        r.assignedToId ? (
          <span className="text-ink-secondary">
            {userById.get(r.assignedToId)?.name ?? r.assignedToId.slice(0, 8)}
          </span>
        ) : (
          <span className="text-ink-tertiary">{t('unassigned')}</span>
        ),
    },
    {
      key: 'sla',
      header: t('sla'),
      render: (r) => <Badge tone={slaTone(r.slaStatus)}>{r.slaStatus}</Badge>,
    },
    {
      key: 'source',
      header: t('source'),
      render: (r) => <span className="text-xs text-ink-secondary">{r.source}</span>,
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t('title')}
        subtitle={`${rows.length} total`}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => setAdvancedFilterOpen(true)}>
              <Filter className="h-4 w-4" />
              Advanced Filter
            </Button>
            <Button onClick={openNew}>
              <Plus className="h-4 w-4" />
              {t('newButton')}
            </Button>
          </div>
        }
      />

      {/* Stage filter pills */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => handleStageFilterClick('')}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors border',
            !filterStage
              ? 'bg-brand-50 border-brand-300 text-brand-700'
              : 'border-surface-border text-ink-secondary hover:bg-surface hover:border-brand-200',
          )}
        >
          All Stages ({rows.length})
        </button>
        {stages.map((s) => (
          <div key={s.code} className="relative">
            <button
              onClick={() => handleStageFilterClick(s.code as LeadStageCode)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors border',
                filterStage === s.code
                  ? 'bg-brand-50 border-brand-300 text-brand-700'
                  : 'border-surface-border text-ink-secondary hover:bg-surface hover:border-brand-200',
              )}
            >
              <span
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: s.color ?? '#6b7280' }}
              />
              {s.name}
              {filterStage === s.code ? (
                <ChevronDown className="h-3 w-3" />
              ) : null}
            </button>

            {/* Status dropdown under the active stage */}
            {statusDropdownOpen && filterStage === s.code && currentStageStatuses.length > 0 ? (
              <div className="absolute top-full start-0 z-20 mt-1 min-w-[180px] rounded-md border border-surface-border bg-surface-card py-1 shadow-lg">
                <button
                  onClick={() => { setFilterStatus(''); setStatusDropdownOpen(false); }}
                  className={cn(
                    'flex w-full items-center px-3 py-1.5 text-xs text-start transition-colors',
                    !filterStatus ? 'bg-brand-50 text-brand-700 font-medium' : 'text-ink-primary hover:bg-surface',
                  )}
                >
                  All statuses
                </button>
                {currentStageStatuses.map((st) => (
                  <button
                    key={st.id}
                    onClick={() => { setFilterStatus(st.code); setStatusDropdownOpen(false); }}
                    className={cn(
                      'flex w-full items-center gap-2 px-3 py-1.5 text-xs text-start transition-colors',
                      filterStatus === st.code ? 'bg-brand-50 text-brand-700 font-medium' : 'text-ink-primary hover:bg-surface',
                    )}
                  >
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ backgroundColor: st.color ?? '#6b7280' }}
                    />
                    {st.name}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </div>

      {/* Active filter indicator */}
      {filterStatus ? (
        <div className="flex items-center gap-2">
          <span className="text-xs text-ink-tertiary">Filtered by status:</span>
          <Badge tone="warning">{filterStatus}</Badge>
          <button
            onClick={() => setFilterStatus('')}
            className="text-ink-tertiary hover:text-ink-primary"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : null}

      {/* Search bar */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-full max-w-sm">
          <Field label={t('search')}>
            <div className="relative">
              <Search className="absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-tertiary" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by name, phone, or agent..."
                className="ps-9"
              />
            </div>
          </Field>
        </div>
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
      {notice ? <Notice tone="success">{notice}</Notice> : null}

      {!loading && !error && rows.length === 0 ? (
        <EmptyState
          title={filterStage || search ? t('emptyFiltered') : t('empty')}
          body={filterStage || search ? t('emptyFilteredHint') : t('emptyHint')}
          action={
            filterStage || search ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setFilterStage('');
                  setFilterStatus('');
                  setSearch('');
                }}
              >
                {tCommon('clearFilters')}
              </Button>
            ) : (
              <Button variant="primary" size="sm" onClick={openNew}>
                {t('newButton')}
              </Button>
            )
          }
        />
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          keyOf={(r) => r.id}
          loading={loading}
          rowActions={(row) => (
            <>
              <Link
                href={`/admin/leads/${row.id}`}
                className="inline-flex h-8 items-center justify-center rounded-md border border-surface-border bg-surface-card px-3 text-xs font-medium text-ink-primary hover:bg-brand-50 hover:border-brand-200"
              >
                {t('openDetail')}
              </Link>
              <Button variant="ghost" size="sm" onClick={() => void onDelete(row)}>
                {tCommon('delete')}
              </Button>
            </>
          )}
        />
      )}

      {/* Create Lead Modal */}
      <Modal
        open={creating}
        title={t('newTitle')}
        onClose={closeForm}
        footer={
          <>
            <Button variant="ghost" onClick={closeForm}>
              {tCommon('cancel')}
            </Button>
            <Button type="submit" form="leadCreateForm" loading={submitting}>
              {tCommon('save')}
            </Button>
          </>
        }
      >
        <form id="leadCreateForm" className="flex flex-col gap-3" onSubmit={onCreate}>
          {formError ? <Notice tone="error">{formError}</Notice> : null}
          <Field label={t('name')} required>
            <Input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              required
              maxLength={120}
            />
          </Field>
          <Field label={t('phone')} required hint="E.164 format (e.g. +201001112222)">
            <Input
              value={form.phone}
              onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
              required
              minLength={6}
              maxLength={32}
            />
          </Field>
          <Field label={t('email')}>
            <Input
              type="email"
              value={form.email}
              onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
              maxLength={254}
            />
          </Field>
          <Field label={t('source')}>
            <Select
              value={form.source}
              onChange={(e) => setForm((f) => ({ ...f, source: e.target.value as LeadSource }))}
            >
              {SOURCES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('stage')}>
            <Select
              value={form.stageCode}
              onChange={(e) =>
                setForm((f) => ({ ...f, stageCode: e.target.value as LeadStageCode | '' }))
              }
            >
              <option value="">— (default: new)</option>
              {stages.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('assignee')}>
            <Select
              value={form.assignedToId}
              onChange={(e) => setForm((f) => ({ ...f, assignedToId: e.target.value }))}
            >
              <option value="">{t('unassigned')}</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} ({u.email})
                </option>
              ))}
            </Select>
          </Field>
        </form>
      </Modal>

      {/* Advanced Filter / Query Builder Modal */}
      {advancedFilterOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40" onClick={() => setAdvancedFilterOpen(false)} />
          <div className="relative z-10 w-full max-w-2xl rounded-xl bg-surface-card p-6 shadow-xl">
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-lg font-semibold text-ink-primary">Create Smart Filter</h3>
              <button onClick={() => setAdvancedFilterOpen(false)} className="text-ink-tertiary hover:text-ink-primary">
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* AND Conditions */}
            <div className="mb-5">
              <div className="mb-2">
                <h4 className="text-sm font-semibold text-ink-primary">
                  All Conditions (AND - All conditions must be met)
                </h4>
                <p className="text-[11px] text-ink-tertiary">
                  All conditions must be met together (logical AND). Example: Status = &quot;Closed&quot; AND Source = &quot;Website&quot; AND Value &gt; 1000
                </p>
              </div>
              <div className="flex flex-col gap-2">
                {andConditions.map((cond) => (
                  <ConditionRow
                    key={cond.id}
                    condition={cond}
                    onUpdate={(updates) => updateCondition('and', cond.id, updates)}
                    onRemove={() => removeCondition('and', cond.id)}
                    stages={stages}
                    users={users}
                  />
                ))}
              </div>
              <button
                onClick={() => addCondition('and')}
                className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline"
              >
                <Plus className="h-3.5 w-3.5" /> Add Condition
              </button>
            </div>

            {/* OR Conditions */}
            <div className="mb-5 border-t border-surface-border pt-5">
              <div className="mb-2">
                <h4 className="text-sm font-semibold text-ink-primary">
                  Any Conditions (OR - At least one condition must be met)
                </h4>
                <p className="text-[11px] text-ink-tertiary">
                  It is sufficient that any condition is met (logical OR). Example: Status = &quot;New&quot; OR Source = &quot;Referral&quot; OR Value &gt; 5000
                </p>
              </div>
              <div className="flex flex-col gap-2">
                {orConditions.map((cond) => (
                  <ConditionRow
                    key={cond.id}
                    condition={cond}
                    onUpdate={(updates) => updateCondition('or', cond.id, updates)}
                    onRemove={() => removeCondition('or', cond.id)}
                    stages={stages}
                    users={users}
                  />
                ))}
              </div>
              <button
                onClick={() => addCondition('or')}
                className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline"
              >
                <Plus className="h-3.5 w-3.5" /> Add Condition
              </button>
            </div>

            {/* Footer */}
            <div className="flex items-center justify-end gap-3 border-t border-surface-border pt-4">
              <Button variant="ghost" onClick={() => setAdvancedFilterOpen(false)}>
                Cancel
              </Button>
              <Button
                onClick={() => void applyAdvancedFilter()}
                disabled={andConditions.length === 0 && orConditions.length === 0}
              >
                Apply Filter
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────
// Condition Row Component
// ───────────────────────────────────────────────────────────────────────

function ConditionRow({
  condition,
  onUpdate,
  onRemove,
  stages,
  users,
}: {
  condition: FilterCondition;
  onUpdate: (updates: Partial<FilterCondition>) => void;
  onRemove: () => void;
  stages: PipelineStage[];
  users: AdminUser[];
}): JSX.Element {
  return (
    <div className="flex items-center gap-2 rounded-md border border-surface-border bg-surface p-2">
      <select
        value={condition.field}
        onChange={(e) => onUpdate({ field: e.target.value })}
        className="rounded-md border border-surface-border bg-surface-card px-2 py-1 text-xs outline-none focus:border-brand-400"
      >
        {FILTER_FIELDS.map((f) => (
          <option key={f.key} value={f.key}>
            {f.label}
          </option>
        ))}
      </select>

      <select
        value={condition.operator}
        onChange={(e) => onUpdate({ operator: e.target.value })}
        className="rounded-md border border-surface-border bg-surface-card px-2 py-1 text-xs outline-none focus:border-brand-400"
      >
        {FILTER_OPERATORS.map((op) => (
          <option key={op.key} value={op.key}>
            {op.label}
          </option>
        ))}
      </select>

      {/* Value input - contextual based on field */}
      {condition.field === 'stage' ? (
        <select
          value={condition.value}
          onChange={(e) => onUpdate({ value: e.target.value })}
          className="flex-1 rounded-md border border-surface-border bg-surface-card px-2 py-1 text-xs outline-none focus:border-brand-400"
        >
          <option value="">Select...</option>
          {stages.map((s) => (
            <option key={s.code} value={s.code}>
              {s.name}
            </option>
          ))}
        </select>
      ) : condition.field === 'assignee' ? (
        <select
          value={condition.value}
          onChange={(e) => onUpdate({ value: e.target.value })}
          className="flex-1 rounded-md border border-surface-border bg-surface-card px-2 py-1 text-xs outline-none focus:border-brand-400"
        >
          <option value="">Select...</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>
      ) : condition.field === 'source' ? (
        <select
          value={condition.value}
          onChange={(e) => onUpdate({ value: e.target.value })}
          className="flex-1 rounded-md border border-surface-border bg-surface-card px-2 py-1 text-xs outline-none focus:border-brand-400"
        >
          <option value="">Select...</option>
          {SOURCES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      ) : condition.field === 'sla' ? (
        <select
          value={condition.value}
          onChange={(e) => onUpdate({ value: e.target.value })}
          className="flex-1 rounded-md border border-surface-border bg-surface-card px-2 py-1 text-xs outline-none focus:border-brand-400"
        >
          <option value="">Select...</option>
          <option value="healthy">Healthy</option>
          <option value="warning">Warning</option>
          <option value="breached">Breached</option>
          <option value="paused">Paused</option>
        </select>
      ) : condition.field === 'createdAt' ? (
        <input
          type="date"
          value={condition.value}
          onChange={(e) => onUpdate({ value: e.target.value })}
          className="flex-1 rounded-md border border-surface-border bg-surface-card px-2 py-1 text-xs outline-none focus:border-brand-400"
        />
      ) : (
        <input
          type="text"
          value={condition.value}
          onChange={(e) => onUpdate({ value: e.target.value })}
          placeholder="Value..."
          className="flex-1 rounded-md border border-surface-border bg-surface-card px-2 py-1 text-xs outline-none focus:border-brand-400"
        />
      )}

      <button
        onClick={onRemove}
        className="inline-flex h-6 w-6 items-center justify-center rounded text-ink-tertiary hover:bg-red-50 hover:text-red-500"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
