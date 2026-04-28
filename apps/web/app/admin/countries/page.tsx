'use client';

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
import { ApiError, companiesApi, countriesApi } from '@/lib/api';
import type { Company, Country } from '@/lib/api-types';

interface FormState {
  companyId: string;
  code: string;
  name: string;
  isActive: boolean;
}

const EMPTY_FORM: FormState = { companyId: '', code: '', name: '', isActive: true };

export default function CountriesPage(): JSX.Element {
  const t = useTranslations('admin.countries');
  const tCommon = useTranslations('admin.common');

  const [rows, setRows] = useState<Country[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [filterCompanyId, setFilterCompanyId] = useState<string>('');

  const [editing, setEditing] = useState<Country | null>(null);
  const [creating, setCreating] = useState<boolean>(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [formError, setFormError] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const [list, comps] = await Promise.all([
        countriesApi.list(filterCompanyId || undefined),
        companiesApi.list(),
      ]);
      setRows(list);
      setCompanies(comps);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [filterCompanyId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const companyById = useMemo(() => new Map(companies.map((c) => [c.id, c])), [companies]);

  function openNew(): void {
    setEditing(null);
    setForm({ ...EMPTY_FORM, companyId: filterCompanyId || companies[0]?.id || '' });
    setFormError(null);
    setCreating(true);
  }

  function openEdit(row: Country): void {
    setCreating(false);
    setEditing(row);
    setForm({
      companyId: row.companyId,
      code: row.code,
      name: row.name,
      isActive: row.isActive,
    });
    setFormError(null);
  }

  function closeForm(): void {
    setCreating(false);
    setEditing(null);
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setSubmitting(true);
    setFormError(null);
    try {
      if (editing) {
        await countriesApi.update(editing.id, {
          code: form.code,
          name: form.name,
          isActive: form.isActive,
        });
        setNotice(tCommon('saved'));
      } else {
        await countriesApi.create(form);
        setNotice(tCommon('created'));
      }
      closeForm();
      await reload();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function onDelete(row: Country): Promise<void> {
    const ok = window.confirm(tCommon('confirmDelete', { entity: t('title').toLowerCase() }));
    if (!ok) return;
    try {
      await countriesApi.remove(row.id);
      setNotice(tCommon('saved'));
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  const columns: ReadonlyArray<Column<Country>> = [
    {
      key: 'company',
      header: t('company'),
      render: (r) => (
        <span className="text-ink-secondary">
          {companyById.get(r.companyId)?.name ?? r.companyId.slice(0, 8)}
        </span>
      ),
    },
    {
      key: 'code',
      header: t('code'),
      render: (r) => <code className="font-mono">{r.code}</code>,
    },
    { key: 'name', header: t('name'), render: (r) => r.name },
    {
      key: 'status',
      header: t('status'),
      render: (r) => (
        <Badge tone={r.isActive ? 'healthy' : 'inactive'}>
          {r.isActive ? tCommon('active') : tCommon('inactive')}
        </Badge>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          <Button onClick={openNew} disabled={companies.length === 0}>
            <Plus className="h-4 w-4" />
            {t('newButton')}
          </Button>
        }
      />

      <div className="flex flex-wrap items-end gap-3">
        <div className="w-full max-w-xs">
          <Field label={t('filterByCompany')}>
            <Select value={filterCompanyId} onChange={(e) => setFilterCompanyId(e.target.value)}>
              <option value="">{tCommon('all')}</option>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
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
          title={
            companies.length === 0 ? t('empty') : filterCompanyId ? t('emptyFiltered') : t('empty')
          }
          body={
            companies.length === 0
              ? t('noCompanies')
              : filterCompanyId
                ? t('emptyFilteredHint')
                : t('emptyHint')
          }
          action={
            filterCompanyId ? (
              <Button variant="secondary" size="sm" onClick={() => setFilterCompanyId('')}>
                {tCommon('clearFilters')}
              </Button>
            ) : companies.length > 0 ? (
              <Button variant="primary" size="sm" onClick={openNew}>
                {t('newButton')}
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
          rowActions={(row) => (
            <>
              <Button variant="secondary" size="sm" onClick={() => openEdit(row)}>
                {tCommon('edit')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => void onDelete(row)}>
                {tCommon('delete')}
              </Button>
            </>
          )}
        />
      )}

      <p className="text-xs text-ink-tertiary">{t('deleteHint')}</p>

      <Modal
        open={creating || editing !== null}
        title={editing ? t('editTitle') : t('newTitle')}
        onClose={closeForm}
        footer={
          <>
            <Button variant="ghost" onClick={closeForm}>
              {tCommon('cancel')}
            </Button>
            <Button type="submit" form="countryForm" loading={submitting}>
              {tCommon('save')}
            </Button>
          </>
        }
      >
        <form id="countryForm" className="flex flex-col gap-3" onSubmit={onSubmit}>
          {formError ? <Notice tone="error">{formError}</Notice> : null}
          <Field label={t('company')} required>
            <Select
              value={form.companyId}
              onChange={(e) => setForm((f) => ({ ...f, companyId: e.target.value }))}
              disabled={editing !== null}
              required
            >
              <option value="" disabled>
                —
              </option>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('code')} required>
            <Input
              value={form.code}
              onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))}
              placeholder="EG"
              required
              minLength={2}
              maxLength={2}
              pattern="[A-Za-z]{2}"
            />
          </Field>
          <Field label={t('name')} required>
            <Input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              required
              maxLength={120}
            />
          </Field>
          <Field label={t('status')}>
            <Select
              value={form.isActive ? 'active' : 'inactive'}
              onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.value === 'active' }))}
            >
              <option value="active">{tCommon('active')}</option>
              <option value="inactive">{tCommon('inactive')}</option>
            </Select>
          </Field>
        </form>
      </Modal>
    </div>
  );
}
