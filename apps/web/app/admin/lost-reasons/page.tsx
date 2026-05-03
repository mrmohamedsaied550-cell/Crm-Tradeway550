'use client';

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Pencil, Plus } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataTable, type Column } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { useToast } from '@/components/ui/toast';
import {
  ApiError,
  lostReasonsApi,
  type CreateLostReasonInput,
  type UpdateLostReasonInput,
} from '@/lib/api';
import type { LostReason } from '@/lib/api-types';
import { hasCapability } from '@/lib/auth';

/**
 * /admin/lost-reasons (Phase A — A6) — admin CRUD for the per-tenant
 * rejection-reason catalogue.
 *
 * Capability gate (mirrored server-side):
 *   • tenant.settings.read  → list (active + inactive)
 *   • tenant.settings.write → create / update / activate / deactivate
 *
 * The seed-installed `'other'` code is protected from deactivation
 * (server returns lost_reason.protected_cannot_deactivate); the UI
 * disables the toggle on its row to match.
 *
 * `code` is intentionally non-editable post-create — distribution
 * rules, reports, and audit logs may reference codes long after a
 * label is renamed.
 */

const PROTECTED_CODE = 'other';

interface FormState {
  code: string;
  labelEn: string;
  labelAr: string;
  isActive: boolean;
  displayOrder: string; // string-bound for the input; coerced on submit
}

const EMPTY_FORM: FormState = {
  code: '',
  labelEn: '',
  labelAr: '',
  isActive: true,
  displayOrder: '100',
};

