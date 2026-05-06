'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowLeft, Lock, Save } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import { useToast } from '@/components/ui/toast';
import { RolePreviewTab } from '@/components/admin/roles/role-preview-tab';
import { ApiError, rolesApi } from '@/lib/api';
import type {
  CapabilityCatalogueEntry,
  FieldCatalogueEntry,
  RoleDetail,
  RoleFieldPermissionRow,
  RoleScopeRow,
} from '@/lib/api-types';
import { hasCapability } from '@/lib/auth';
import { cn } from '@/lib/utils';

/**
 * Phase C — C8: /admin/roles/[id] — role editor.
 *
 * Four tabs:
 *   1. Basic info — name (en/ar), level, description.
 *   2. Capability matrix — every catalogue capability, grouped by
 *      module prefix, with a checkbox per capability.
 *   3. Data scope — radio per resource (own/team/company/country/global).
 *   4. Field permissions — table of (resource × field) pairs from the
 *      static field catalogue, with canRead + canWrite checkboxes.
 *
 * System roles (`isSystem = true`) render every control in read-only
 * mode + show a prominent "Duplicate" prompt. Saves are blocked at
 * the server (C2) regardless; the UI just keeps the operator from
 * trying.
 */

const SCOPE_RESOURCES: ReadonlyArray<RoleScopeRow['resource']> = [
  'lead',
  'captain',
  'followup',
  'whatsapp.conversation',
];
const SCOPE_VALUES: ReadonlyArray<RoleScopeRow['scope']> = [
  'own',
  'team',
  'company',
  'country',
  'global',
];

type TabKey = 'info' | 'capabilities' | 'scopes' | 'fields' | 'preview';

