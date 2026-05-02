'use client';

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Pencil, Plus, Trash2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataTable, type Column } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { useToast } from '@/components/ui/toast';
import { ApiError, metaLeadSourcesApi, type CreateMetaLeadSourceInput } from '@/lib/api';
import type { LeadSource, MetaLeadSource } from '@/lib/api-types';
import { hasCapability } from '@/lib/auth';

/**
 * /admin/meta-lead-sources (PL-2) — admin CRUD over the Meta lead-ad
 * routing rows the public webhook reads at ingest time.
 *
 * Each row pairs a Meta page (and optionally a single form) with a
 * verify-token, app-secret (optional), default lead source label
 * and a field mapping that tells the ingestor which payload fields
 * to copy into `name` / `phone` / `email`. The mapping is edited
 * here as a small JSON textarea so admins can adapt to whatever
 * field labels the marketing team set up on Meta without a code
 * change.
 *
 * Capability gate (server-side):
 *   - meta.leadsource.read for the list,
 *   - meta.leadsource.write for create / update / delete.
 * Granted to ops_manager + account_manager + super_admin.
 *
 * No new endpoints — uses the existing P2-06 admin surface.
 */

const SOURCES: readonly LeadSource[] = ['manual', 'meta', 'tiktok', 'whatsapp', 'import'] as const;

interface FormState {
  displayName: string;
  pageId: string;
  formId: string;
  verifyToken: string;
  appSecret: string;
  defaultSource: LeadSource;
  /** JSON-encoded mapping. Validated on submit. */
  fieldMappingJson: string;
  isActive: boolean;
}

const EMPTY_FORM: FormState = {
  displayName: '',
  pageId: '',
  formId: '',
  verifyToken: '',
  appSecret: '',
  defaultSource: 'meta',
  // Sensible default — most Meta lead forms ship with `full_name`,
  // `phone_number`, and `email` keys. Admin can edit before save.
  fieldMappingJson: JSON.stringify(
    { full_name: 'name', phone_number: 'phone', email: 'email' },
    null,
    2,
  ),
  isActive: true,
};

