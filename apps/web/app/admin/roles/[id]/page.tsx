'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Eye,
  History,
  Layers,
  Lock,
  Save,
  ShieldCheck,
  Table as TableIcon,
  Users2,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import { useToast } from '@/components/ui/toast';
import { DependencyWarningsPanel } from '@/components/admin/roles/dependency-warnings-panel';
import { ReviewChangesModal } from '@/components/admin/roles/review-changes-modal';
import { RoleHistoryTab } from '@/components/admin/roles/role-history-tab';
import { RolePreviewTab } from '@/components/admin/roles/role-preview-tab';
import { TypedConfirmationModal } from '@/components/admin/roles/typed-confirmation-modal';
import { ApiError, rolesApi } from '@/lib/api';
import type {
  CapabilityCatalogueEntry,
  FieldCatalogueEntry,
  RoleChangePreviewResult,
  RoleDependencyAnalysis,
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

/**
 * Sprint 7 — Hybrid editor tab framework. The legacy tabs map 1:1 to
 * the new ones (info → overview, capabilities → moduleAccess,
 * scopes → scope, fields → fieldAccess, history → audit,
 * preview → riskPreview) plus two new tabs:
 *   • members — users assigned to this role (real fetch from
 *     usersApi.list({ roleId })).
 *   • advanced — power-user surfaces: permission matrix link, raw
 *     capability list, audit deep-link. The existing CapabilitiesTab
 *     stays under Module Access; Advanced is the optional drill-down,
 *     not the primary editing surface.
 */
type TabKey =
  | 'overview'
  | 'moduleAccess'
  | 'fieldAccess'
  | 'scope'
  | 'members'
  | 'riskPreview'
  | 'audit'
  | 'advanced';

const TAB_ICONS: Record<TabKey, typeof ShieldCheck> = {
  overview: Eye,
  moduleAccess: Layers,
  fieldAccess: ShieldCheck,
  scope: TableIcon,
  members: Users2,
  riskPreview: AlertTriangle,
  audit: History,
  advanced: TableIcon,
};

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
  const [activeTab, setActiveTab] = useState<TabKey>('overview');

  // Sprint 7 — the Overview hub deep-links to #members; honour the
  // hash on first load so the navigation feels continuous.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const hash = window.location.hash.replace('#', '');
    if (hash === 'members') setActiveTab('members');
    else if (hash === 'advanced') setActiveTab('advanced');
    else if (hash === 'audit' || hash === 'history') setActiveTab('audit');
    else if (hash === 'risk' || hash === 'preview') setActiveTab('riskPreview');
    else if (hash === 'fields' || hash === 'fieldAccess') setActiveTab('fieldAccess');
    else if (hash === 'capabilities' || hash === 'moduleAccess') setActiveTab('moduleAccess');
    else if (hash === 'scope' || hash === 'scopes') setActiveTab('scope');
  }, []);

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
            'overview',
            'moduleAccess',
            'fieldAccess',
            'scope',
            'members',
            ...(canPreview ? (['riskPreview'] as const) : []),
            'audit',
            'advanced',
          ] as const
        ).map((key) => {
          const Icon = TAB_ICONS[key];
          return (
            <button
              key={key}
              type="button"
              role="tab"
              onClick={() => setActiveTab(key)}
              aria-selected={activeTab === key}
              className={cn(
                'inline-flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-medium transition-colors',
                activeTab === key
                  ? 'border-brand-600 text-brand-700'
                  : 'border-transparent text-ink-secondary hover:text-ink-primary',
              )}
            >
              <Icon className="h-3.5 w-3.5" aria-hidden="true" />
              {t(`tabs.${key}` as 'tabs.overview')}
            </button>
          );
        })}
      </nav>

      {activeTab === 'overview' ? (
        <OverviewTab
          role={role}
          capabilities={capabilities}
          fieldCatalogue={fieldCatalogue}
          editable={editable}
          onSaved={reload}
          toast={toast}
        />
      ) : null}
      {activeTab === 'moduleAccess' ? (
        <CapabilitiesTab
          role={role}
          capabilities={capabilities}
          editable={editable}
          onSaved={reload}
          toast={toast}
        />
      ) : null}
      {activeTab === 'fieldAccess' ? (
        <FieldPermissionsTab
          role={role}
          fieldCatalogue={fieldCatalogue}
          editable={editable}
          onSaved={reload}
          toast={toast}
        />
      ) : null}
      {activeTab === 'scope' ? (
        <ScopesTab role={role} editable={editable} onSaved={reload} toast={toast} />
      ) : null}
      {activeTab === 'members' ? <MembersTabPlaceholder /> : null}
      {activeTab === 'riskPreview' && canPreview ? <RolePreviewTab roleId={role.id} /> : null}
      {activeTab === 'audit' ? (
        <RoleHistoryTab roleId={role.id} roleIsSystem={role.isSystem} onReverted={reload} />
      ) : null}
      {activeTab === 'advanced' ? <AdvancedTabPlaceholder roleId={role.id} /> : null}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Sprint 7.B — Overview tab: at-a-glance summary + Basic info form.