export default function RoleEditorPage(): JSX.Element {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const t = useTranslations('admin.roles');
  const tCommon = useTranslations('admin.common');
  const { toast } = useToast();

  const canWrite = hasCapability('roles.write');
  const canPreview = hasCapability('permission.preview');

  const [role, setRole] = useState<RoleDetail | null>(null);
  const [capabilities, setCapabilities] = useState<CapabilityCatalogueEntry[]>([]);
  const [fieldCatalogue, setFieldCatalogue] = useState<FieldCatalogueEntry[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>('info');

  const reload = useCallback(async (): Promise<void> => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const [r, caps, fields] = await Promise.all([
        rolesApi.get(id),
        rolesApi.listCapabilities().catch(() => [] as CapabilityCatalogueEntry[]),
        rolesApi.listFieldCatalogue().catch(() => [] as FieldCatalogueEntry[]),
      ]);
      setRole(r);
      setCapabilities(caps);
      setFieldCatalogue(fields);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (loading && !role) {
    return (
      <p className="rounded-lg border border-surface-border bg-surface-card px-4 py-10 text-center text-sm text-ink-secondary shadow-card">
        {tCommon('loading')}
      </p>
    );
  }
  if (error && !role) {
    return (
      <Notice tone="error">
        <div className="flex items-start justify-between gap-2">
          <span>{error}</span>
          <Button variant="ghost" size="sm" onClick={() => void reload()}>
            {tCommon('retry')}
          </Button>
        </div>
      </Notice>
    );
  }
  if (!role) return <></>;

  // System roles disable every editing surface in this page.
  // canWrite from the user's role gates the UI further (a tenant
  // user without roles.write can only view).
  const editable = canWrite && !role.isSystem;

  return (
    <div className="flex flex-col gap-4">
      <Link
        href="/admin/roles"
        className="inline-flex items-center gap-1 text-xs font-medium text-ink-secondary hover:text-brand-700"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> {t('backToList')}
      </Link>

      {/* Header */}
      <header className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-surface-border bg-surface-card p-5 shadow-card">
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold leading-tight text-ink-primary">{role.nameEn}</h1>
            {role.isSystem ? (
              <Badge tone="inactive">
                <Lock className="me-1 inline h-3 w-3" aria-hidden="true" />
                {t('typeSystem')}
              </Badge>
            ) : (
              <Badge tone="info">{t('typeCustom')}</Badge>
            )}
            <Badge tone="healthy">
              {t('cols.level')}: {role.level}
            </Badge>
          </div>
          <code className="font-mono text-xs text-ink-tertiary">{role.code}</code>
          {role.description ? (
            <p className="mt-1 text-sm text-ink-secondary">{role.description}</p>
          ) : null}
        </div>
      </header>

      {role.isSystem ? (
        <Notice tone="info">
          <span>{t('systemRoleNotice')}</span>
        </Notice>
      ) : null}

      {/* Tabs */}
      <nav className="flex flex-wrap gap-1 border-b border-surface-border" aria-label="Tabs">
        {(
          [
            'info',
            'capabilities',
            'scopes',
            'fields',
            ...(canPreview ? (['preview'] as const) : []),
          ] as const
        ).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setActiveTab(key)}
            className={cn(
              'inline-flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-medium transition-colors',
              activeTab === key
                ? 'border-brand-600 text-brand-700'
                : 'border-transparent text-ink-secondary hover:text-ink-primary',
            )}
          >
            {t(`tabs.${key}`)}
          </button>
        ))}
      </nav>

      {activeTab === 'info' ? (
        <BasicInfoTab role={role} editable={editable} onSaved={reload} toast={toast} />
      ) : null}
      {activeTab === 'capabilities' ? (
        <CapabilitiesTab
          role={role}
          capabilities={capabilities}
          editable={editable}
          onSaved={reload}
          toast={toast}
        />
      ) : null}
      {activeTab === 'scopes' ? (
        <ScopesTab role={role} editable={editable} onSaved={reload} toast={toast} />
      ) : null}
      {activeTab === 'fields' ? (
        <FieldPermissionsTab
          role={role}
          fieldCatalogue={fieldCatalogue}
          editable={editable}
          onSaved={reload}
          toast={toast}
        />
      ) : null}
      {activeTab === 'preview' && canPreview ? <RolePreviewTab roleId={role.id} /> : null}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Tab 1 — Basic info
// ────────────────────────────────────────────────────────────────────

interface TabProps {
  role: RoleDetail;
  editable: boolean;
  onSaved: () => Promise<void>;
  toast: ReturnType<typeof useToast>['toast'];
}

function BasicInfoTab({ role, editable, onSaved, toast }: TabProps): JSX.Element {
  const t = useTranslations('admin.roles');
  const tCommon = useTranslations('admin.common');
  const [nameEn, setNameEn] = useState(role.nameEn);
  const [nameAr, setNameAr] = useState(role.nameAr);
  const [level, setLevel] = useState(String(role.level));
  const [description, setDescription] = useState(role.description ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await rolesApi.update(role.id, {
        nameEn: nameEn.trim(),
        nameAr: nameAr.trim(),
        level: Number.parseInt(level, 10),
        description: description.trim() || null,
      });
      toast({ tone: 'success', title: t('savedToast') });
      await onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="flex flex-col gap-3 rounded-lg border border-surface-border bg-surface-card p-5 shadow-card"
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label={t('form.nameEn')}>
          <Input
            value={nameEn}
            onChange={(e) => setNameEn(e.target.value)}
            disabled={!editable}
            readOnly={!editable}
          />
        </Field>
        <Field label={t('form.nameAr')}>
          <Input
            value={nameAr}
            onChange={(e) => setNameAr(e.target.value)}
            disabled={!editable}
            readOnly={!editable}
          />
        </Field>
      </div>
      <Field label={t('form.level')} hint={t('form.levelHint')}>
        <Input
          type="number"
          min={0}
          max={100}
          value={level}
          onChange={(e) => setLevel(e.target.value)}
          disabled={!editable}
          readOnly={!editable}
        />
      </Field>
      <Field label={t('form.description')}>
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={500}
          rows={3}
          disabled={!editable}
          readOnly={!editable}
        />
      </Field>
      {editable ? (
        <div className="flex items-center justify-end">
          <Button type="submit" loading={submitting}>
            <Save className="h-4 w-4" aria-hidden="true" />
            {tCommon('save')}
          </Button>
        </div>
      ) : null}
    </form>
  );
}

// ────────────────────────────────────────────────────────────────────
// Tab 2 — Capability matrix
// ────────────────────────────────────────────────────────────────────

interface CapabilitiesTabProps extends TabProps {
  capabilities: CapabilityCatalogueEntry[];
}

function CapabilitiesTab({
  role,
  capabilities,
  editable,
  onSaved,
  toast,
}: CapabilitiesTabProps): JSX.Element {
  const t = useTranslations('admin.roles');
  const tCommon = useTranslations('admin.common');
  const [selected, setSelected] = useState<Set<string>>(() => new Set(role.capabilities));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Group by module prefix (lead.*, whatsapp.*, etc.) — capability
  // codes are dot-separated; the prefix before the first '.' is the
  // module bucket.
  const grouped = useMemo(() => {
    const map = new Map<string, CapabilityCatalogueEntry[]>();
    for (const c of capabilities) {
      const moduleKey = c.code.split('.')[0] ?? 'misc';
      const arr = map.get(moduleKey);
      if (arr) arr.push(c);
      else map.set(moduleKey, [c]);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [capabilities]);

  function toggle(code: string): void {
    if (!editable) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }

  function toggleModule(modCaps: CapabilityCatalogueEntry[], on: boolean): void {
    if (!editable) return;
    setSelected((prev) => {
      const next = new Set(prev);
      for (const c of modCaps) {
        if (on) next.add(c.code);
        else next.delete(c.code);
      }
      return next;
    });
  }

  async function onSubmit(): Promise<void> {
    setSubmitting(true);
    setError(null);
    try {
      await rolesApi.update(role.id, { capabilities: Array.from(selected).sort() });
      toast({ tone: 'success', title: t('savedToast') });
      await onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-surface-border bg-surface-card p-5 shadow-card">
      {error ? <Notice tone="error">{error}</Notice> : null}
      <p className="text-sm text-ink-secondary">{t('capabilitiesIntro')}</p>
      {grouped.map(([moduleKey, modCaps]) => {
        const allOn = modCaps.every((c) => selected.has(c.code));
        return (
          <section
            key={moduleKey}
            className="rounded-md border border-surface-border bg-surface px-3 py-2"
          >
            <header className="mb-2 flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-tertiary">
                {moduleKey}
              </h3>
              {editable ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => toggleModule(modCaps, !allOn)}
                  disabled={submitting}
                >
                  {allOn ? t('deselectAll') : t('selectAll')}
                </Button>
              ) : null}
            </header>
            <ul className="grid grid-cols-1 gap-1 sm:grid-cols-2">
              {modCaps.map((c) => {
                const checked = selected.has(c.code);
                return (
                  <li key={c.code}>
                    <label
                      className={cn(
                        'flex cursor-pointer items-start gap-2 rounded-md px-2 py-1 text-sm hover:bg-brand-50/40',
                        editable ? '' : 'cursor-not-allowed opacity-80',
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggle(c.code)}
                        disabled={!editable || submitting}
                        className="mt-0.5"
                      />
                      <span className="flex flex-col leading-tight">
                        <code className="font-mono text-xs text-ink-primary">{c.code}</code>
                        <span className="text-xs text-ink-tertiary">{c.description}</span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
      {editable ? (
        <div className="flex items-center justify-end">
          <Button onClick={() => void onSubmit()} loading={submitting}>
            <Save className="h-4 w-4" aria-hidden="true" />
            {tCommon('save')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Tab 3 — Data scope
// ────────────────────────────────────────────────────────────────────

function ScopesTab({ role, editable, onSaved, toast }: TabProps): JSX.Element {
  const t = useTranslations('admin.roles');
  const tCommon = useTranslations('admin.common');
  const [scopes, setScopes] = useState<Map<string, RoleScopeRow['scope']>>(
    () => new Map(role.scopes.map((s) => [s.resource, s.scope])),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function setScope(resource: RoleScopeRow['resource'], scope: RoleScopeRow['scope']): void {
    if (!editable) return;
    setScopes((prev) => {
      const next = new Map(prev);
      next.set(resource, scope);
      return next;
    });
  }

  async function onSubmit(): Promise<void> {
    setSubmitting(true);
    setError(null);
    try {
      const payload: RoleScopeRow[] = SCOPE_RESOURCES.map((r) => ({
        resource: r,
        scope: scopes.get(r) ?? 'global',
      }));
      await rolesApi.putScopes(role.id, payload);
      toast({ tone: 'success', title: t('savedToast') });
      await onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-surface-border bg-surface-card p-5 shadow-card">
      {error ? <Notice tone="error">{error}</Notice> : null}
      <p className="text-sm text-ink-secondary">{t('scopesIntro')}</p>
      <ul className="flex flex-col gap-2">
        {SCOPE_RESOURCES.map((resource) => {
          const value = scopes.get(resource) ?? 'global';
          return (
            <li
              key={resource}
              className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-surface-border bg-surface px-3 py-2"
            >
              <span className="text-sm font-medium text-ink-primary">
                {t(`scopes.resources.${resource}` as 'scopes.resources.lead')}
              </span>
              <Select
                value={value}
                onChange={(e) => setScope(resource, e.target.value as RoleScopeRow['scope'])}
                disabled={!editable || submitting}
                className="w-44"
              >
                {SCOPE_VALUES.map((s) => (
                  <option key={s} value={s}>
                    {t(`scopes.values.${s}` as 'scopes.values.global')}
                  </option>
                ))}
              </Select>
            </li>
          );
        })}
      </ul>
      {editable ? (
        <div className="flex items-center justify-end">
          <Button onClick={() => void onSubmit()} loading={submitting}>
            <Save className="h-4 w-4" aria-hidden="true" />
            {tCommon('save')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Tab 4 — Field permissions
// ────────────────────────────────────────────────────────────────────

interface FieldPermissionsTabProps extends TabProps {
  fieldCatalogue: FieldCatalogueEntry[];
}

function FieldPermissionsTab({
  role,
  fieldCatalogue,
  editable,
  onSaved,
  toast,
}: FieldPermissionsTabProps): JSX.Element {
  const t = useTranslations('admin.roles');
  const tCommon = useTranslations('admin.common');

  /**
   * Build the working set: for every catalogue entry, find the
   * existing FieldPermission row (if any). Defaults to the
   * catalogue's `defaultRead` / `defaultWrite` when no row exists
   * — matches the server's runtime behaviour.
   */
  const initialMap = useMemo(() => {
    const m = new Map<string, { canRead: boolean; canWrite: boolean }>();
    for (const entry of fieldCatalogue) {
      const key = `${entry.resource}::${entry.field}`;
      const existing = role.fieldPermissions.find(
        (p) => p.resource === entry.resource && p.field === entry.field,
      );
      m.set(key, {
        canRead: existing ? existing.canRead : entry.defaultRead,
        canWrite: existing ? existing.canWrite : entry.defaultWrite,
      });
    }
    return m;
  }, [fieldCatalogue, role.fieldPermissions]);

  const [working, setWorking] = useState(initialMap);
  useEffect(() => {
    setWorking(initialMap);
  }, [initialMap]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function setCell(
    resource: string,
    field: string,
    column: 'canRead' | 'canWrite',
    value: boolean,
  ): void {
    if (!editable) return;
    setWorking((prev) => {
      const next = new Map(prev);
      const key = `${resource}::${field}`;
      const cur = next.get(key) ?? { canRead: true, canWrite: true };
      next.set(key, { ...cur, [column]: value });
      return next;
    });
  }

  async function onSubmit(): Promise<void> {
    setSubmitting(true);
    setError(null);
    try {
      // Only PUT rows that DEVIATE from the catalogue's default —
      // matches the server's "absent row = default permissive"
      // semantics. This keeps the audit + DB compact and lets a
      // future catalogue change in default-state propagate without
      // every tenant carrying a row.
      const permissions: RoleFieldPermissionRow[] = [];
      for (const entry of fieldCatalogue) {
        const key = `${entry.resource}::${entry.field}`;
        const cur = working.get(key);
        if (!cur) continue;
        if (cur.canRead !== entry.defaultRead || cur.canWrite !== entry.defaultWrite) {
          permissions.push({
            resource: entry.resource,
            field: entry.field,
            canRead: cur.canRead,
            canWrite: cur.canWrite,
          });
        }
      }
      await rolesApi.putFieldPermissions(role.id, permissions);
      toast({ tone: 'success', title: t('savedToast') });
      await onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  // Group catalogue by resource for readability.
  const byResource = useMemo(() => {
    const m = new Map<string, FieldCatalogueEntry[]>();
    for (const e of fieldCatalogue) {
      const arr = m.get(e.resource);
      if (arr) arr.push(e);
      else m.set(e.resource, [e]);
    }
    return Array.from(m.entries());
  }, [fieldCatalogue]);

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-surface-border bg-surface-card p-5 shadow-card">
      {error ? <Notice tone="error">{error}</Notice> : null}
      <p className="text-sm text-ink-secondary">{t('fieldsIntro')}</p>
      {byResource.map(([resource, entries]) => (
        <section key={resource} className="overflow-hidden rounded-md border border-surface-border">
          <header className="border-b border-surface-border bg-surface px-3 py-2 text-xs font-semibold uppercase tracking-wide text-ink-tertiary">
            {resource}
          </header>
          <table className="w-full text-sm">
            <thead className="bg-surface-card text-xs text-ink-tertiary">
              <tr>
                <th className="px-3 py-2 text-start font-medium">{t('fields.field')}</th>
                <th className="w-24 px-3 py-2 text-center font-medium">{t('fields.canRead')}</th>
                <th className="w-24 px-3 py-2 text-center font-medium">{t('fields.canWrite')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-border">
              {entries.map((entry) => {
                const key = `${entry.resource}::${entry.field}`;
                const cur = working.get(key) ?? {
                  canRead: entry.defaultRead,
                  canWrite: entry.defaultWrite,
                };
                return (
                  <tr key={key} className="hover:bg-brand-50/30">
                    <td className="px-3 py-2">
                      <div className="flex flex-col leading-tight">
                        <code className="font-mono text-xs text-ink-primary">{entry.field}</code>
                        <span className="text-[11px] text-ink-tertiary">
                          {entry.labelEn}
                          {entry.sensitive ? (
                            <span className="ms-1 inline-flex items-center gap-0.5 rounded bg-status-warning/10 px-1 text-[10px] uppercase text-status-warning">
                              {t('fields.sensitive')}
                            </span>
                          ) : null}
                        </span>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-center">
                      <input
                        type="checkbox"
                        checked={cur.canRead}
                        onChange={(e) =>
                          setCell(entry.resource, entry.field, 'canRead', e.target.checked)
                        }
                        disabled={!editable || submitting}
                        aria-label={t('fields.canRead')}
                      />
                    </td>
                    <td className="px-3 py-2 text-center">
                      <input
                        type="checkbox"
                        checked={cur.canWrite}
                        onChange={(e) =>
                          setCell(entry.resource, entry.field, 'canWrite', e.target.checked)
                        }
                        disabled={!editable || submitting}
                        aria-label={t('fields.canWrite')}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      ))}
      {editable ? (
        <div className="flex items-center justify-end">
          <Button onClick={() => void onSubmit()} loading={submitting}>
            <Save className="h-4 w-4" aria-hidden="true" />
            {tCommon('save')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
