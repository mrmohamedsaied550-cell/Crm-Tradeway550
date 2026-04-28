'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState, useCallback, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Plus } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataTable, type Column } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input, Select } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { ApiError, leadsApi, pipelineApi, usersApi } from '@/lib/api';
import type {
  AdminUser,
  Lead,
  LeadSource,
  LeadStageCode,
  PipelineStage,
  SlaStatus,
} from '@/lib/api-types';

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

export default function LeadsPage(): JSX.Element {
  const t = useTranslations('admin.leads');
  const tCommon = useTranslations('admin.common');

  const [rows, setRows] = useState<Lead[]>([]);
  const [stages, setStages] = useState<PipelineStage[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [filterStage, setFilterStage] = useState<LeadStageCode | ''>('');
  const [search, setSearch] = useState<string>('');

  const [creating, setCreating] = useState<boolean>(false);
  const [form, setForm] = useState<CreateForm>(EMPTY_CREATE_FORM);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [formError, setFormError] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const [page, st, usrs] = await Promise.all([
        leadsApi.list({
          stageCode: filterStage || undefined,
          q: search.trim() || undefined,
          limit: 100,
        }),
        pipelineApi.listStages(),
        usersApi
          .list({ status: 'active', limit: 200 })
          .catch(() => ({ items: [] as AdminUser[], total: 0, limit: 200, offset: 0 })),
      ]);
      setRows(page.items);
      setStages(st);
      setUsers(usrs.items);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [filterStage, search]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const userById = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);

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

  const columns: ReadonlyArray<Column<Lead>> = [
    {
      key: 'name',
      header: t('name'),
      render: (r) => <span className="font-medium">{r.name}</span>,
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
        subtitle={t('subtitle')}
        actions={
          <Button onClick={openNew}>
            <Plus className="h-4 w-4" />
            {t('newButton')}
          </Button>
        }
      />

      <div className="flex flex-wrap items-end gap-3">
        <div className="w-full max-w-xs">
          <Field label={t('filterByStage')}>
            <Select
              value={filterStage}
              onChange={(e) => setFilterStage(e.target.value as LeadStageCode | '')}
            >
              <option value="">{tCommon('all')}</option>
              {stages.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="w-full max-w-sm">
          <Field label={t('search')}>
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="…" />
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
    </div>
  );
}