// ────────────────────────────────────────────────────────────────────

interface OverviewTabProps extends TabProps {
  capabilities: CapabilityCatalogueEntry[];
  fieldCatalogue: FieldCatalogueEntry[];
}

function OverviewTab({
  role,
  capabilities,
  fieldCatalogue,
  editable,
  onSaved,
  toast,
}: OverviewTabProps): JSX.Element {
  const tHybrid = useTranslations('admin.roles.editorHybrid');

  // Real, derived metrics — no fabrication.
  const moduleFamilies = useMemo(() => {
    const set = new Set<string>();
    for (const cap of role.capabilities) {
      const prefix = cap.split('.')[0] ?? 'misc';
      set.add(prefix);
    }
    return set.size;
  }, [role.capabilities]);

  const customFieldRows = role.fieldPermissions.length;
  const explicitScopeCount = role.scopes.length;
  const capabilityCoverage =
    capabilities.length > 0
      ? Math.round((role.capabilities.length / capabilities.length) * 100)
      : null;

  // Inline warnings. These are derived from the role payload only —
  // the authoritative risk warnings live in Risk & Preview (powered
  // by `rolesApi.preview`). We surface a subset here so the operator
  // sees the headline issues before navigating into the deeper tab.
  const warnings: Array<{ key: string; tone: 'warning' | 'breach' }> = [];
  if (role.scopes.length === 0) warnings.push({ key: 'noScope', tone: 'warning' });
  if (role.capabilities.length >= 40) warnings.push({ key: 'manyCaps', tone: 'breach' });
  if (role.level >= 80) warnings.push({ key: 'highLevel', tone: 'breach' });
  if (
    fieldCatalogue.some(
      (f) =>
        f.sensitive &&
        role.fieldPermissions.find((p) => p.resource === f.resource && p.field === f.field)
          ?.canRead,
    )
  ) {
    warnings.push({ key: 'sensitiveField', tone: 'warning' });
  }

  return (
    <div className="flex flex-col gap-4">
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryTile
          label={tHybrid('summary.members')}
          value="—"
          hint={tHybrid('summary.membersHint')}
        />
        <SummaryTile
          label={tHybrid('summary.scopes')}
          value={explicitScopeCount}
          hint={tHybrid('summary.scopesHint')}
        />
        <SummaryTile
          label={tHybrid('summary.modules')}
          value={moduleFamilies}
          hint={tHybrid('summary.modulesHint')}
        />
        <SummaryTile
          label={tHybrid('summary.capabilities')}
          value={
            capabilityCoverage === null
              ? `${role.capabilities.length}`
              : `${role.capabilities.length} · ${capabilityCoverage}%`
          }
          hint={tHybrid('summary.capabilitiesHint')}
        />
        <SummaryTile
          label={tHybrid('summary.level')}
          value={role.level}
          hint={tHybrid('summary.levelHint')}
        />
        <SummaryTile
          label={tHybrid('summary.fieldRules')}
          value={customFieldRows}
          hint={tHybrid('summary.fieldRulesHint')}
        />
        <SummaryTile
          label={tHybrid('summary.type')}
          value={role.isSystem ? tHybrid('summary.system') : tHybrid('summary.custom')}
          hint={role.isSystem ? tHybrid('summary.systemHint') : tHybrid('summary.customHint')}
        />
        <SummaryTile
          label={tHybrid('summary.lastUpdated')}
          value="—"
          hint={tHybrid('summary.lastUpdatedGap')}
        />
      </section>

      {warnings.length > 0 ? (
        <Notice tone={warnings.some((w) => w.tone === 'breach') ? 'error' : 'info'}>
          <p className="text-sm font-medium">{tHybrid('warnings.title')}</p>
          <ul className="mt-2 flex flex-col gap-1 text-xs">
            {warnings.map((w) => (
              <li key={w.key} className="flex items-center gap-2">
                <AlertTriangle
                  className={cn(
                    'h-3.5 w-3.5',
                    w.tone === 'breach' ? 'text-status-breach' : 'text-status-warning',
                  )}
                  aria-hidden="true"
                />
                <span className="text-ink-primary">
                  {tHybrid(`warnings.${w.key}` as 'warnings.noScope')}
                </span>
              </li>
            ))}
          </ul>
        </Notice>
      ) : null}

      <BasicInfoTab role={role} editable={editable} onSaved={onSaved} toast={toast} />

      <section className="rounded-lg border border-surface-border bg-surface-card p-4 text-xs shadow-card">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-tertiary">
          {tHybrid('quickLinks.title')}
        </h3>
        <p className="mt-1 text-[11px] text-ink-secondary">{tHybrid('quickLinks.body')}</p>
      </section>

      {/* Stable anchors so /admin/roles/:id#members deep-links work
          without having to scroll-jump in the Overview body. */}
      <span id="members" aria-hidden="true" />
      <span id="audit" aria-hidden="true" />
      <span id="advanced" aria-hidden="true" />
    </div>
  );
}

