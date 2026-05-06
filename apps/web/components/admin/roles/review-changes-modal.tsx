'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import {
  AlertOctagon,
  ArchiveRestore,
  Check,
  Database,
  Eye,
  FileDown,
  History,
  Minus,
  Plus,
  ShieldCheck,
  UserMinus,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Notice } from '@/components/ui/notice';
import { DependencyWarningsPanel } from './dependency-warnings-panel';
import { getCatalogueLabel } from '@/lib/field-catalogue-mirror';
import { cn } from '@/lib/utils';
import type {
  CapabilityCatalogueEntry,
  RoleChangePreviewFieldPair,
  RoleChangePreviewResult,
  RoleChangePreviewScopeChange,
  RoleScopeRow,
} from '@/lib/api-types';

/**
 * Phase D5 — D5.15-A: structural change-set preview modal.
 *
 * Opens BEFORE the save round-trip. Renders three layers:
 *
 *   1. A risk-flag strip — coloured chips that highlight whether
 *      the change touches export / owner-history / audit /
 *      backup / permission-admin / partner-merge surfaces.
 *
 *   2. The structural diff — granted / revoked capabilities,
 *      added / removed read- and write-deny field pairs, scope
 *      changes (added / removed / changed). Capability codes
 *      are paired with catalogue descriptions so the primary UX
 *      is the human label; the raw code sits as secondary text.
 *
 *   3. The reused D5.14 dependency-warnings panel + (when
 *      `requiresTypedConfirmation`) an inline typed-confirmation
 *      input. The save button stays disabled until the phrase
 *      matches verbatim.
 *
 * No-changes state: when `preview.hasChanges === false` the
 * modal renders a short "No changes to save" notice + a Close
 * button. The parent never calls the update endpoint in that
 * case.
 *
 * Accessibility / RTL: all icons carry `aria-hidden`; primary
 * sentences come from i18n with capability codes injected as
 * placeholders. The danger-toned save button surfaces
 * `aria-disabled` so screen readers don't treat it as a missing
 * element.
 */
export function ReviewChangesModal({
  open,
  preview,
  capabilityCatalogue,
  loading,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  preview: RoleChangePreviewResult | null;
  /** Catalogue used to resolve capability descriptions. Optional —
   *  the modal falls back to the raw code when the entry is missing. */
  capabilityCatalogue: ReadonlyArray<CapabilityCatalogueEntry>;
  loading: boolean;
  onCancel: () => void;
  /**
   * Called with the typed-confirmation phrase when the operator
   * confirms. The phrase is `null` when the change does not
   * require typed confirmation; the parent threads it (or its
   * absence) through the existing PATCH call.
   */
  onConfirm: (phrase: string | null) => void;
}): JSX.Element | null {
  const t = useTranslations('admin.roles.review');
  const [phrase, setPhrase] = useState<string>('');

  if (!open || !preview) return null;

  const required = preview.requiresTypedConfirmation ? preview.typedConfirmationPhrase : null;
  const matches = required === null ? true : phrase === required;
  const noChanges = !preview.hasChanges;

  const capByCode = new Map<string, CapabilityCatalogueEntry>();
  for (const entry of capabilityCatalogue) capByCode.set(entry.code, entry);

  return (
    <Modal
      open={open}
      title={t('title', { role: preview.role.nameEn })}
      onClose={onCancel}
      width="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={loading}>
            {noChanges ? t('actions.close') : t('actions.cancel')}
          </Button>
          {noChanges ? null : (
            <Button
              variant={preview.requiresTypedConfirmation ? 'danger' : 'primary'}
              onClick={() => onConfirm(required === null ? null : phrase)}
              loading={loading}
              disabled={!matches || loading}
              aria-disabled={!matches || loading}
              data-testid="role-review-confirm"
            >
              {t('actions.confirmAndSave')}
            </Button>
          )}
        </>
      }
    >
      {noChanges ? (
        <div className="flex flex-col gap-3" data-testid="role-review-no-changes">
          <Notice tone="info">
            <span>{t('noChanges')}</span>
          </Notice>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <RiskFlagsStrip riskSummary={preview.riskSummary} />

          <CapabilityDiff
            granted={preview.changes.capabilities.granted}
            revoked={preview.changes.capabilities.revoked}
            unchangedCount={preview.changes.capabilities.unchangedCount}
            capByCode={capByCode}
          />

          <FieldDiff fieldPermissions={preview.changes.fieldPermissions} />

          <ScopeDiff scopes={preview.changes.scopes} />

          <DependencyWarningsPanel
            analysis={{
              warnings: preview.warnings,
              severityCounts: preview.severityCounts,
              requiresTypedConfirmation: preview.requiresTypedConfirmation,
              typedConfirmationPhrase: preview.typedConfirmationPhrase,
            }}
          />

          {preview.requiresTypedConfirmation ? (
            <div className="rounded-md border border-status-breach/40 bg-status-breach/5 p-3">
              <Field
                label={t('typedConfirmation.fieldLabel', { phrase: required ?? '' })}
                hint={t('typedConfirmation.fieldHint')}
              >
                <Input
                  value={phrase}
                  onChange={(e) => setPhrase(e.target.value)}
                  autoFocus
                  spellCheck={false}
                  autoComplete="off"
                  data-testid="role-review-confirmation-input"
                />
              </Field>
            </div>
          ) : null}
        </div>
      )}
    </Modal>
  );
}