export default function LostReasonsAdminPage(): JSX.Element {
  const t = useTranslations('admin.lostReasons');
  const tCommon = useTranslations('admin.common');
  const { toast } = useToast();
  const canRead = hasCapability('tenant.settings.read');
  const canWrite = hasCapability('tenant.settings.write');

  const [rows, setRows] = useState<LostReason[]>([]);
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
      const items = await lostReasonsApi.listAll();
      setRows(items);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!canRead) return;
    void reload();
  }, [canRead, reload]);

  const sorted = useMemo(
    () =>
      [...rows].sort((a, b) =>
        a.displayOrder !== b.displayOrder
          ? a.displayOrder - b.displayOrder
          : a.code.localeCompare(b.code),
      ),
    [rows],
  );

  function openCreate(): void {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setFormError(null);
    setOpen(true);
  }

  function openEdit(row: LostReason): void {
    setEditingId(row.id);
    setForm({
      code: row.code,
      labelEn: row.labelEn,
      labelAr: row.labelAr,
      isActive: row.isActive,
      displayOrder: String(row.displayOrder),
    });
    setFormError(null);
    setOpen(true);
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setFormError(null);
    const trimmedCode = form.code.trim();
    const trimmedEn = form.labelEn.trim();
    const trimmedAr = form.labelAr.trim();
    const order = Number(form.displayOrder);
    if (!trimmedEn || !trimmedAr) {
      setFormError(t('errors.labelsRequired'));
      return;
    }
    if (!Number.isFinite(order) || order < 0) {
      setFormError(t('errors.orderInvalid'));
      return;
    }
    if (!editingId) {
      // Create — code is required.
      if (!trimmedCode) {
        setFormError(t('errors.codeRequired'));
        return;
      }
      if (!/^[a-z][a-z0-9_]*$/.test(trimmedCode)) {
        setFormError(t('errors.codeShape'));
        return;
      }
    }
    setSubmitting(true);
    try {
      if (editingId) {
        const body: UpdateLostReasonInput = {
          labelEn: trimmedEn,
          labelAr: trimmedAr,
          isActive: form.isActive,
          displayOrder: order,
        };
        await lostReasonsApi.update(editingId, body);
        toast({ tone: 'success', title: t('updated') });
      } else {
        const body: CreateLostReasonInput = {
          code: trimmedCode,
          labelEn: trimmedEn,
          labelAr: trimmedAr,
          isActive: form.isActive,
          displayOrder: order,
        };
        await lostReasonsApi.create(body);
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

  async function toggleActive(row: LostReason): Promise<void> {
    if (row.code === PROTECTED_CODE && row.isActive) {
      toast({ tone: 'warning', title: t('errors.cannotDeactivateProtected') });
      return;
    }
    try {
      await lostReasonsApi.update(row.id, { isActive: !row.isActive });
      await reload();
    } catch (err) {
      toast({
        tone: 'error',
        title: err instanceof ApiError ? err.message : String(err),
      });
    }
  }

  if (!canRead) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title={t('title')} subtitle={t('subtitle')} />
        <Notice tone="error">{t('noAccess')}</Notice>
      </div>
    );
  }

  const columns: ReadonlyArray<Column<LostReason>> = [
    {
      key: 'order',
      header: t('cols.order'),
      className: 'w-16 text-center',
      render: (r) => <span className="font-mono text-xs">{r.displayOrder}</span>,
    },
    {
      key: 'code',
      header: t('cols.code'),
      render: (r) => (
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs">{r.code}</span>
          {r.code === PROTECTED_CODE ? <Badge tone="info">{t('protected')}</Badge> : null}
        </div>
      ),
    },
    {
      key: 'labelEn',
      header: t('cols.labelEn'),
      render: (r) => <span>{r.labelEn}</span>,
    },
    {
      key: 'labelAr',
      header: t('cols.labelAr'),
      render: (r) => <span dir="rtl">{r.labelAr}</span>,
    },
    {
      key: 'status',
      header: t('cols.status'),
      className: 'w-28',
      render: (r) =>
        r.isActive ? (
          <Badge tone="healthy">{tCommon('active')}</Badge>
        ) : (
          <Badge tone="inactive">{tCommon('inactive')}</Badge>
        ),
    },
  ];

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

      <Notice tone="info">{t('intro')}</Notice>

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
          rows={sorted}
          keyOf={(r) => r.id}
          loading={loading}
          skeletonRows={5}
          rowActions={(row) =>
            canWrite ? (
              <>
                <Button variant="ghost" size="sm" onClick={() => openEdit(row)}>
                  <Pencil className="h-3.5 w-3.5" />
                  {t('edit')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void toggleActive(row)}
                  disabled={row.code === PROTECTED_CODE && row.isActive}
                  title={
                    row.code === PROTECTED_CODE && row.isActive
                      ? t('errors.cannotDeactivateProtected')
                      : undefined
                  }
                >
                  {row.isActive ? t('deactivate') : t('activate')}
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
        width="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {tCommon('cancel')}
            </Button>
            <Button type="submit" form="lostReasonForm" loading={submitting}>
              {tCommon('save')}
            </Button>
          </>
        }
      >
        <form id="lostReasonForm" className="flex flex-col gap-3" onSubmit={onSubmit}>
          {formError ? <Notice tone="error">{formError}</Notice> : null}

          <Field label={t('form.code')} required hint={t('form.codeHint')}>
            <Input
              value={form.code}
              onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))}
              required
              maxLength={64}
              disabled={!!editingId}
              placeholder="e.g. wrong_phone"
              className="font-mono text-sm"
            />
          </Field>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={t('form.labelEn')} required>
              <Input
                value={form.labelEn}
                onChange={(e) => setForm((f) => ({ ...f, labelEn: e.target.value }))}
                required
                maxLength={120}
              />
            </Field>
            <Field label={t('form.labelAr')} required>
              <Input
                value={form.labelAr}
                onChange={(e) => setForm((f) => ({ ...f, labelAr: e.target.value }))}
                required
                maxLength={120}
                dir="rtl"
              />
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={t('form.displayOrder')} required hint={t('form.displayOrderHint')}>
              <Input
                type="number"
                min={0}
                max={10000}
                value={form.displayOrder}
                onChange={(e) => setForm((f) => ({ ...f, displayOrder: e.target.value }))}
                required
              />
            </Field>
            <Field label={t('form.isActive')}>
              <label className="flex h-9 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.isActive}
                  onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))}
                  disabled={editingId !== null && form.code === PROTECTED_CODE && form.isActive}
                />
                {t('form.isActiveLabel')}
              </label>
            </Field>
          </div>
        </form>
      </Modal>
    </div>
  );
}
