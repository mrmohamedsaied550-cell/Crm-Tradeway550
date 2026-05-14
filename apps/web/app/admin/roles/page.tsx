'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Copy,
  History,
  Lock,
  Pencil,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  Table,
  Trash2,
  Users2,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Input, Textarea } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { useToast } from '@/components/ui/toast';
import { RoleTemplatePicker } from '@/components/admin/roles/role-template-picker';
import { ApiError, rolesApi } from '@/lib/api';
import type { CapabilityCatalogueEntry, RoleScopeRow, RoleSummary } from '@/lib/api-types';
import { hasCapability } from '@/lib/auth';
import { cn } from '@/lib/utils';

/**
 * Sprint 7 — Roles & Permissions Hybrid UX overview.
 *
 * Replaces the original DataTable surface with a card-based
 * overview that surfaces what an operator actually decides on:
 * who has this role, how broad it is, and how risky it is. The
 * editor at /admin/roles/[id] still owns the per-role detail
 * (now tab-based per Sprint 7.B → 7.G) and the existing
 * capability matrix moves under the editor's Advanced section.
 *
 * Data sources (no mocks, no fabrication):
 *   • rolesApi.list                  → roles + system flag + level
 *   • rolesApi.listCapabilities      → total catalogue size for
 *                                      the permission-coverage chip
 *   • usersApi.list({ limit: 200 })  → per-role member count via
 *                                      groupBy(roleId)
 *
 * Heuristics surfaced as derived chips (clearly labelled, never
 * presented as authoritative metadata):
 *   • Risk = function of capabilitiesCount / level / isSystem
 *   • Module families = first dot-segment of each capability —
 *     not shown here yet because RoleSummary does not carry
 *     `capabilities[]`; surfaced on the editor instead. The
 *     overview keeps a "view modules" link into the editor for
 *     each card.
 *
 * Known gaps (carried forward from Sprint 6 verification):
 *   • Per-role scope summary — RoleSummary has no scopes payload.
 *     The card shows a "View scope in editor" link.
 *   • Last-updated timestamp — no `updatedAt` on RoleSummary.
 *     Hidden on the card with an inline gap chip on the meta row.
 *   • Field-access count — not in summary either. Editor only.
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

const EMPTY_DUPLICATE: DuplicateFormState = {
  code: '',
  nameEn: '',
  nameAr: '',
  description: '',
};

type RoleFilter = 'all' | 'system' | 'custom' | 'admin' | 'sales' | 'tl' | 'highRisk' | 'noMembers';

interface AugmentedRole extends RoleSummary {
  riskLevel: 'low' | 'medium' | 'high';
  family: 'admin' | 'sales' | 'tl' | 'ops' | 'other';
}

const ADMIN_CODE_HINTS = ['super_admin', 'admin', 'tenant_owner'] as const;
const SALES_CODE_HINTS = ['sales', 'agent'] as const;

/**
 * Sprint 8 — TL membership now reads `role.isTeamLeader` from the
 * API. The legacy code-substring / level heuristic stays only as a
 * fallback for the admin / sales / ops categories where there's no
 * persisted flag yet.
 */
function familyOf(role: RoleSummary): AugmentedRole['family'] {
  if (role.isTeamLeader) return 'tl';
  const lower = role.code.toLowerCase();
  if (ADMIN_CODE_HINTS.some((h) => lower.includes(h))) return 'admin';
  if (SALES_CODE_HINTS.some((h) => lower.includes(h))) return 'sales';
  if (role.level >= 80) return 'admin';
  return 'ops';
}

function riskOf(capCount: number, level: number, isSystem: boolean): AugmentedRole['riskLevel'] {
  if (capCount >= 40 || level >= 80) return 'high';
  if (capCount >= 15 || level >= 60 || isSystem) return 'medium';
  return 'low';
}

/**
 * Sprint 8 — short scope summary chip. We surface the broadest
 * (=most-risky) scope value across the role's resources so the
 * card stays one line. The editor's Scope tab is the source of
 * truth for the per-resource picture.
 *
 * Scope ranking (least → most risky):
 *   own < team < company < country < global
 */
const SCOPE_RANK: Record<RoleScopeRow['scope'], number> = {
  own: 0,
  team: 1,
  company: 2,
  country: 3,
  global: 4,
};

function summariseScopes(
  scopes: readonly RoleScopeRow[],
  tHybrid: ReturnType<typeof useTranslations>,
): string {
  if (scopes.length === 0) return tHybrid('card.scopeNone');
  let widest: RoleScopeRow['scope'] = 'own';
  for (const s of scopes) {
    if (SCOPE_RANK[s.scope] > SCOPE_RANK[widest]) widest = s.scope;
  }
  return tHybrid(`card.scopeValue.${widest}` as 'card.scopeValue.own');
}

