'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Copy, Lock, Pencil, Plus, Sparkles, Trash2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataTable, type Column } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input, Textarea } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { useToast } from '@/components/ui/toast';
import { RoleTemplatePicker } from '@/components/admin/roles/role-template-picker';
import { ApiError, rolesApi } from '@/lib/api';
import type { RoleSummary } from '@/lib/api-types';
import { hasCapability } from '@/lib/auth';

/**
 * Phase C — C8: /admin/roles — list of every tenant role.
 *
 * Two write paths are exposed:
 *   • "New role" — creates a custom role from scratch (modal),
 *     redirects to the editor for tab-by-tab configuration.
 *   • "Duplicate" — clones any role (system or custom) into a new
 *     editable role. System roles ONLY expose this action — their
 *     direct edit is blocked by the C2 service guard with
 *     `role.system_immutable`.
 *
 * Capability gates (mirrored server-side):
 *   • roles.read  → list, get (everyone with the cap)
 *   • roles.write → create, update, delete, duplicate, scopes,
 *                   field-permissions
 */

interface CreateFormState {
  code: string;
  nameEn: string;
  nameAr: string;
  level: string;
  description: string;
}

const EMPTY_CREATE: CreateFormState = {
  code: '',
  nameEn: '',
  nameAr: '',
  level: '30',
  description: '',
};

interface DuplicateFormState {
  code: string;
  nameEn: string;
  nameAr: string;
  description: string;
}

const EMPTY_DUPLICATE: DuplicateFormState = { code: '', nameEn: '', nameAr: '', description: '' };

