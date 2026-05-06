'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { AlertTriangle, Clock, Download, EyeOff, History, Lock, ShieldCheck } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Notice } from '@/components/ui/notice';
import { ApiError, auditApi, rolesApi, usersApi, type AuditRow } from '@/lib/api';
import type { AdminUser, RolePreviewResult, RolePreviewWarningCode } from '@/lib/api-types';
import { hasCapability } from '@/lib/auth';
import { getCatalogueLabel } from '@/lib/field-catalogue-mirror';
import { cn } from '@/lib/utils';

/**
 * Phase D5 — D5.10: role permission preview panel.
 *
 * Read-only debugger embedded in the role editor as a fifth tab.
 * Shows the structural projection produced by
 * `RolePreviewService.previewRole`:
 *
 *   • Quick answers — six yes/no questions about the role.
 *   • Role summary — id, code, level, system flag.
 *   • Export capabilities — *.export caps highlighted.
 *   • Data scope by resource.
 *   • Hidden read fields by resource (catalogue labels).
 *   • Read-only write fields by resource.
 *   • Warnings — translated from stable codes.
 *
 * No impersonation. No iframe. No localStorage spoofing. The
 * server is the source of truth — this panel is a read-only
 * audit view of role metadata.
 */
export function RolePreviewTab({ roleId }: { roleId: string }): JSX.Element {
  const t = useTranslations('admin.roles.preview');
  const tScopes = useTranslations('admin.roles.scopes');
  const locale = useLocale();
  const [data, setData] = useState<RolePreviewResult | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    rolesApi
      .preview(roleId)
      .then((row) => {
        if (cancelled) return;
        setData(row);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : t('loadFailed'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [roleId, t]);

  if (loading) {
    return (
      <p className="rounded-lg border border-surface-border bg-surface-card px-4 py-8 text-center text-sm text-ink-secondary shadow-card">
        {t('loading')}
      </p>
    );
  }
  if (error || !data) {
    return <Notice tone="error">{error ?? t('loadFailed')}</Notice>;
  }

  const yes = t('answers.yes');
  const no = t('answers.no');
  const caps = new Set(data.permissions.capabilities);

  return (
    <section className="flex flex-col gap-4">
      <header className="flex flex-col gap-1 rounded-lg border border-surface-border bg-surface-card p-4 shadow-card">
        <h2 className="inline-flex items-center gap-2 text-lg font-semibold text-ink-primary">
          <ShieldCheck className="h-4 w-4 text-brand-700" aria-hidden="true" />
          {t('title')}
        </h2>
        <p className="text-sm text-ink-secondary">{t('subtitle')}</p>
      </header>

      {/* Quick answers — six yes/no questions */}
      <section
        className="rounded-lg border border-surface-border bg-surface-card p-4 shadow-card"
        data-testid="role-preview-answers"
      >
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-tertiary">
          {t('answers.header')}
        </h3>
        <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Answer label={t('answers.leadRead')} value={data.uiHints.hasLeadRead ? yes : no} />
          <Answer
            label={t('answers.leadExport')}
            value={data.uiHints.exportCapabilities.length > 0 ? yes : no}
          />
          <Answer
            label={t('answers.previousOwner')}
            value={
              !(data.permissions.deniedReadFieldsByResource['lead'] ?? []).includes('previousOwner')
                ? yes
                : no
            }
          />
          <Answer
            label={t('answers.partnerData')}
            value={
              caps.has('partner.source.read') ||
              caps.has('partner.verification.read') ||
              caps.has('partner.reconciliation.read')
                ? yes
                : no
            }
          />
          <Answer
            label={t('answers.partnerMerge')}
            value={caps.has('partner.merge.write') ? yes : no}
          />
          <Answer
            label={t('answers.auditPayload')}
            value={
              caps.has('audit.read') &&
              !(data.permissions.deniedReadFieldsByResource['audit'] ?? []).includes('payload')
                ? yes
                : no
            }
          />
        </dl>
      </section>

      {/* Role summary */}
      <section className="rounded-lg border border-surface-border bg-surface-card p-4 shadow-card">
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-tertiary">
          {t('summaryHeader')}
        </h3>
        <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
          <SummaryRow
            label="Code"
            value={<code className="font-mono text-xs">{data.role.code}</code>}
          />
          <SummaryRow
            label={locale.startsWith('ar') ? data.role.nameAr : data.role.nameEn}
            value={
              <span className="inline-flex items-center gap-2">
                <Badge tone="healthy">level {data.role.level}</Badge>
                {data.role.isSystem ? (
                  <Badge tone="inactive">
                    <Lock className="me-1 inline h-3 w-3" aria-hidden="true" />
                    system
                  </Badge>
                ) : null}
              </span>
            }
          />
        </dl>
      </section>

      {/* Export capabilities */}
      <section className="rounded-lg border border-surface-border bg-surface-card p-4 shadow-card">
        <h3 className="mb-3 inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-tertiary">
          <Download className="h-3.5 w-3.5" aria-hidden="true" />
          {t('exportsHeader')}
        </h3>
        {data.uiHints.exportCapabilities.length === 0 ? (
          <p className="text-sm italic text-ink-tertiary">{t('exportsEmpty')}</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {data.uiHints.exportCapabilities.map((c) => (
              <Badge key={c} tone="warning">
                <code className="font-mono text-[11px]">{c}</code>
              </Badge>
            ))}
          </div>
        )}
      </section>

      {/* Scopes by resource */}
      <section className="rounded-lg border border-surface-border bg-surface-card p-4 shadow-card">
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-tertiary">
          {t('scopesHeader')}
        </h3>
        {Object.keys(data.permissions.scopesByResource).length === 0 ? (
          <p className="text-sm italic text-ink-tertiary">{t('scopesEmpty')}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {Object.entries(data.permissions.scopesByResource).map(([resource, scope]) => {
              const label = scopeResourceLabel(tScopes, resource);
              const value = scopeValueLabel(tScopes, scope);
              return (
                <li key={resource} className="flex items-center justify-between text-sm">
                  <span className="text-ink-secondary">{label}</span>
                  <Badge tone="neutral">{value}</Badge>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Hidden read fields */}
      <section className="rounded-lg border border-surface-border bg-surface-card p-4 shadow-card">
        <h3 className="mb-3 inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-tertiary">
          <EyeOff className="h-3.5 w-3.5" aria-hidden="true" />
          {t('deniedReadHeader')}
        </h3>
        <FieldsByResourceList
          map={data.permissions.deniedReadFieldsByResource}
          locale={locale}
          emptyText={t('deniedReadEmpty')}
        />
      </section>

      {/* Read-only write fields */}
      <section className="rounded-lg border border-surface-border bg-surface-card p-4 shadow-card">
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-tertiary">
          {t('deniedWriteHeader')}
        </h3>
        <FieldsByResourceList
          map={data.permissions.deniedWriteFieldsByResource}
          locale={locale}
          emptyText={t('deniedWriteEmpty')}
        />
      </section>

      {/* Warnings */}
      <section className="rounded-lg border border-surface-border bg-surface-card p-4 shadow-card">
        <h3 className="mb-3 inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-tertiary">
          <AlertTriangle className="h-3.5 w-3.5 text-status-warning" aria-hidden="true" />
          {t('warningsHeader')}
        </h3>
        {data.warnings.length === 0 ? (
          <p className="text-sm italic text-ink-tertiary">{t('warningsEmpty')}</p>
        ) : (
          <ul className="flex flex-col gap-2" data-testid="role-preview-warnings">
            {data.warnings.map((w) => (
              <li
                key={w}
                className={cn(
                  'flex items-start gap-2 rounded-md border px-3 py-2 text-sm',
                  warningTone(w),
                )}
                data-warning={w}
              >
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <span>{t(`warnings.${w}` as 'warnings.has_export_capabilities')}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* D5.11 — Recent role previews. Server-filtered audit feed
          for THIS role only (entityId + actionPrefix). Gated by
          audit.read; missing capability → panel hidden. */}
      <RecentRolePreviewsPanel roleId={data.role.id} />
    </section>
  );
}

/**
 * Phase D5 — D5.11: small audit panel showing recent role-preview
 * audit rows for the role currently being inspected. Gated by
 * `audit.read`; users without it never see the panel. Calls
 * `GET /audit?actionPrefix=rbac&entityId=<roleId>` so the server
 * does the heavy lifting + the audit field-redaction interceptor
 * applies as usual.
 */
function RecentRolePreviewsPanel({ roleId }: { roleId: string }): JSX.Element | null {
  const t = useTranslations('admin.audit.recentPreviews');
  const canReadAudit = hasCapability('audit.read');
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!canReadAudit) return undefined;
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      auditApi.list({ actionPrefix: 'rbac', entityId: roleId, limit: 25 }),
      usersApi
        .list({ limit: 200 })
        .catch(() => ({ items: [] as AdminUser[], total: 0, limit: 200, offset: 0 })),
    ])
      .then(([list, page]) => {
        if (cancelled) return;
        setRows(list);
        setUsers(page.items);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : t('loadFailed'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [roleId, canReadAudit, t]);

  if (!canReadAudit) return null;

  const userById = new Map(users.map((u) => [u.id, u]));

  return (
    <section
      className="rounded-lg border border-surface-border bg-surface-card p-4 shadow-card"
      data-testid="role-preview-recent-previews"
    >
      <h3 className="mb-1 inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-tertiary">
        <History className="h-3.5 w-3.5" aria-hidden="true" />
        {t('title')}
      </h3>
      <p className="mb-3 text-xs text-ink-tertiary">{t('subtitle')}</p>
      {loading ? (
        <p className="text-sm italic text-ink-tertiary">{t('loading')}</p>
      ) : error ? (
        <Notice tone="error">{error}</Notice>
      ) : rows.length === 0 ? (
        <p className="text-sm italic text-ink-tertiary">{t('empty')}</p>
      ) : (
        <ul className="divide-y divide-surface-border rounded-md border border-surface-border bg-surface">
          {rows.map((r) => {
            const u = r.actorUserId ? userById.get(r.actorUserId) : null;
            return (
              <li key={r.id} className="flex flex-col gap-0.5 px-3 py-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm text-ink-primary">
                    {u ? `${u.name}` : t('anonymousActor')}
                  </span>
                  <span className="inline-flex items-center gap-1 text-[11px] text-ink-tertiary">
                    <Clock className="h-3 w-3" aria-hidden="true" />
                    {new Date(r.createdAt).toLocaleString()}
                  </span>
                </div>
                {u ? <span className="text-[11px] text-ink-tertiary">{u.email}</span> : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ─── helpers ──────────────────────────────────────────────────────

function Answer({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex items-center justify-between rounded-md border border-surface-border bg-surface px-3 py-2">
      <dt className="text-sm text-ink-secondary">{label}</dt>
      <dd className="text-sm font-medium text-ink-primary">{value}</dd>
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: React.ReactNode }): JSX.Element {
  return (
    <div className="flex items-center justify-between rounded-md border border-surface-border bg-surface px-3 py-2">
      <dt className="text-sm text-ink-tertiary">{label}</dt>
      <dd className="text-sm text-ink-primary">{value}</dd>
    </div>
  );
}

function FieldsByResourceList({
  map,
  locale,
  emptyText,
}: {
  map: Readonly<Record<string, readonly string[]>>;
  locale: string;
  emptyText: string;
}): JSX.Element {
  const entries = Object.entries(map).filter(([, fields]) => fields.length > 0);
  if (entries.length === 0) {
    return <p className="text-sm italic text-ink-tertiary">{emptyText}</p>;
  }
  return (
    <ul className="flex flex-col gap-3">
      {entries.map(([resource, fields]) => (
        <li key={resource} className="flex flex-col gap-1.5">
          <code className="font-mono text-[11px] uppercase tracking-wide text-ink-tertiary">
            {resource}
          </code>
          <div className="flex flex-wrap gap-1.5">
            {fields.map((field) => {
              const label = getCatalogueLabel(resource, field, locale);
              return (
                <Badge key={field} tone="neutral">
                  {label ?? <code className="font-mono text-[11px]">{field}</code>}
                </Badge>
              );
            })}
          </div>
        </li>
      ))}
    </ul>
  );
}

function scopeResourceLabel(t: ReturnType<typeof useTranslations>, resource: string): string {
  switch (resource) {
    case 'lead':
    case 'captain':
    case 'followup':
    case 'whatsapp.conversation':
      return t(`resources.${resource}` as 'resources.lead');
    default:
      return resource;
  }
}

function scopeValueLabel(t: ReturnType<typeof useTranslations>, scope: string): string {
  switch (scope) {
    case 'own':
    case 'team':
    case 'company':
    case 'country':
    case 'global':
      return t(`values.${scope}` as 'values.own');
    default:
      return scope;
  }
}

function warningTone(code: RolePreviewWarningCode): string {
  switch (code) {
    case 'no_lead_read_capability':
    case 'has_super_admin_bypass':
      return 'border-status-breach/40 bg-status-breach/5 text-status-breach';
    case 'has_export_capabilities':
    case 'has_audit_payload_access':
    case 'has_partner_merge_capability':
      return 'border-status-warning/40 bg-status-warning/5 text-ink-primary';
    default:
      return 'border-surface-border bg-surface text-ink-secondary';
  }
}