/** Sprint 8 — small "yyyy-mm-dd" formatter for the Last-updated chip. */
function formatShortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export default function RolesAdminPage(): JSX.Element {
  const t = useTranslations('admin.roles');
  const tHybrid = useTranslations('admin.roles.hybrid');
  const tCommon = useTranslations('admin.common');
  const tNav = useTranslations('admin.sideNav');
  const router = useRouter();
  const { toast } = useToast();

  const canWrite = hasCapability('roles.write');

  const [roles, setRoles] = useState<RoleSummary[]>([]);
  const [catalogue, setCatalogue] = useState<readonly CapabilityCatalogueEntry[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const [query, setQuery] = useState<string>('');
  const [filter, setFilter] = useState<RoleFilter>('all');

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

  // Template picker
  const [templatePickerOpen, setTemplatePickerOpen] = useState<boolean>(false);

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const safe = <T,>(p: Promise<T>, fallback: T): Promise<T> => p.catch(() => fallback);
      // Sprint 8 — `rolesApi.list()` now returns memberCount + scopes
      // + isTeamLeader inline, so the previous `usersApi.list({ limit:
      // 200 })` fan-out (and its truncation gap notice) is gone.
      const [list, caps] = await Promise.all([
        rolesApi.list(),
        safe(rolesApi.listCapabilities(), [] as CapabilityCatalogueEntry[]),
      ]);
      setRoles(list);
      setCatalogue(caps);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const augmented = useMemo<readonly AugmentedRole[]>(() => {
    return roles.map((r) => ({
      ...r,
      riskLevel: riskOf(r.capabilitiesCount, r.level, r.isSystem),
      family: familyOf(r),
    }));
  }, [roles]);

  const filtered = useMemo<readonly AugmentedRole[]>(() => {
    const q = query.trim().toLowerCase();
    return augmented.filter((r) => {
      if (q) {
        const hay = `${r.nameEn} ${r.nameAr} ${r.code} ${r.description ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      switch (filter) {
        case 'all':
          return true;
        case 'system':
          return r.isSystem;
        case 'custom':
          return !r.isSystem;
        case 'admin':
          return r.family === 'admin';
        case 'sales':
          return r.family === 'sales';
        case 'tl':
          return r.family === 'tl';
        case 'highRisk':
          return r.riskLevel === 'high';
        case 'noMembers':
          return r.memberCount === 0;
        default:
          return true;
      }
    });
  }, [augmented, query, filter]);

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

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2 text-xs text-ink-tertiary">
        <Link
          href="/admin/organization"
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 transition-colors hover:bg-brand-50 hover:text-brand-700"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          {tNav('organization')}
        </Link>
        <span aria-hidden="true">›</span>
        <span className="font-medium text-ink-secondary">{tNav('roles')}</span>
      </div>

      <PageHeader
        title={t('title')}
        subtitle={tHybrid('subtitle')}
        actions={
          <div className="flex flex-wrap gap-2">
            {!canWrite ? (
              <Badge tone="neutral" aria-label={tHybrid('readOnly')}>
                {tHybrid('readOnly')}
              </Badge>
            ) : null}
            {canWrite ? (
              <Button
                variant="secondary"
                onClick={() => setTemplatePickerOpen(true)}
                data-testid="role-template-picker-open"
              >
                <Sparkles className="h-4 w-4" aria-hidden="true" />
                {t('templates.picker.openCta')}
              </Button>
            ) : null}
            {canWrite ? (
              <Button onClick={openCreate}>
                <Plus className="h-4 w-4" aria-hidden="true" />
                {t('newRole')}
              </Button>
            ) : null}
          </div>
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

      <section
        aria-label={tHybrid('toolbar.label')}
        className="flex flex-col gap-3 rounded-lg border border-surface-border bg-surface-card p-3 shadow-card sm:flex-row sm:items-center sm:justify-between"
      >
        <div className="relative max-w-sm flex-1">
          <Search
            className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-tertiary"
            aria-hidden="true"
          />
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={tHybrid('toolbar.searchPlaceholder')}
            aria-label={tHybrid('toolbar.searchPlaceholder')}
            className="ps-9"
          />
        </div>
        <div
          role="tablist"
          aria-label={tHybrid('toolbar.filterLabel')}
          className="flex flex-wrap gap-1"
        >
          {(
            [
              ['all', augmented.length],
              ['system', augmented.filter((r) => r.isSystem).length],
              ['custom', augmented.filter((r) => !r.isSystem).length],
              ['admin', augmented.filter((r) => r.family === 'admin').length],
              ['sales', augmented.filter((r) => r.family === 'sales').length],
              ['tl', augmented.filter((r) => r.family === 'tl').length],
              ['highRisk', augmented.filter((r) => r.riskLevel === 'high').length],
              ['noMembers', augmented.filter((r) => r.memberCount === 0).length],
            ] as ReadonlyArray<[RoleFilter, number]>
          ).map(([key, n]) => (
            <FilterChip
              key={key}
              active={filter === key}
              onClick={() => setFilter(key)}
              label={tHybrid(`filters.${key}` as 'filters.all', { n })}
            />
          ))}
        </div>
      </section>

      {loading ? (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <li
              key={i}
              className="h-48 animate-pulse rounded-lg border border-surface-border bg-surface-card"
              aria-hidden="true"
            />
          ))}
        </ul>
      ) : filtered.length === 0 ? (
        <Notice tone="info">
          <p className="text-sm font-medium">{tHybrid('empty.title')}</p>
          <p className="mt-1 text-xs text-ink-secondary">{tHybrid('empty.body')}</p>
        </Notice>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((r) => (
            <RoleCard
              key={r.id}
              role={r}
              catalogueSize={catalogue.length}
              canWrite={canWrite}
              onDuplicate={() => openDuplicate(r)}
              onDelete={() => void onDelete(r)}
              t={t}
              tHybrid={tHybrid}
              tCommon={tCommon}
            />
          ))}
        </ul>
      )}

      <section
        aria-labelledby="roles-advanced"
        className="flex flex-col gap-2 rounded-lg border border-surface-border bg-surface-card p-4 shadow-card"
      >
        <h2
          id="roles-advanced"
          className="text-xs font-semibold uppercase tracking-wide text-ink-tertiary"
        >
          {tHybrid('advanced.title')}
        </h2>
        <p className="text-xs text-ink-secondary">{tHybrid('advanced.body')}</p>
        <ul className="mt-1 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <AdvancedLink
            href="/admin/roles?view=matrix"
            label={tHybrid('advanced.matrix')}
            icon={Table}
            hint={tHybrid('advanced.matrixHint')}
          />
          <AdvancedLink
            href="/admin/audit?entity=Role"
            label={tHybrid('advanced.changeHistory')}
            icon={History}
            hint={tHybrid('advanced.changeHistoryHint')}
          />
        </ul>
      </section>

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

function FilterChip({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}): JSX.Element {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
        active
          ? 'border-brand-200 bg-brand-50 text-brand-700'
          : 'border-surface-border bg-surface-card text-ink-secondary hover:border-brand-200 hover:bg-brand-50/40',
      )}
    >
      {label}
    </button>
  );
}

function RoleCard({
  role,
  catalogueSize,
  canWrite,
  onDuplicate,
  onDelete,
  t,
  tHybrid,
  tCommon,
}: {
  role: AugmentedRole;
  catalogueSize: number;
  canWrite: boolean;
  onDuplicate: () => void;
  onDelete: () => void;
  t: ReturnType<typeof useTranslations>;
  tHybrid: ReturnType<typeof useTranslations>;
  tCommon: ReturnType<typeof useTranslations>;
}): JSX.Element {
  const coverage =
    catalogueSize > 0 ? Math.round((role.capabilitiesCount / catalogueSize) * 100) : null;
  const riskTone: Record<AugmentedRole['riskLevel'], 'healthy' | 'warning' | 'breach'> = {
    low: 'healthy',
    medium: 'warning',
    high: 'breach',
  };
  return (
    <li
      className={cn(
        'flex flex-col gap-3 rounded-lg border bg-surface-card p-4 shadow-card transition-colors hover:border-brand-200',
        role.riskLevel === 'high'
          ? 'border-status-breach/30'
          : role.memberCount === 0
            ? 'border-status-warning/30'
            : 'border-surface-border',
      )}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <Link
            href={`/admin/roles/${role.id}`}
            className="truncate text-base font-semibold text-ink-primary hover:underline"
          >
            {role.nameEn}
          </Link>
          <code className="font-mono text-[11px] text-ink-tertiary">{role.code}</code>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {role.isSystem ? (
            <Badge tone="inactive">
              <Lock className="me-1 inline h-3 w-3" aria-hidden="true" />
              {t('typeSystem')}
            </Badge>
          ) : (
            <Badge tone="info">{t('typeCustom')}</Badge>
          )}
          <Badge tone={riskTone[role.riskLevel]}>
            {tHybrid(`risk.${role.riskLevel}` as 'risk.low')}
          </Badge>
        </div>
      </header>

      {role.description ? (
        <p className="line-clamp-2 text-xs text-ink-secondary">{role.description}</p>
      ) : (
        <p className="text-xs text-ink-tertiary">{tHybrid('noDescription')}</p>
      )}

      <dl className="grid grid-cols-2 gap-y-2 text-xs sm:grid-cols-4">
        <Metric
          label={tHybrid('card.members')}
          value={role.memberCount}
          tone={role.memberCount === 0 ? 'warning' : 'neutral'}
          icon={Users2}
        />
        <Metric
          label={tHybrid('card.capabilities')}
          value={
            coverage === null
              ? `${role.capabilitiesCount}`
              : `${role.capabilitiesCount} · ${coverage}%`
          }
          icon={ShieldCheck}
        />
        <Metric label={tHybrid('card.level')} value={role.level} />
        <Metric
          label={tHybrid('card.scope')}
          value={summariseScopes(role.scopes, tHybrid)}
          hint={
            role.scopes.length === 0
              ? tHybrid('card.scopeGlobalFallback')
              : tHybrid('card.scopeOpenEditor')
          }
        />
      </dl>
      <p className="text-[11px] text-ink-tertiary">
        {tHybrid('card.lastUpdated', { date: formatShortDate(role.updatedAt) })}
      </p>

      {role.memberCount === 0 ? (
        <p className="inline-flex items-center gap-1 text-[11px] text-status-warning">
          <AlertTriangle className="h-3 w-3" aria-hidden="true" />
          {tHybrid('card.noMembers')}
        </p>
      ) : null}

      <footer className="flex flex-wrap items-center gap-2">
        <Link
          href={`/admin/roles/${role.id}`}
          className="inline-flex h-8 items-center gap-1 rounded-md border border-surface-border bg-surface-card px-3 text-xs font-medium text-ink-primary transition-colors hover:border-brand-200 hover:bg-brand-50"
        >
          <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
          {role.isSystem ? t('view') : t('edit')}
        </Link>
        <Link
          href={`/admin/roles/${role.id}#members`}
          className="inline-flex h-8 items-center gap-1 rounded-md border border-surface-border bg-surface-card px-3 text-xs font-medium text-ink-primary transition-colors hover:border-brand-200 hover:bg-brand-50"
        >
          <Users2 className="h-3.5 w-3.5" aria-hidden="true" />
          {tHybrid('card.viewMembers')}
        </Link>
        <Link
          href={`/admin/audit?entity=Role&entityId=${role.id}`}
          className="inline-flex h-8 items-center gap-1 rounded-md border border-surface-border bg-surface-card px-3 text-xs font-medium text-ink-primary transition-colors hover:border-brand-200 hover:bg-brand-50"
        >
          <History className="h-3.5 w-3.5" aria-hidden="true" />
          {tHybrid('card.audit')}
        </Link>
        {canWrite ? (
          <Button variant="ghost" size="sm" onClick={onDuplicate}>
            <Copy className="h-3.5 w-3.5" aria-hidden="true" />
            {t('duplicate')}
          </Button>
        ) : null}
        {canWrite && !role.isSystem ? (
          <Button variant="ghost" size="sm" onClick={onDelete}>
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            {tCommon('delete')}
          </Button>
        ) : null}
      </footer>
    </li>
  );
}

function Metric({
  label,
  value,
  tone = 'neutral',
  hint,
  icon: Icon,
}: {
  label: string;
  value: number | string;
  tone?: 'neutral' | 'warning';
  hint?: string;
  icon?: typeof Users2;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="flex items-center gap-1 text-[11px] uppercase tracking-wide text-ink-tertiary">
        {Icon ? <Icon className="h-3 w-3" aria-hidden="true" /> : null}
        {label}
      </dt>
      <dd
        className={cn(
          'text-sm font-semibold',
          tone === 'warning' ? 'text-status-warning' : 'text-ink-primary',
        )}
        title={hint}
      >
        {value}
      </dd>
    </div>
  );
}

function AdvancedLink({
  href,
  label,
  hint,
  icon: Icon,
}: {
  href: string;
  label: string;
  hint?: string;
  icon: typeof Table;
}): JSX.Element {
  return (
    <li>
      <Link
        href={href}
        className="flex items-center gap-3 rounded-lg border border-surface-border bg-surface-card p-3 transition-colors hover:border-brand-200 hover:bg-brand-50"
      >
        <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-brand-50 text-brand-700">
          <Icon className="h-4 w-4" aria-hidden="true" />
        </span>
        <div className="flex min-w-0 flex-col">
          <span className="text-sm font-medium text-ink-primary">{label}</span>
          {hint ? <span className="truncate text-[11px] text-ink-tertiary">{hint}</span> : null}
        </div>
        <ArrowRight className="ms-auto h-4 w-4 text-ink-tertiary" aria-hidden="true" />
      </Link>
    </li>
  );
}