export default function MetaLeadSourcesPage(): JSX.Element {
  const t = useTranslations('admin.metaLeadSources');
  const tCommon = useTranslations('admin.common');
  const { toast } = useToast();
  const canWrite = hasCapability('meta.leadsource.write');

  const [rows, setRows] = useState<MetaLeadSource[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const [open, setOpen] = useState<boolean>(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [formError, setFormError] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const items = await metaLeadSourcesApi.list();
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

  function openCreate(): void {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setFormError(null);
    setOpen(true);
  }

  function openEdit(row: MetaLeadSource): void {
    setEditingId(row.id);
    setForm({
      displayName: row.displayName,
      pageId: row.pageId,
      formId: row.formId ?? '',
      // The server never returns the verifyToken back — the field is
      // intentionally left blank on edit so the admin can leave it
      // alone (PATCH omits the key) or rotate it explicitly.
      verifyToken: '',
      appSecret: '',
      defaultSource: row.defaultSource,
      fieldMappingJson: JSON.stringify(row.fieldMapping, null, 2),
      isActive: row.isActive,
    });
    setFormError(null);
    setOpen(true);
  }

  function parseMapping(): Record<string, string> | null {
    try {
      const parsed: unknown = JSON.parse(form.fieldMappingJson);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof k !== 'string' || k.length === 0) return null;
        if (typeof v !== 'string' || v.length === 0) return null;
        out[k] = v;
      }
      return out;
    } catch {
      return null;
    }
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setFormError(null);
    const mapping = parseMapping();
    if (!mapping) {
      setFormError(t('errors.mappingInvalid'));
      return;
    }
    const targets = new Set(Object.values(mapping));
    if (!targets.has('name') || !targets.has('phone')) {
      setFormError(t('errors.mappingMissingTargets'));
      return;
    }

    setSubmitting(true);
    try {
      if (editingId) {
        // PATCH: omit empty verifyToken / appSecret so we don't blank them.
        const body: Partial<CreateMetaLeadSourceInput> = {
          displayName: form.displayName.trim(),
          pageId: form.pageId.trim(),
          formId: form.formId.trim() ? form.formId.trim() : null,
          defaultSource: form.defaultSource,
          fieldMapping: mapping,
          isActive: form.isActive,
        };
        if (form.verifyToken.trim()) body.verifyToken = form.verifyToken.trim();
        if (form.appSecret.trim()) body.appSecret = form.appSecret.trim();
        await metaLeadSourcesApi.update(editingId, body);
        toast({ tone: 'success', title: t('updated') });
      } else {
        if (!form.verifyToken.trim()) {
          setFormError(t('errors.verifyTokenRequired'));
          setSubmitting(false);
          return;
        }
        const body: CreateMetaLeadSourceInput = {
          displayName: form.displayName.trim(),
          pageId: form.pageId.trim(),
          formId: form.formId.trim() ? form.formId.trim() : null,
          verifyToken: form.verifyToken.trim(),
          ...(form.appSecret.trim() ? { appSecret: form.appSecret.trim() } : {}),
          defaultSource: form.defaultSource,
          fieldMapping: mapping,
          isActive: form.isActive,
        };
        await metaLeadSourcesApi.create(body);
        toast({ tone: 'success', title: t('created') });
      }
      setOpen(false);
      await reload();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function onDelete(row: MetaLeadSource): Promise<void> {
    if (!window.confirm(t('confirmDelete', { name: row.displayName }))) return;
    try {
      await metaLeadSourcesApi.remove(row.id);
      toast({ tone: 'success', title: t('deleted') });
      await reload();
    } catch (err) {
      toast({ tone: 'error', title: err instanceof ApiError ? err.message : String(err) });
    }
  }

  const columns: ReadonlyArray<Column<MetaLeadSource>> = useMemo(
    () => [
      {
        key: 'name',
        header: t('cols.name'),
        render: (r) => (
          <div className="flex flex-col leading-tight">
            <span className="font-medium text-ink-primary">{r.displayName}</span>
            <span className="font-mono text-xs text-ink-tertiary">
              {t('cols.pageIdLabel')}: {r.pageId}
              {r.formId ? ` · ${t('cols.formIdLabel')}: ${r.formId}` : ''}
            </span>
          </div>
        ),
      },
      {
        key: 'source',
        header: t('cols.source'),
        render: (r) => <span className="text-xs uppercase tracking-wide">{r.defaultSource}</span>,
      },
      {
        key: 'mapping',
        header: t('cols.mapping'),
        render: (r) => (
          <span className="text-xs text-ink-secondary">
            {Object.keys(r.fieldMapping).length} {t('cols.mappingFields')}
          </span>
        ),
      },
      {
        key: 'status',
        header: t('cols.status'),
        render: (r) =>
          r.isActive ? (
            <Badge tone="healthy">{t('cols.active')}</Badge>
          ) : (
            <Badge tone="inactive">{t('cols.inactive')}</Badge>
          ),
      },
    ],
    [t],
  );

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          canWrite ? (
            <Button onClick={openCreate}>
              <Plus className="h-4 w-4" />
              {t('newButton')}
            </Button>
          ) : null
        }
      />

      <Notice tone="info">{t('webhookHint')}</Notice>

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
          title={t('empty')}
          body={t('emptyHint')}
          action={
            canWrite ? (
              <Button variant="secondary" size="sm" onClick={openCreate}>
                <Plus className="h-4 w-4" />
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
          skeletonRows={4}
          rowActions={(row) =>
            canWrite ? (
              <>
                <Button variant="ghost" size="sm" onClick={() => openEdit(row)}>
                  <Pencil className="h-3.5 w-3.5" />
                  {t('edit')}
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
        title={editingId ? t('editTitle') : t('newTitle')}
        onClose={() => setOpen(false)}
        width="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {tCommon('cancel')}
            </Button>
            <Button type="submit" form="metaLeadSourceForm" loading={submitting}>
              {tCommon('save')}
            </Button>
          </>
        }
      >
        <form id="metaLeadSourceForm" className="flex flex-col gap-3" onSubmit={onSubmit}>
          {formError ? <Notice tone="error">{formError}</Notice> : null}

          <Field label={t('form.displayName')} required>
            <Input
              value={form.displayName}
              onChange={(e) => setForm((f) => ({ ...f, displayName: e.target.value }))}
              required
              maxLength={120}
              placeholder={t('form.displayNamePlaceholder')}
            />
          </Field>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={t('form.pageId')} required hint={t('form.pageIdHint')}>
              <Input
                value={form.pageId}
                onChange={(e) => setForm((f) => ({ ...f, pageId: e.target.value }))}
                required
                maxLength={64}
              />
            </Field>
            <Field label={t('form.formId')} hint={t('form.formIdHint')}>
              <Input
                value={form.formId}
                onChange={(e) => setForm((f) => ({ ...f, formId: e.target.value }))}
                maxLength={64}
              />
            </Field>
          </div>

          <Field
            label={t('form.verifyToken')}
            required={!editingId}
            hint={editingId ? t('form.verifyTokenEditHint') : t('form.verifyTokenHint')}
          >
            <Input
              value={form.verifyToken}
              onChange={(e) => setForm((f) => ({ ...f, verifyToken: e.target.value }))}
              maxLength={255}
              minLength={editingId ? undefined : 8}
              placeholder={editingId ? '••••••••' : ''}
            />
          </Field>

          <Field
            label={t('form.appSecret')}
            hint={editingId ? t('form.appSecretEditHint') : t('form.appSecretHint')}
          >
            <Input
              value={form.appSecret}
              onChange={(e) => setForm((f) => ({ ...f, appSecret: e.target.value }))}
              maxLength={255}
              placeholder={editingId ? '••••••••' : ''}
            />
          </Field>

          <Field label={t('form.defaultSource')} required>
            <Select
              value={form.defaultSource}
              onChange={(e) =>
                setForm((f) => ({ ...f, defaultSource: e.target.value as LeadSource }))
              }
              required
            >
              {SOURCES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </Field>

          <Field label={t('form.fieldMapping')} hint={t('form.fieldMappingHint')} required>
            <Textarea
              value={form.fieldMappingJson}
              onChange={(e) => setForm((f) => ({ ...f, fieldMappingJson: e.target.value }))}
              rows={6}
              required
              className="font-mono text-xs"
              spellCheck={false}
            />
          </Field>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.isActive}
              onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))}
            />
            {t('form.isActive')}
          </label>
        </form>
      </Modal>
    </div>
  );
}
