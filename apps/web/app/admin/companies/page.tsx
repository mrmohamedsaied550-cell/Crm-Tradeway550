'use client';

import { useEffect, useState, useCallback, type FormEvent } from 'react';
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
import { ApiError, companiesApi } from '@/lib/api';
import type { Company } from '@/lib/api-types';

interface FormState {
  code: string;
  name: string;
  isActive: boolean;
}

const EMPTY_FORM: FormState = { code: '', name: '', isActive: true };

export default function CompaniesPage(): JSX.Element {
  const t = useTranslations('admin.companies');
  const tCommon = useTranslations('admin.common');

  const [rows, setRows] = useState<Company[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [editing, setEditing] = useState<Company | null>(null);
  const [creating, setCreating] = useState<boolean>(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [formError, setFormError] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const list = await companiesApi.list();
      setRows(list);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  function openNew(): void {
    setEditing(null);
    setForm(EMPTY_FORM);
    setFormError(null);
    setCreating(true);
  }

  function openEdit(row: Company): void {
    setCreating(false);
    setEditing(row);
    setForm({ code: row.code, name: row.name, isActive: row.isActive });
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
        await companiesApi.update(editing.id, form);
        setNotice(tCommon('saved'));
      } else {
        await companiesApi.create(form);
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

  async function onDelete(row: Company): Promise<void> {
    const ok = window.confirm(tCommon('confirmDelete', { entity: t('title').toLowerCase() }));
    if (!ok) return;
    try {
      await companiesApi.remove(row.id);
      setNotice(tCommon('saved'));
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  const columns: ReadonlyArray<Column<Company>> = [
    { key: 'code', header: t('code'), render: (r) => <code className="font-mono">{r.code}</code> },
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
    {
      key: 'createdAt',
      header: t('createdAt'),
      render: (r) => (
        <span className="text-xs text-ink-secondary">
          {new Date(r.createdAt).toLocaleDateString()}
        </span>
      ),
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
          title={t('empty')}
          body={t('emptyHint')}
          action={
            <Button variant="primary" size="sm" onClick={openNew}>
              {t('newButton')}
            </Button>
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
            <Button type="submit" form="companyForm" loading={submitting}>
              {tCommon('save')}
            </Button>
          </>
        }
      >
        <form id="companyForm" className="flex flex-col gap-3" onSubmit={onSubmit}>
          {formError ? <Notice tone="error">{formError}</Notice> : null}
          <Field label={t('code')} required>
            <Input
              value={form.code}
              onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))}
              placeholder="uber"
              required
              minLength={2}
              maxLength={32}
              pattern="[a-z0-9_\-]+"
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