// ─── sections ─────────────────────────────────────────────────────

function RiskFlagsStrip({
  riskSummary,
}: {
  riskSummary: RoleChangePreviewResult['riskSummary'];
}): JSX.Element | null {
  const t = useTranslations('admin.roles.review.risks');
  const flags: Array<{ key: string; copy: string; icon: typeof FileDown }> = [];
  if (riskSummary.exportCapabilityAdded) {
    flags.push({ key: 'exportAdded', copy: t('exportAdded'), icon: FileDown });
  }
  if (riskSummary.exportCapabilityRevoked) {
    flags.push({ key: 'exportRevoked', copy: t('exportRevoked'), icon: FileDown });
  }
  if (riskSummary.backupExportChanged) {
    flags.push({ key: 'backupExport', copy: t('backupExport'), icon: ArchiveRestore });
  }
  if (riskSummary.auditVisibilityChanged) {
    flags.push({ key: 'auditVisibility', copy: t('auditVisibility'), icon: Eye });
  }
  if (riskSummary.ownerHistoryVisibilityChanged) {
    flags.push({ key: 'ownerHistory', copy: t('ownerHistory'), icon: History });
  }
  if (riskSummary.permissionAdminChanged) {
    flags.push({ key: 'permissionAdmin', copy: t('permissionAdmin'), icon: ShieldCheck });
  }
  if (riskSummary.partnerMergeChanged) {
    flags.push({ key: 'partnerMerge', copy: t('partnerMerge'), icon: Database });
  }
  if (flags.length === 0) return null;
  return (
    <section
      className="flex flex-col gap-1"
      data-testid="role-review-risks"
      aria-label={t('groupLabel')}
    >
      <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-tertiary">
        {t('groupLabel')}
      </h3>
      <ul className="flex flex-wrap gap-2">
        {flags.map(({ key, copy, icon: Icon }) => (
          <li
            key={key}
            data-flag={key}
            className="inline-flex items-center gap-1.5 rounded-full border border-status-warning/40 bg-status-warning/5 px-2 py-1 text-xs text-ink-primary"
          >
            <Icon className="h-3 w-3" aria-hidden="true" />
            <span>{copy}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function CapabilityDiff({
  granted,
  revoked,
  unchangedCount,
  capByCode,
}: {
  granted: readonly string[];
  revoked: readonly string[];
  unchangedCount: number;
  capByCode: Map<string, CapabilityCatalogueEntry>;
}): JSX.Element | null {
  const t = useTranslations('admin.roles.review.capabilities');
  if (granted.length === 0 && revoked.length === 0) return null;
  return (
    <section className="flex flex-col gap-2" data-testid="role-review-capabilities">
      <header className="flex items-baseline justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-tertiary">
          {t('header')}
        </h3>
        <span className="text-[11px] text-ink-tertiary">
          {t('summaryLine', {
            granted: granted.length,
            revoked: revoked.length,
            unchanged: unchangedCount,
          })}
        </span>
      </header>
      {granted.length > 0 ? (
        <CapabilityList
          tone="grant"
          codes={granted}
          capByCode={capByCode}
          headerLabel={t('granted', { n: granted.length })}
          icon={Plus}
        />
      ) : null}
      {revoked.length > 0 ? (
        <CapabilityList
          tone="revoke"
          codes={revoked}
          capByCode={capByCode}
          headerLabel={t('revoked', { n: revoked.length })}
          icon={Minus}
        />
      ) : null}
    </section>
  );
}

function CapabilityList({
  tone,
  codes,
  capByCode,
  headerLabel,
  icon: Icon,
}: {
  tone: 'grant' | 'revoke';
  codes: readonly string[];
  capByCode: Map<string, CapabilityCatalogueEntry>;
  headerLabel: string;
  icon: typeof Plus;
}): JSX.Element {
  const toneClasses =
    tone === 'grant'
      ? 'border-status-healthy/40 bg-status-healthy/5'
      : 'border-status-breach/40 bg-status-breach/5';
  return (
    <div
      className={cn('flex flex-col gap-1 rounded-md border px-3 py-2', toneClasses)}
      data-tone={tone}
    >
      <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-tertiary">
        {headerLabel}
      </p>
      <ul className="flex flex-col gap-1">
        {codes.map((code) => {
          const entry = capByCode.get(code);
          return (
            <li key={code} className="flex items-start gap-2 text-sm">
              <Icon
                className={cn(
                  'mt-0.5 h-3.5 w-3.5 shrink-0',
                  tone === 'grant' ? 'text-status-healthy' : 'text-status-breach',
                )}
                aria-hidden="true"
              />
              <div className="flex flex-col leading-tight">
                <span className="text-ink-primary">{entry?.description ?? code}</span>
                <code className="font-mono text-[11px] text-ink-tertiary">{code}</code>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function FieldDiff({
  fieldPermissions,
}: {
  fieldPermissions: RoleChangePreviewResult['changes']['fieldPermissions'];
}): JSX.Element | null {
  const t = useTranslations('admin.roles.review.fields');
  const total =
    fieldPermissions.readDeniedAdded.length +
    fieldPermissions.readDeniedRemoved.length +
    fieldPermissions.writeDeniedAdded.length +
    fieldPermissions.writeDeniedRemoved.length;
  if (total === 0) return null;
  return (
    <section className="flex flex-col gap-2" data-testid="role-review-fields">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-tertiary">
        {t('header')}
      </h3>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <FieldList
          title={t('readDeniedAdded', { n: fieldPermissions.readDeniedAdded.length })}
          pairs={fieldPermissions.readDeniedAdded}
          tone="deny"
          icon={UserMinus}
        />
        <FieldList
          title={t('readDeniedRemoved', { n: fieldPermissions.readDeniedRemoved.length })}
          pairs={fieldPermissions.readDeniedRemoved}
          tone="grant"
          icon={Check}
        />
        <FieldList
          title={t('writeDeniedAdded', { n: fieldPermissions.writeDeniedAdded.length })}
          pairs={fieldPermissions.writeDeniedAdded}
          tone="deny"
          icon={UserMinus}
        />
        <FieldList
          title={t('writeDeniedRemoved', { n: fieldPermissions.writeDeniedRemoved.length })}
          pairs={fieldPermissions.writeDeniedRemoved}
          tone="grant"
          icon={Check}
        />
      </div>
    </section>
  );
}

function FieldList({
  title,
  pairs,
  tone,
  icon: Icon,
}: {
  title: string;
  pairs: readonly RoleChangePreviewFieldPair[];
  tone: 'grant' | 'deny';
  icon: typeof Check;
}): JSX.Element | null {
  const locale = useLocale();
  if (pairs.length === 0) return null;
  const toneClasses =
    tone === 'grant'
      ? 'border-status-healthy/40 bg-status-healthy/5'
      : 'border-status-breach/40 bg-status-breach/5';
  return (
    <div className={cn('flex flex-col gap-1 rounded-md border px-3 py-2', toneClasses)}>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-tertiary">{title}</p>
      <ul className="flex flex-col gap-1">
        {pairs.map((p) => {
          const label = getCatalogueLabel(p.resource, p.field, locale);
          return (
            <li
              key={`${p.resource}::${p.field}`}
              className="flex items-start gap-2 text-sm"
              data-resource={p.resource}
              data-field={p.field}
            >
              <Icon
                className={cn(
                  'mt-0.5 h-3.5 w-3.5 shrink-0',
                  tone === 'grant' ? 'text-status-healthy' : 'text-status-breach',
                )}
                aria-hidden="true"
              />
              <div className="flex flex-col leading-tight">
                <span className="text-ink-primary">{label ?? `${p.resource}.${p.field}`}</span>
                <code className="font-mono text-[11px] text-ink-tertiary">
                  {p.resource}.{p.field}
                </code>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ScopeDiff({
  scopes,
}: {
  scopes: RoleChangePreviewResult['changes']['scopes'];
}): JSX.Element | null {
  const t = useTranslations('admin.roles.review.scopes');
  const tScopeResources = useTranslations('admin.roles.scopes.resources');
  const tScopeValues = useTranslations('admin.roles.scopes.values');
  const total = scopes.changed.length + scopes.added.length + scopes.removed.length;
  if (total === 0) return null;

  function resourceLabel(r: string): string {
    return tScopeResources(r as 'lead');
  }
  function valueLabel(v: string): string {
    return tScopeValues(v as 'global');
  }

  return (
    <section className="flex flex-col gap-2" data-testid="role-review-scopes">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-tertiary">
        {t('header')}
      </h3>
      {scopes.changed.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {scopes.changed.map((row: RoleChangePreviewScopeChange) => (
            <li
              key={row.resource}
              className="flex items-center justify-between rounded-md border border-status-warning/40 bg-status-warning/5 px-3 py-2 text-sm"
              data-resource={row.resource}
            >
              <span className="text-ink-primary">{resourceLabel(row.resource)}</span>
              <span className="inline-flex items-center gap-2 text-xs text-ink-secondary">
                <code className="font-mono text-[11px] text-ink-tertiary">
                  {valueLabel(row.from)}
                </code>
                <AlertOctagon className="h-3 w-3 text-status-warning" aria-hidden="true" />
                <code className="font-mono text-[11px] text-ink-primary">{valueLabel(row.to)}</code>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {scopes.added.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {scopes.added.map((row: RoleScopeRow) => (
            <li
              key={`add-${row.resource}`}
              className="flex items-center justify-between rounded-md border border-status-healthy/40 bg-status-healthy/5 px-3 py-2 text-sm"
              data-resource={row.resource}
            >
              <span className="text-ink-primary">
                <Plus className="me-1 inline h-3 w-3" aria-hidden="true" />
                {resourceLabel(row.resource)}
              </span>
              <code className="font-mono text-[11px] text-ink-primary">
                {valueLabel(row.scope)}
              </code>
            </li>
          ))}
        </ul>
      ) : null}
      {scopes.removed.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {scopes.removed.map((row: RoleScopeRow) => (
            <li
              key={`rm-${row.resource}`}
              className="flex items-center justify-between rounded-md border border-status-breach/40 bg-status-breach/5 px-3 py-2 text-sm"
              data-resource={row.resource}
            >
              <span className="text-ink-primary">
                <Minus className="me-1 inline h-3 w-3" aria-hidden="true" />
                {resourceLabel(row.resource)}
              </span>
              <code className="font-mono text-[11px] text-ink-tertiary">
                {valueLabel(row.scope)}
              </code>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