function SummaryTile({
  label,
  value,
  hint,
}: {
  label: string;
  value: number | string;
  hint?: string;
}): JSX.Element {
  return (
    <div
      className="flex flex-col gap-1 rounded-lg border border-surface-border bg-surface-card p-3 shadow-card"
      title={hint}
    >
      <span className="text-[11px] uppercase tracking-wide text-ink-tertiary">{label}</span>
      <span className="text-lg font-semibold text-ink-primary">{value}</span>
      {hint ? <span className="text-[11px] leading-snug text-ink-tertiary">{hint}</span> : null}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Sprint 7.B — Members tab (placeholder until Sprint 7.E wires it).
// ────────────────────────────────────────────────────────────────────

function MembersTabPlaceholder(): JSX.Element {
  const tHybrid = useTranslations('admin.roles.editorHybrid');
  return (
    <Notice tone="info">
      <p className="text-sm font-medium">{tHybrid('members.placeholderTitle')}</p>
      <p className="mt-1 text-xs text-ink-secondary">{tHybrid('members.placeholderBody')}</p>
    </Notice>
  );
}

// ────────────────────────────────────────────────────────────────────
// Sprint 7.B — Advanced tab (container; Sprint 7.F fills it in).
// ────────────────────────────────────────────────────────────────────

function AdvancedTabPlaceholder({ roleId }: { roleId: string }): JSX.Element {
  const tHybrid = useTranslations('admin.roles.editorHybrid');
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-surface-border bg-surface-card p-5 shadow-card">
      <header>
        <h3 className="text-sm font-semibold text-ink-primary">{tHybrid('advanced.title')}</h3>
        <p className="mt-1 text-xs text-ink-secondary">{tHybrid('advanced.body')}</p>
      </header>
      <ul className="grid gap-2 sm:grid-cols-2">
        <AdvancedRow
          href="/admin/roles?view=matrix"
          label={tHybrid('advanced.matrix')}
          hint={tHybrid('advanced.matrixHint')}
        />
        <AdvancedRow
          href={`/admin/audit?entity=Role&entityId=${roleId}`}
          label={tHybrid('advanced.changeHistory')}
          hint={tHybrid('advanced.changeHistoryHint')}
        />
      </ul>
      <p className="text-[11px] text-ink-tertiary">{tHybrid('advanced.followUp')}</p>
    </section>
  );
}

function AdvancedRow({
  href,
  label,
  hint,
}: {
  href: string;
  label: string;
  hint: string;
}): JSX.Element {
  return (
    <li>
      <Link
        href={href}
        className="flex items-center gap-3 rounded-lg border border-surface-border bg-surface p-3 transition-colors hover:border-brand-200 hover:bg-brand-50"
      >
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm font-medium text-ink-primary">{label}</span>
          <span className="truncate text-[11px] text-ink-tertiary">{hint}</span>
        </div>
        <ArrowRight className="h-4 w-4 text-ink-tertiary" aria-hidden="true" />
      </Link>
    </li>
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

  // Phase D5 — D5.14: dependency analysis state. The panel is
  // re-fetched on every selection change (debounced) so the
  // operator sees inline hints + grouped warnings as they toggle
  // capability checkboxes. Save consults
  // `analysis.requiresTypedConfirmation` to decide whether to
  // open the typed-confirmation modal.
  const [analysis, setAnalysis] = useState<RoleDependencyAnalysis | null>(null);
  const [confirmModalOpen, setConfirmModalOpen] = useState<boolean>(false);

  // Phase D5 — D5.15-A: change-set preview state. The "Review
  // changes" modal is opened on Save click — it shows the
  // structural diff (granted / revoked caps + field perms +
  // scope changes) plus the dependency warnings. The standalone
  // typed-confirmation modal stays as a fallback for when the
  // server rejects a save with `role.dependency.confirmation_required`
  // (defensive — the review modal already gates critical changes
  // inline).
  const [reviewPreview, setReviewPreview] = useState<RoleChangePreviewResult | null>(null);
  const [reviewModalOpen, setReviewModalOpen] = useState<boolean>(false);
  const [reviewLoading, setReviewLoading] = useState<boolean>(false);

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

  function toggleModule(modCaps: readonly CapabilityCatalogueEntry[], on: boolean): void {
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

  // D5.14 — debounced dependency-check refresh. The endpoint is
  // read-only so the cost is small and the UX gain (inline hints
  // as you toggle) is large. On role/system roles the analysis
  // surfaces the system_immutable warning automatically.
  useEffect(() => {
    if (role.isSystem) {
      setAnalysis(null);
      return;
    }
    const timer = setTimeout(() => {
      const sorted = Array.from(selected).sort();
      rolesApi
        .dependencyCheck(role.id, sorted)
        .then((res) => setAnalysis(res))
        .catch(() => {
          // Best-effort. The save flow re-runs the analysis on
          // the server side regardless; a transient client
          // failure here doesn't compromise the gate.
          setAnalysis(null);
        });
    }, 250);
    return () => clearTimeout(timer);
  }, [role.id, role.isSystem, selected]);

  async function persist(confirmation?: string): Promise<void> {
    setSubmitting(true);
    setError(null);
    try {
      await rolesApi.update(role.id, {
        capabilities: Array.from(selected).sort(),
        ...(confirmation !== undefined && { confirmation }),
      });
      toast({ tone: 'success', title: t('savedToast') });
      setConfirmModalOpen(false);
      await onSaved();
    } catch (err) {
      // D5.14 — the typed-confirmation gate returns this error
      // code when a critical change is attempted without the
      // phrase. Open the modal so the operator can confirm.
      if (err instanceof ApiError && err.code === 'role.dependency.confirmation_required') {
        const raw = err.raw as { analysis?: RoleDependencyAnalysis } | undefined;
        if (raw?.analysis) setAnalysis(raw.analysis);
        setConfirmModalOpen(true);
        setError(null);
      } else {
        setError(err instanceof ApiError ? err.message : String(err));
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function onSubmit(): Promise<void> {
    // D5.15-A — Save no longer writes directly. We first ask the
    // server for the structural diff + risk flags + dependency
    // warnings, then open the "Review changes" modal. The modal
    // is the chokepoint — its Confirm button calls `persist()`.
    if (role.isSystem) return; // editable already gates this; defensive
    setReviewLoading(true);
    try {
      const proposed = Array.from(selected).sort();
      const preview = await rolesApi.changePreview(role.id, { capabilities: proposed });
      setReviewPreview(preview);
      // Sync the live dependency panel so closing the modal
      // leaves the inline hints accurate (the preview embeds
      // the same warnings).
      setAnalysis({
        warnings: preview.warnings,
        severityCounts: preview.severityCounts,
        requiresTypedConfirmation: preview.requiresTypedConfirmation,
        typedConfirmationPhrase: preview.typedConfirmationPhrase,
      });
      setReviewModalOpen(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setReviewLoading(false);
    }
  }

  async function onReviewConfirm(typedPhrase: string | null): Promise<void> {
    setReviewModalOpen(false);
    await persist(typedPhrase ?? undefined);
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-surface-border bg-surface-card p-5 shadow-card">
      {error ? <Notice tone="error">{error}</Notice> : null}
      <p className="text-sm text-ink-secondary">{t('capabilitiesIntro')}</p>
      <ul className="flex flex-col gap-2">
        {grouped.map(([moduleKey, modCaps]) => (
          <ModuleAccessCard
            key={moduleKey}
            moduleKey={moduleKey}
            modCaps={modCaps}
            selected={selected}
            editable={editable}
            submitting={submitting}
            onToggle={toggle}
            onToggleModule={toggleModule}
          />
        ))}
      </ul>
      <DependencyWarningsPanel analysis={analysis} />
      {editable ? (
        <div className="flex items-center justify-end">
          <Button
            onClick={() => void onSubmit()}
            loading={submitting || reviewLoading}
            data-testid="role-capabilities-save"
          >
            <Save className="h-4 w-4" aria-hidden="true" />
            {tCommon('save')}
          </Button>
        </div>
      ) : null}
      {/* D5.15-A — Review changes modal is the primary save path. */}
      <ReviewChangesModal
        open={reviewModalOpen}
        preview={reviewPreview}
        capabilityCatalogue={capabilities}
        loading={submitting}
        onCancel={() => setReviewModalOpen(false)}
        onConfirm={(phrase) => void onReviewConfirm(phrase)}
      />
      {/* D5.14 — typed-confirmation fallback. The review modal
          already handles typed confirmation inline; this stays
          as the recovery path when the server rejects a save
          with `role.dependency.confirmation_required` (e.g.
          racing tenant change). */}
      <TypedConfirmationModal
        open={confirmModalOpen}
        analysis={analysis}
        loading={submitting}
        onCancel={() => setConfirmModalOpen(false)}
        onConfirm={(phrase) => void persist(phrase)}
      />
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
  const tFieldHybrid = useTranslations('admin.roles.fieldHybrid');

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

  // Sprint 7.D — filters live alongside the existing table so an
  // operator can narrow to the rows they care about. They are pure
  // UI state — no impact on save behaviour or row inclusion.
  type FieldFilter = 'all' | 'sensitive' | 'hidden' | 'editable' | 'overrides';
  const [filter, setFilter] = useState<FieldFilter>('all');
  const [query, setQuery] = useState<string>('');

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

  // Sprint 7.D — search + filter applied to the catalogue. The
  // working map keeps every row so a hidden filter doesn't lose
  // unsaved toggles; we just hide the matching tr.
  const matches = useCallback(
    (entry: FieldCatalogueEntry): boolean => {
      const q = query.trim().toLowerCase();
      if (q) {
        const hay =
          `${entry.field} ${entry.labelEn} ${entry.labelAr ?? ''} ${entry.resource}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      const cur = working.get(`${entry.resource}::${entry.field}`) ?? {
        canRead: entry.defaultRead,
        canWrite: entry.defaultWrite,
      };
      switch (filter) {
        case 'all':
          return true;
        case 'sensitive':
          return entry.sensitive;
        case 'hidden':
          return !cur.canRead;
        case 'editable':
          return cur.canWrite;
        case 'overrides':
          return cur.canRead !== entry.defaultRead || cur.canWrite !== entry.defaultWrite;
        default:
          return true;
      }
    },
    [query, filter, working],
  );

  // Counts shown on the filter chips (computed against the full
  // catalogue, not the search query, so the chip totals stay stable
  // as the operator types).
  const counts = useMemo(() => {
    let sensitive = 0;
    let hidden = 0;
    let editable = 0;
    let overrides = 0;
    for (const e of fieldCatalogue) {
      const cur = working.get(`${e.resource}::${e.field}`) ?? {
        canRead: e.defaultRead,
        canWrite: e.defaultWrite,
      };
      if (e.sensitive) sensitive += 1;
      if (!cur.canRead) hidden += 1;
      if (cur.canWrite) editable += 1;
      if (cur.canRead !== e.defaultRead || cur.canWrite !== e.defaultWrite) overrides += 1;
    }
    return { all: fieldCatalogue.length, sensitive, hidden, editable, overrides };
  }, [fieldCatalogue, working]);

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-surface-border bg-surface-card p-5 shadow-card">
      {error ? <Notice tone="error">{error}</Notice> : null}
      <p className="text-sm text-ink-secondary">{t('fieldsIntro')}</p>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={tFieldHybrid('searchPlaceholder')}
          aria-label={tFieldHybrid('searchPlaceholder')}
          className="max-w-sm"
        />
        <div
          role="tablist"
          aria-label={tFieldHybrid('filterLabel')}
          className="flex flex-wrap gap-1"
        >
          {(
            [
              ['all', counts.all],
              ['sensitive', counts.sensitive],
              ['hidden', counts.hidden],
              ['editable', counts.editable],
              ['overrides', counts.overrides],
            ] as ReadonlyArray<[FieldFilter, number]>
          ).map(([key, n]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={filter === key}
              onClick={() => setFilter(key)}
              className={cn(
                'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                filter === key
                  ? 'border-brand-200 bg-brand-50 text-brand-700'
                  : 'border-surface-border bg-surface-card text-ink-secondary hover:border-brand-200 hover:bg-brand-50/40',
              )}
            >
              {tFieldHybrid(`filters.${key}` as 'filters.all', { n })}
            </button>
          ))}
        </div>
      </div>
      {byResource.map(([resource, entries]) => {
        const visible = entries.filter(matches);
        if (visible.length === 0) return null;
        return (
          <section
            key={resource}
            className="overflow-hidden rounded-md border border-surface-border"
          >
            <header className="flex items-center justify-between border-b border-surface-border bg-surface px-3 py-2 text-xs">
              <span className="font-semibold uppercase tracking-wide text-ink-tertiary">
                {resource}
              </span>
              <span className="text-[11px] text-ink-tertiary">
                {tFieldHybrid('resourceCount', { n: visible.length, total: entries.length })}
              </span>
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
                {visible.map((entry) => {
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
        );
      })}
      {byResource.every(([, entries]) => entries.filter(matches).length === 0) ? (
        <Notice tone="info">
          <p className="text-sm font-medium">{tFieldHybrid('emptyFiltered.title')}</p>
          <p className="mt-1 text-xs text-ink-secondary">{tFieldHybrid('emptyFiltered.body')}</p>
        </Notice>
      ) : null}
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
// Sprint 7.C — Module Access card. Wraps the existing capability
// list with an access-level chip + risk flag + collapsible details.
// The inner checkbox toggle logic is unchanged: every change still
// re-runs the D5.14 dependency check via the parent's debounced
// effect. The card is a visual reorganisation, not a behavioural one.
// ────────────────────────────────────────────────────────────────────

const RISK_KEYWORDS: readonly string[] = [
  'export',
  'delete',
  'merge',
  'reset',
  'disable',
  'override',
  'audit',
];

function isRiskyCap(code: string): boolean {
  const lower = code.toLowerCase();
  return RISK_KEYWORDS.some((k) => lower.includes(k));
}

function isReadCap(code: string): boolean {
  return code.toLowerCase().endsWith('.read');
}

type AccessLevel = 'none' | 'readOnly' | 'limited' | 'full';

function accessLevelOf(
  modCaps: readonly CapabilityCatalogueEntry[],
  selected: ReadonlySet<string>,
): AccessLevel {
  const on = modCaps.filter((c) => selected.has(c.code));
  if (on.length === 0) return 'none';
  if (on.length === modCaps.length) return 'full';
  if (on.every((c) => isReadCap(c.code))) return 'readOnly';
  return 'limited';
}

function ModuleAccessCard({
  moduleKey,
  modCaps,
  selected,
  editable,
  submitting,
  onToggle,
  onToggleModule,
}: {
  moduleKey: string;
  modCaps: readonly CapabilityCatalogueEntry[];
  selected: ReadonlySet<string>;
  editable: boolean;
  submitting: boolean;
  onToggle: (code: string) => void;
  onToggleModule: (modCaps: readonly CapabilityCatalogueEntry[], on: boolean) => void;
}): JSX.Element {
  const t = useTranslations('admin.roles');
  const tHybrid = useTranslations('admin.roles.editorHybrid');

  const initiallyExpanded = useMemo(
    () => modCaps.some((c) => selected.has(c.code)),
    [modCaps, selected],
  );
  const [expanded, setExpanded] = useState<boolean>(initiallyExpanded);

  const level = accessLevelOf(modCaps, selected);
  const hasRiskyCap = modCaps.some((c) => isRiskyCap(c.code));
  const hasActiveRisky = modCaps.some((c) => isRiskyCap(c.code) && selected.has(c.code));
  const onCount = modCaps.filter((c) => selected.has(c.code)).length;

  const levelTone: Record<AccessLevel, 'inactive' | 'info' | 'warning' | 'healthy'> = {
    none: 'inactive',
    readOnly: 'info',
    limited: 'warning',
    full: 'healthy',
  };

  return (
    <li className="overflow-hidden rounded-md border border-surface-border bg-surface">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full flex-wrap items-center gap-3 px-3 py-2 text-start transition-colors hover:bg-brand-50/40"
      >
        <Layers className="h-4 w-4 text-ink-tertiary" aria-hidden="true" />
        <h3 className="text-sm font-semibold text-ink-primary">{moduleKey}</h3>
        <Badge tone={levelTone[level]}>
          {tHybrid(`accessLevel.${level}` as 'accessLevel.none')}
        </Badge>
        {hasActiveRisky ? (
          <Badge tone="breach">{tHybrid('moduleRisk.activeSensitive')}</Badge>
        ) : hasRiskyCap ? (
          <Badge tone="warning">{tHybrid('moduleRisk.hasSensitive')}</Badge>
        ) : null}
        <span className="ms-auto text-xs text-ink-tertiary">
          {tHybrid('moduleCounts.summary', { on: onCount, total: modCaps.length })}
        </span>
        <ArrowRight
          className={cn(
            'h-3.5 w-3.5 text-ink-tertiary transition-transform',
            expanded ? 'rotate-90' : '',
          )}
          aria-hidden="true"
        />
      </button>
      {expanded ? (
        <div className="border-t border-surface-border bg-surface-card px-3 py-2">
          {editable ? (
            <div className="mb-2 flex justify-end">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onToggleModule(modCaps, level !== 'full')}
                disabled={submitting}
              >
                {level === 'full' ? t('deselectAll') : t('selectAll')}
              </Button>
            </div>
          ) : null}
          <ul className="grid grid-cols-1 gap-1 sm:grid-cols-2">
            {modCaps.map((c) => {
              const checked = selected.has(c.code);
              const risky = isRiskyCap(c.code);
              return (
                <li key={c.code}>
                  <label
                    className={cn(
                      'flex cursor-pointer items-start gap-2 rounded-md px-2 py-1 text-sm hover:bg-brand-50/40',
                      editable ? '' : 'cursor-not-allowed opacity-80',
                      risky && checked
                        ? 'border border-status-breach/20 bg-status-breach/5'
                        : risky
                          ? 'border border-status-warning/20'
                          : '',
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => onToggle(c.code)}
                      disabled={!editable || submitting}
                      className="mt-0.5"
                    />
                    <span className="flex min-w-0 flex-col leading-tight">
                      <span className="flex items-center gap-1">
                        <code className="font-mono text-xs text-ink-primary">{c.code}</code>
                        {risky ? (
                          <span className="inline-flex items-center gap-0.5 rounded bg-status-warning/10 px-1 text-[10px] uppercase text-status-warning">
                            {tHybrid('moduleRisk.sensitiveTag')}
                          </span>
                        ) : null}
                      </span>
                      <span className="text-xs text-ink-tertiary">{c.description}</span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </li>
  );
}
