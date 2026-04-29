'use client';

import { useEffect, useMemo, useState, useCallback, type FormEvent } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { Plus } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataTable, type Column } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input, Select } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { ApiError, rolesApi, teamsApi, usersApi } from '@/lib/api';
import type { AdminUser, RoleSummary, Team, UserStatus } from '@/lib/api-types';

interface CreateForm {
  email: string;
  name: string;
  password: string;
  roleId: string;
  teamId: string;
  phone: string;
  language: 'ar' | 'en';
  status: UserStatus;
}

const EMPTY_CREATE_FORM: CreateForm = {
  email: '',
  name: '',
  password: '',
  roleId: '',
  teamId: '',
  phone: '',
  language: 'en',
  status: 'active',
};

interface EditForm {
  name: string;
  roleId: string;
  teamId: string;
  phone: string;
  language: 'ar' | 'en';
  status: UserStatus;
}

const STATUSES: readonly UserStatus[] = ['active', 'invited', 'disabled'] as const;

function statusTone(s: UserStatus): 'healthy' | 'warning' | 'inactive' {
  if (s === 'active') return 'healthy';
  if (s === 'invited') return 'warning';
  return 'inactive';
}

export default function UsersPage(): JSX.Element {
  const t = useTranslations('admin.users');
  const tCommon = useTranslations('admin.common');
  const locale = useLocale();
  const roleLabel = useCallback(
    (r: { nameEn: string; nameAr: string }) => (locale === 'ar' ? r.nameAr : r.nameEn),
    [locale],
  );

  const [rows, setRows] = useState<AdminUser[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [roles, setRoles] = useState<RoleSummary[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [filterTeamId, setFilterTeamId] = useState<string>('');
  const [filterRoleId, setFilterRoleId] = useState<string>('');
  const [filterStatus, setFilterStatus] = useState<UserStatus | ''>('');

  const [creating, setCreating] = useState<boolean>(false);
  const [editing, setEditing] = useState<AdminUser | null>(null);
  const [createForm, setCreateForm] = useState<CreateForm>(EMPTY_CREATE_FORM);
  const [editForm, setEditForm] = useState<EditForm | null>(null);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [formError, setFormError] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const [page, allTeams, allRoles] = await Promise.all([
        usersApi.list({
          teamId: filterTeamId || undefined,
          roleId: filterRoleId || undefined,
          status: filterStatus || undefined,
          limit: 200,
        }),
        teamsApi.list(),
        rolesApi.list(),
      ]);
      setRows(page.items);
      setTeams(allTeams);
      setRoles(allRoles);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [filterTeamId, filterRoleId, filterStatus]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const teamById = useMemo(() => new Map(teams.map((t2) => [t2.id, t2])), [teams]);
  const roleById = useMemo(() => new Map(roles.map((r) => [r.id, r])), [roles]);

  function openNew(): void {
    setEditing(null);
    setCreateForm({
      ...EMPTY_CREATE_FORM,
      roleId: filterRoleId || roles[0]?.id || '',
      teamId: filterTeamId || '',
    });
    setFormError(null);
    setCreating(true);
  }

  function openEdit(row: AdminUser): void {
    setCreating(false);
    setEditing(row);
    setEditForm({
      name: row.name,
      roleId: row.roleId,
      teamId: row.teamId ?? '',
      phone: row.phone ?? '',
      language: row.language === 'ar' ? 'ar' : 'en',
      status: row.status,
    });
    setFormError(null);
  }

  function closeForm(): void {
    setCreating(false);
    setEditing(null);
    setEditForm(null);
  }

  async function onSubmitCreate(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setSubmitting(true);
    setFormError(null);
    try {
      await usersApi.create({
        email: createForm.email,
        name: createForm.name,
        password: createForm.password,
        roleId: createForm.roleId,
        teamId: createForm.teamId || null,
        phone: createForm.phone || undefined,
        language: createForm.language,
        status: createForm.status,
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

  async function onSubmitEdit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (!editing || !editForm) return;
    setSubmitting(true);
    setFormError(null);
    try {
      await usersApi.update(editing.id, {
        name: editForm.name,
        roleId: editForm.roleId,
        teamId: editForm.teamId || null,
        phone: editForm.phone || null,
        language: editForm.language,
        status: editForm.status,
      });
      setNotice(tCommon('saved'));
      closeForm();
      await reload();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function onDisable(row: AdminUser): Promise<void> {
    if (!window.confirm(t('disableConfirm'))) return;
    try {
      await usersApi.disable(row.id);
      setNotice(tCommon('saved'));
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  async function onEnable(row: AdminUser): Promise<void> {
    try {
      await usersApi.enable(row.id);
      setNotice(tCommon('saved'));
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  function renderRoleCell(roleId: string): React.ReactNode {
    const r = roleById.get(roleId);
    if (!r) {
      return <code className="font-mono text-xs text-ink-tertiary">{roleId.slice(0, 8)}…</code>;
    }
    return (
      <span className="text-ink-secondary">
        {roleLabel(r)}{' '}
        <code className="ms-1 font-mono text-[11px] text-ink-tertiary">({r.code})</code>
      </span>
    );
  }

  const columns: ReadonlyArray<Column<AdminUser>> = [
    { key: 'name', header: t('name'), render: (r) => r.name },
    {
      key: 'email',
      header: t('email'),
      render: (r) => <span className="text-ink-secondary">{r.email}</span>,
    },
    { key: 'role', header: t('role'), render: (r) => renderRoleCell(r.roleId) },
    {
      key: 'team',
      header: t('team'),
      render: (r) =>
        r.teamId ? (
          (teamById.get(r.teamId)?.name ?? '—')
        ) : (
          <span className="text-ink-tertiary">{t('noTeam')}</span>
        ),
    },
    {
      key: 'status',
      header: t('status'),
      render: (r) => <Badge tone={statusTone(r.status)}>{r.status}</Badge>,
    },
  ];

  const hasActiveFilter = Boolean(filterTeamId || filterRoleId || filterStatus);
  const isEmpty = !loading && !error && rows.length === 0;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          <Button onClick={openNew} disabled={roles.length === 0 || loading}>
            <Plus className="h-4 w-4" />
            {t('newButton')}
          </Button>
        }
      />

      <div className="flex flex-wrap items-end gap-3">
        <div className="w-full max-w-xs">
          <Field label={t('filterByTeam')}>
            <Select value={filterTeamId} onChange={(e) => setFilterTeamId(e.target.value)}>
              <option value="">{tCommon('all')}</option>
              {teams.map((tm) => (
                <option key={tm.id} value={tm.id}>
                  {tm.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="w-full max-w-xs">
          <Field label={t('filterByRole')}>
            <Select value={filterRoleId} onChange={(e) => setFilterRoleId(e.target.value)}>
              <option value="">{tCommon('all')}</option>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {roleLabel(r)} ({r.code})
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="w-full max-w-xs">
          <Field label={t('filterByStatus')}>
            <Select
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value as UserStatus | '')}
            >
              <option value="">{tCommon('all')}</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
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

      {isEmpty ? (
        <EmptyState
          title={hasActiveFilter ? t('emptyFiltered') : t('empty')}
          body={hasActiveFilter ? t('emptyFilteredHint') : t('emptyHint')}
          action={
            hasActiveFilter ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setFilterTeamId('');
                  setFilterRoleId('');
                  setFilterStatus('');
                }}
              >
                {tCommon('clearFilters')}
              </Button>
            ) : (
              <Button variant="primary" size="sm" onClick={openNew} disabled={roles.length === 0}>
                <Plus className="h-4 w-4" />
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
              <Button variant="secondary" size="sm" onClick={() => openEdit(row)}>
                {tCommon('edit')}
              </Button>
              {row.status === 'disabled' ? (
                <Button variant="ghost" size="sm" onClick={() => void onEnable(row)}>
                  {t('enable')}
                </Button>
              ) : (
                <Button variant="ghost" size="sm" onClick={() => void onDisable(row)}>
                  {t('disable')}
                </Button>
              )}
            </>
          )}
        />
      )}

      {/* CREATE modal */}
      <Modal
        open={creating}
        title={t('newTitle')}
        onClose={closeForm}
        footer={
          <>
            <Button variant="ghost" onClick={closeForm}>
              {tCommon('cancel')}
            </Button>
            <Button type="submit" form="userCreateForm" loading={submitting}>
              {tCommon('save')}
            </Button>
          </>
        }
      >
        <form id="userCreateForm" className="flex flex-col gap-3" onSubmit={onSubmitCreate}>
          {formError ? <Notice tone="error">{formError}</Notice> : null}
          <Field label={t('email')} required>
            <Input
              type="email"
              value={createForm.email}
              onChange={(e) => setCreateForm((f) => ({ ...f, email: e.target.value }))}
              required
              maxLength={254}
            />
          </Field>
          <Field label={t('name')} required>
            <Input
              value={createForm.name}
              onChange={(e) => setCreateForm((f) => ({ ...f, name: e.target.value }))}
              required
              maxLength={120}
            />
          </Field>
          <Field label={t('password')} hint={t('passwordHint')} required>
            <Input
              type="password"
              value={createForm.password}
              onChange={(e) => setCreateForm((f) => ({ ...f, password: e.target.value }))}
              required
              minLength={8}
              maxLength={128}
            />
          </Field>
          <Field label={t('role')} required>
            <Select
              value={createForm.roleId}
              onChange={(e) => setCreateForm((f) => ({ ...f, roleId: e.target.value }))}
              required
            >
              <option value="" disabled>
                —
              </option>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {roleLabel(r)} ({r.code})
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('team')}>
            <Select
              value={createForm.teamId}
              onChange={(e) => setCreateForm((f) => ({ ...f, teamId: e.target.value }))}
            >
              <option value="">{t('noTeam')}</option>
              {teams.map((tm) => (
                <option key={tm.id} value={tm.id}>
                  {tm.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('phone')}>
            <Input
              value={createForm.phone}
              onChange={(e) => setCreateForm((f) => ({ ...f, phone: e.target.value }))}
              maxLength={32}
            />
          </Field>
          <Field label={t('language')}>
            <Select
              value={createForm.language}
              onChange={(e) =>
                setCreateForm((f) => ({ ...f, language: e.target.value as 'ar' | 'en' }))
              }
            >
              <option value="en">English</option>
              <option value="ar">العربية</option>
            </Select>
          </Field>
          <Field label={t('status')}>
            <Select
              value={createForm.status}
              onChange={(e) =>
                setCreateForm((f) => ({ ...f, status: e.target.value as UserStatus }))
              }
            >
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </Field>
        </form>
      </Modal>

      {/* EDIT modal */}
      <Modal
        open={editing !== null && editForm !== null}
        title={t('editTitle')}
        onClose={closeForm}
        footer={
          <>
            <Button variant="ghost" onClick={closeForm}>
              {tCommon('cancel')}
            </Button>
            <Button type="submit" form="userEditForm" loading={submitting}>
              {tCommon('save')}
            </Button>
          </>
        }
      >
        {editForm ? (
          <form id="userEditForm" className="flex flex-col gap-3" onSubmit={onSubmitEdit}>
            {formError ? <Notice tone="error">{formError}</Notice> : null}
            <Field label={t('email')}>
              <Input value={editing?.email ?? ''} disabled />
            </Field>
            <Field label={t('name')} required>
              <Input
                value={editForm.name}
                onChange={(e) => setEditForm((f) => (f ? { ...f, name: e.target.value } : f))}
                required
                maxLength={120}
              />
            </Field>
            <Field label={t('role')} required>
              <Select
                value={editForm.roleId}
                onChange={(e) => setEditForm((f) => (f ? { ...f, roleId: e.target.value } : f))}
                required
              >
                {roles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {roleLabel(r)} ({r.code})
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('team')}>
              <Select
                value={editForm.teamId}
                onChange={(e) => setEditForm((f) => (f ? { ...f, teamId: e.target.value } : f))}
              >
                <option value="">{t('noTeam')}</option>
                {teams.map((tm) => (
                  <option key={tm.id} value={tm.id}>
                    {tm.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('phone')}>
              <Input
                value={editForm.phone}
                onChange={(e) => setEditForm((f) => (f ? { ...f, phone: e.target.value } : f))}
                maxLength={32}
              />
            </Field>
            <Field label={t('language')}>
              <Select
                value={editForm.language}
                onChange={(e) =>
                  setEditForm((f) => (f ? { ...f, language: e.target.value as 'ar' | 'en' } : f))
                }
              >
                <option value="en">English</option>
                <option value="ar">العربية</option>
              </Select>
            </Field>
            <Field label={t('status')}>
              <Select
                value={editForm.status}
                onChange={(e) =>
                  setEditForm((f) => (f ? { ...f, status: e.target.value as UserStatus } : f))
                }
              >
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
            </Field>
          </form>
        ) : null}
      </Modal>
    </div>
  );
}
