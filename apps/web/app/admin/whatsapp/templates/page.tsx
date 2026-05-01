'use client';

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Plus, Trash2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataTable, type Column } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import {
  ApiError,
  whatsappAccountsApi,
  whatsappTemplatesApi,
  type CreateWhatsAppTemplateInput,
} from '@/lib/api';
import type {
  WhatsAppAccount,
  WhatsAppTemplateCategory,
  WhatsAppTemplateRow,
  WhatsAppTemplateStatus,
} from '@/lib/api-types';

/**
 * P2-12 — admin CRUD over Meta-approved templates. Templates are
 * approved in Meta's WABA console; the CRM records the metadata so
 * agents can pick them from a dropdown when starting / re-opening a
 * conversation.
 */
export default function AdminWhatsAppTemplatesPage(): JSX.Element {
  const t = useTranslations('admin.whatsappTemplates');
  const tCommon = useTranslations('admin.common');

  const [rows, setRows] = useState<WhatsAppTemplateRow[]>([]);
  const [accounts, setAccounts] = useState<WhatsAppAccount[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [creating, setCreating] = useState<boolean>(false);
  const [form, setForm] = useState<CreateWhatsAppTemplateInput>({
    accountId: '',
    name: '',
    language: 'en',
    category: 'utility',
    bodyText: '',
    status: 'approved',
  });
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [formError, setFormError] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const [list, accountsList] = await Promise.all([
        whatsappTemplatesApi.list(),
        whatsappAccountsApi.list(),
      ]);
      setRows(list);
      setAccounts(accountsList);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const accountById = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);

  function openCreate(): void {
    setForm({
      accountId: accounts[0]?.id ?? '',
      name: '',
      language: 'en',
      category: 'utility',
      bodyText: '',
      status: 'approved',
    });
    setFormError(null);
    setCreating(true);
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setSubmitting(true);
    setFormError(null);
    try {
      await whatsappTemplatesApi.create(form);
      setCreating(false);
      setNotice(tCommon('created'));
      await reload();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function onToggleStatus(row: WhatsAppTemplateRow): Promise<void> {
    const next: WhatsAppTemplateStatus = row.status === 'approved' ? 'paused' : 'approved';
    try {
      await whatsappTemplatesApi.update(row.id, { status: next });
      setNotice(tCommon('saved'));
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  async function onDelete(row: WhatsAppTemplateRow): Promise<void> {
    if (!window.confirm(t('deleteConfirm'))) return;
    try {
      await whatsappTemplatesApi.remove(row.id);
      setNotice(tCommon('saved'));
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  function statusTone(s: WhatsAppTemplateStatus): 'healthy' | 'warning' | 'breach' {
    if (s === 'approved') return 'healthy';
    if (s === 'rejected') return 'breach';
    return 'warning';
  }

  const columns: ReadonlyArray<Column<WhatsAppTemplateRow>> = [
    {
      key: 'name',
      header: t('name'),
      render: (r) => (
        <div className="flex flex-col">
          <span className="font-medium text-ink-primary">{r.name}</span>
          <span className="font-mono text-xs text-ink-tertiary">{r.language}</span>
        </div>
      ),
    },
    {
      key: 'account',
      header: t('account'),
      render: (r) => (
        <span className="text-xs text-ink-secondary">
          {accountById.get(r.accountId)?.displayName ?? r.accountId.slice(0, 8)}
        </span>
      ),
    },
    {
      key: 'category',
      header: t('category'),
      render: (r) => <span className="text-xs uppercase text-ink-secondary">{r.category}</span>,
    },
    {
      key: 'variables',
      header: t('variables'),
      render: (r) => <span className="font-mono text-xs">{r.variableCount}</span>,
    },
    {
      key: 'status',
      header: t('status'),
      render: (r) => <Badge tone={statusTone(r.status)}>{t(`status${cap(r.status)}`)}</Badge>,
    },
    {
      key: 'body',
      header: t('bodyText'),
      render: (r) => (
        <span className="line-clamp-2 max-w-md text-xs text-ink-secondary">{r.bodyText}</span>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          <Button onClick={openCreate} disabled={accounts.length === 0}>
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

      {!loading && rows.length === 0 ? (
        <EmptyState title={t('empty')} />
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          keyOf={(r) => r.id}
          loading={loading}
          rowActions={(row) => (
            <>
              <Button variant="ghost" size="sm" onClick={() => void onToggleStatus(row)}>
                {row.status === 'approved' ? t('statusPaused') : t('statusApproved')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => void onDelete(row)}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </>
          )}
        />
      )}

      <Modal
        open={creating}
        title={t('newTitle')}
        onClose={() => setCreating(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreating(false)}>
              {t('cancel')}
            </Button>
            <Button type="submit" form="waTemplateCreate" loading={submitting}>
              {t('save')}
            </Button>
          </>
        }
      >
        <form id="waTemplateCreate" className="flex flex-col gap-3" onSubmit={onSubmit}>
          {formError ? <Notice tone="error">{formError}</Notice> : null}
          <Field label={t('account')} required>
            <Select
              value={form.accountId}
              onChange={(e) => setForm((f) => ({ ...f, accountId: e.target.value }))}
              required
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.displayName} ({a.phoneNumber})
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('name')} required>
            <Input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              required
              maxLength={100}
              pattern="[a-z][a-z0-9_]*"
              placeholder="appointment_reminder"
            />
          </Field>
          <Field label={t('language')} required hint="BCP-47, e.g. en, ar, en_US">
            <Input
              value={form.language}
              onChange={(e) => setForm((f) => ({ ...f, language: e.target.value }))}
              required
              maxLength={10}
            />
          </Field>
          <Field label={t('category')} required>
            <Select
              value={form.category}
              onChange={(e) =>
                setForm((f) => ({ ...f, category: e.target.value as WhatsAppTemplateCategory }))
              }
              required
            >
              <option value="marketing">{t('categoryMarketing')}</option>
              <option value="utility">{t('categoryUtility')}</option>
              <option value="authentication">{t('categoryAuthentication')}</option>
            </Select>
          </Field>
          <Field label={t('bodyText')} hint={t('bodyHint')} required>
            <Textarea
              value={form.bodyText}
              onChange={(e) => setForm((f) => ({ ...f, bodyText: e.target.value }))}
              rows={4}
              required
              maxLength={2048}
            />
          </Field>
          <Field label={t('status')}>
            <Select
              value={form.status ?? 'approved'}
              onChange={(e) =>
                setForm((f) => ({ ...f, status: e.target.value as WhatsAppTemplateStatus }))
              }
            >
              <option value="approved">{t('statusApproved')}</option>
              <option value="paused">{t('statusPaused')}</option>
              <option value="rejected">{t('statusRejected')}</option>
            </Select>
          </Field>
        </form>
      </Modal>
    </div>
  );
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