export default function RolesAdminPage(): JSX.Element {
  const t = useTranslations('admin.roles');
  const tCommon = useTranslations('admin.common');
  const router = useRouter();
  const { toast } = useToast();

  const canWrite = hasCapability('roles.write');

  const [rows, setRows] = useState<RoleSummary[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Create modal
  const [createOpen, setCreateOpen] = useState<boolean>(false);
  const [createForm, setCreateForm] = useState<CreateFormState>(EMPTY_CREATE);
  const [submittingCreate, setSubmittingCreate] = useState<boolean>(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Duplicate modal
  const [dupSource, setDupSource] = useState<RoleSummary | null>(null);
  const [dupForm, setDupForm] = useState<DuplicateFormState>(EMPTY_DUPLICATE);
  const [submittingDup, setSubmittingDup] = useState<boolean>(false);
  const [dupError, setDupError] = useState<string | null>(null);

  // D5.16 — Template picker state. The picker is the safer
  // alternative to the duplicate flow: it ships curated capability
  // sets + safe field-permission denies + sensible scope defaults,
  // routed through the existing D5.14 dependency-check + D5.15-B
  // version-capture chain.
  const [templatePickerOpen, setTemplatePickerOpen] = useState<boolean>(false);

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const list = await rolesApi.list();
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

  function openCreate(): void {
    setCreateForm(EMPTY_CREATE);
    setCreateError(null);
    setCreateOpen(true);
  }

  function openDuplicate(source: RoleSummary): void {
    setDupSource(source);
    setDupForm({
      code: '',
      nameEn: `${source.nameEn} (copy)`,
      nameAr: `${source.nameAr} — نسخة`,
      description: source.description ?? '',
    });
    setDupError(null);
  }

  async function onCreate(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setSubmittingCreate(true);
    setCreateError(null);
    try {
      const created = await rolesApi.create({
        code: createForm.code.trim(),
        nameEn: createForm.nameEn.trim(),
        nameAr: createForm.nameAr.trim(),
        level: Number.parseInt(createForm.level, 10),
        description: createForm.description.trim() || null,
      });
      toast({ tone: 'success', title: t('createdToast', { name: created.nameEn }) });
      setCreateOpen(false);
      router.push(`/admin/roles/${created.id}`);
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSubmittingCreate(false);
    }
  }

  async function onDuplicate(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (!dupSource) return;
    setSubmittingDup(true);
    setDupError(null);
    try {
      const cloned = await rolesApi.duplicate(dupSource.id, {
        code: dupForm.code.trim(),
        nameEn: dupForm.nameEn.trim(),
        nameAr: dupForm.nameAr.trim(),
        description: dupForm.description.trim() || null,
      });
      toast({
        tone: 'success',
        title: t('duplicatedToast', { from: dupSource.nameEn, to: cloned.nameEn }),
      });
      setDupSource(null);
      router.push(`/admin/roles/${cloned.id}`);
    } catch (err) {
      setDupError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSubmittingDup(false);
    }
  }

  async function onDelete(row: RoleSummary): Promise<void> {
    if (!window.confirm(t('deleteConfirm', { name: row.nameEn }))) return;
    try {
      await rolesApi.remove(row.id);
      toast({ tone: 'success', title: t('deletedToast', { name: row.nameEn }) });
      await reload();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      toast({ tone: 'error', title: msg });
    }
  }

  const columns: ReadonlyArray<Column<RoleSummary>> = [
    {
      key: 'code',
      header: t('cols.code'),
      render: (r) => <code className="font-mono text-xs">{r.code}</code>,
    },
    {
      key: 'name',
      header: t('cols.name'),
      render: (r) => (
        <div className="flex flex-col leading-tight">
          <span className="font-medium text-ink-primary">{r.nameEn}</span>
          <span className="text-xs text-ink-tertiary">{r.nameAr}</span>
        </div>
      ),
    },
    {
      key: 'level',
      header: t('cols.level'),
      render: (r) => <span className="text-xs text-ink-secondary">{r.level}</span>,
    },
    {
      key: 'type',
      header: t('cols.type'),
      render: (r) =>
        r.isSystem ? (
          <Badge tone="inactive">
            <Lock className="me-1 inline h-3 w-3" aria-hidden="true" />
            {t('typeSystem')}
          </Badge>
        ) : (
          <Badge tone="info">{t('typeCustom')}</Badge>
        ),
    },
    {
      key: 'caps',
      header: t('cols.capabilities'),
      render: (r) => <span className="text-xs text-ink-secondary">{r.capabilitiesCount}</span>,
    },
    {
      key: 'description',
      header: t('cols.description'),
      render: (r) =>
        r.description ? (
          <span className="line-clamp-1 text-xs text-ink-secondary" title={r.description}>
            {r.description}
          </span>
        ) : (
          <span className="text-xs text-ink-tertiary">—</span>
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
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                onClick={() => setTemplatePickerOpen(true)}
                data-testid="role-template-picker-open"
              >
                <Sparkles className="h-4 w-4" aria-hidden="true" />
                {t('templates.picker.openCta')}
              </Button>
              <Button onClick={openCreate}>
                <Plus className="h-4 w-4" aria-hidden="true" />
                {t('newRole')}
              </Button>
            </div>
          ) : null
        }
      />

      {error ? (
        <Notice tone="error">
          <div className="flex items-start justify-between gap-2">
            <span>{error}</span>
            <Button variant="ghost" size="sm" onClick={() => void reload()}>
              {tCommon('retry')}
            </Button>
          </div>
        </Notice>
      ) : null}

      {!loading && rows.length === 0 ? (
        <EmptyState title={t('emptyTitle')} body={t('emptyBody')} />
      ) : (
        <DataTable<RoleSummary>
          columns={columns}
          rows={rows}
          keyOf={(r) => r.id}
          loading={loading}
          skeletonRows={6}
          rowActions={(r) => (
            <>
              <Link
                href={`/admin/roles/${r.id}`}
                className="inline-flex h-8 items-center justify-center rounded-md border border-surface-border bg-surface-card px-3 text-xs font-medium text-ink-primary hover:bg-brand-50 hover:border-brand-200"
              >
                <Pencil className="me-1 h-3.5 w-3.5" aria-hidden="true" />
                {r.isSystem ? t('view') : t('edit')}
              </Link>
              {canWrite ? (
                <Button variant="ghost" size="sm" onClick={() => openDuplicate(r)}>
                  <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                  {t('duplicate')}
                </Button>
              ) : null}
              {canWrite && !r.isSystem ? (
                <Button variant="ghost" size="sm" onClick={() => void onDelete(r)}>
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  {tCommon('delete')}
                </Button>
              ) : null}
            </>
          )}
        />
      )}

      {/* Create modal */}
      <Modal
        open={createOpen}
        title={t('createTitle')}
        onClose={() => setCreateOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              {tCommon('cancel')}
            </Button>
            <Button type="submit" form="roleCreateForm" loading={submittingCreate}>
              {t('createSubmit')}
            </Button>
          </>
        }
      >
        <form id="roleCreateForm" className="flex flex-col gap-3" onSubmit={onCreate}>
          {createError ? <Notice tone="error">{createError}</Notice> : null}
          <Field label={t('form.code')} required hint={t('form.codeHint')}>
            <Input
              value={createForm.code}
              onChange={(e) => setCreateForm({ ...createForm, code: e.target.value })}
              required
              minLength={2}
              maxLength={64}
              pattern="[a-z0-9_]+"
            />
          </Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={t('form.nameEn')} required>
              <Input
                value={createForm.nameEn}
                onChange={(e) => setCreateForm({ ...createForm, nameEn: e.target.value })}
                required
                maxLength={120}
              />
            </Field>
            <Field label={t('form.nameAr')} required>
              <Input
                value={createForm.nameAr}
                onChange={(e) => setCreateForm({ ...createForm, nameAr: e.target.value })}
                required
                maxLength={120}
              />
            </Field>
          </div>
          <Field label={t('form.level')} required hint={t('form.levelHint')}>
            <Input
              type="number"
              min={0}
              max={100}
              value={createForm.level}
              onChange={(e) => setCreateForm({ ...createForm, level: e.target.value })}
              required
            />
          </Field>
          <Field label={t('form.description')}>
            <Textarea
              value={createForm.description}
              onChange={(e) => setCreateForm({ ...createForm, description: e.target.value })}
              maxLength={500}
              rows={2}
            />
          </Field>
        </form>
      </Modal>

      {/* Duplicate modal */}
      <Modal
        open={dupSource !== null}
        title={dupSource ? t('duplicateTitle', { name: dupSource.nameEn }) : t('duplicate')}
        onClose={() => setDupSource(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDupSource(null)}>
              {tCommon('cancel')}
            </Button>
            <Button type="submit" form="roleDupForm" loading={submittingDup}>
              {t('duplicateSubmit')}
            </Button>
          </>
        }
      >
        <form id="roleDupForm" className="flex flex-col gap-3" onSubmit={onDuplicate}>
          {dupError ? <Notice tone="error">{dupError}</Notice> : null}
          <p className="text-sm text-ink-secondary">{t('duplicateIntro')}</p>
          <Field label={t('form.code')} required hint={t('form.codeHint')}>
            <Input
              value={dupForm.code}
              onChange={(e) => setDupForm({ ...dupForm, code: e.target.value })}
              required
              minLength={2}
              maxLength={64}
              pattern="[a-z0-9_]+"
            />
          </Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={t('form.nameEn')} required>
              <Input
                value={dupForm.nameEn}
                onChange={(e) => setDupForm({ ...dupForm, nameEn: e.target.value })}
                required
                maxLength={120}
              />
            </Field>
            <Field label={t('form.nameAr')} required>
              <Input
                value={dupForm.nameAr}
                onChange={(e) => setDupForm({ ...dupForm, nameAr: e.target.value })}
                required
                maxLength={120}
              />
            </Field>
          </div>
          <Field label={t('form.description')}>
            <Textarea
              value={dupForm.description}
              onChange={(e) => setDupForm({ ...dupForm, description: e.target.value })}
              maxLength={500}
              rows={2}
            />
          </Field>
        </form>
      </Modal>

      {/* D5.16 — curated template picker. Sits alongside the
          existing duplicate flow as the safer "Create from
          template" path. Successful creates route to the new
          role's detail page so the admin can review the seeded
          capabilities / scopes / field denies before assigning
          users. */}
      <RoleTemplatePicker
        open={templatePickerOpen}
        onClose={() => setTemplatePickerOpen(false)}
        onCreated={async (newRoleId) => {
          await reload();
          router.push(`/admin/roles/${newRoleId}`);
        }}
      />
    </div>
  );
}
