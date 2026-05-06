'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  ArrowUpRight,
  Clock,
  History,
  RotateCcw,
  ShieldAlert,
  User as UserIcon,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Notice } from '@/components/ui/notice';
import { useToast } from '@/components/ui/toast';
import { ApiError, rolesApi } from '@/lib/api';
import { hasCapability } from '@/lib/auth';
import { cn } from '@/lib/utils';
import type {
  RoleVersionDetail,
  RoleVersionListItem,
  RoleVersionTriggerAction,
} from '@/lib/api-types';

/**
 * Phase D5 — D5.15-B: role version history tab.
 *
 * Renders the audit-style timeline of role-write events: who
 * changed the role, when, what kind of write (create / update /
 * scopes / field-permissions / duplicate / revert), and a small
 * counts row for the diff. The "View details" button opens a
 * full-snapshot drawer; the "Revert" button (visible only when
 * the actor holds `roles.write` and the role isn't system) opens
 * the typed-confirmation revert modal.
 *
 * The runtime resolver does NOT consult this surface — it is
 * purely a governance + transparency UX layer.
 */

export function RoleHistoryTab({
  roleId,
  roleIsSystem,
  onReverted,
}: {
  roleId: string;
  roleIsSystem: boolean;
  /** Called after a successful revert so the parent reloads the role. */
  onReverted: () => Promise<void>;
}): JSX.Element {
  const t = useTranslations('admin.roles.history');
  const tCommon = useTranslations('admin.common');
  const { toast } = useToast();
  const canWrite = hasCapability('roles.write');

  const [items, setItems] = useState<readonly RoleVersionListItem[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<RoleVersionDetail | null>(null);
  const [revertTarget, setRevertTarget] = useState<RoleVersionListItem | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const page = await rolesApi.listVersions(roleId);
      setItems(page.items);
      setTotal(page.total);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      setItems([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [roleId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <div
      className="flex flex-col gap-3 rounded-lg border border-surface-border bg-surface-card p-5 shadow-card"
      data-testid="role-history-tab"
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-sm font-semibold text-ink-primary">{t('header')}</h2>
          <p className="text-xs text-ink-secondary">{t('subtitle', { count: total })}</p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void reload()} disabled={loading}>
          {tCommon('refresh')}
        </Button>
      </header>

      {error ? <Notice tone="error">{error}</Notice> : null}

      {loading && items.length === 0 ? (
        <p className="rounded-md border border-surface-border bg-surface px-4 py-6 text-center text-sm text-ink-secondary">
          {tCommon('loading')}
        </p>
      ) : items.length === 0 ? (
        <EmptyState
          icon={<History className="h-7 w-7" aria-hidden="true" />}
          title={t('empty.title')}
          body={t('empty.body')}
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((row) => (
            <li
              key={row.id}
              data-version-number={row.versionNumber}
              data-trigger-action={row.triggerAction}
            >
              <VersionRow
                row={row}
                canRevert={canWrite && !roleIsSystem}
                onViewDetails={async () => {
                  try {
                    const d = await rolesApi.getVersion(roleId, row.id);
                    setDetail(d);
                  } catch (err) {
                    setError(err instanceof ApiError ? err.message : String(err));
                  }
                }}
                onRevert={() => setRevertTarget(row)}
              />
            </li>
          ))}
        </ul>
      )}

      <VersionDetailModal detail={detail} onClose={() => setDetail(null)} />

      <RevertVersionModal
        roleId={roleId}
        target={revertTarget}
        onCancel={() => setRevertTarget(null)}
        onSuccess={async () => {
          setRevertTarget(null);
          toast({ tone: 'success', title: t('revert.successToast') });
          await reload();
          await onReverted();
        }}
      />
    </div>
  );
}

// ─── Version row ─────────────────────────────────────────────────

function VersionRow({
  row,
  canRevert,
  onViewDetails,
  onRevert,
}: {
  row: RoleVersionListItem;
  canRevert: boolean;
  onViewDetails: () => Promise<void>;
  onRevert: () => void;
}): JSX.Element {
  const t = useTranslations('admin.roles.history');
  const created = new Date(row.createdAt);
  const riskHits = collectRiskHits(row.changeSummary.riskFlags);

  return (
    <article className="flex flex-col gap-2 rounded-md border border-surface-border bg-surface px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="info">v{row.versionNumber}</Badge>
          <TriggerBadge action={row.triggerAction} />
          <span className="inline-flex items-center gap-1 text-xs text-ink-secondary">
            <UserIcon className="h-3 w-3" aria-hidden="true" />
            {row.actor.name ?? row.actor.email ?? t('actorSystem')}
          </span>
          <span className="inline-flex items-center gap-1 text-[11px] text-ink-tertiary">
            <Clock className="h-3 w-3" aria-hidden="true" />
            {created.toLocaleString()}
          </span>
        </div>
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void onViewDetails()}
            data-testid="role-history-view-details"
          >
            <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
            {t('actions.viewDetails')}
          </Button>
          {canRevert ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={onRevert}
              data-testid="role-history-revert"
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
              {t('actions.revert')}
            </Button>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-xs text-ink-secondary">
        <span>{t('counts.granted', { n: row.counts.grantedCapabilities })}</span>
        <span>{t('counts.revoked', { n: row.counts.revokedCapabilities })}</span>
        <span>{t('counts.fields', { n: row.counts.fieldPermissionChanges })}</span>
        <span>{t('counts.scopes', { n: row.counts.scopeChanges })}</span>
      </div>

      {riskHits.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {riskHits.map((hit) => (
            <li
              key={hit}
              className="inline-flex items-center gap-1 rounded-full border border-status-warning/40 bg-status-warning/5 px-2 py-0.5 text-[10px] uppercase tracking-wide text-ink-primary"
              data-flag={hit}
            >
              <ShieldAlert className="h-2.5 w-2.5" aria-hidden="true" />
              {t(`risks.${hit}` as 'risks.exportCapabilityAdded')}
            </li>
          ))}
        </ul>
      ) : null}

      {row.reason ? (
        <p className="text-[11px] italic text-ink-tertiary">
          {t('reasonPrefix')} {row.reason}
        </p>
      ) : null}
    </article>
  );
}

function TriggerBadge({ action }: { action: RoleVersionTriggerAction }): JSX.Element {
  const t = useTranslations('admin.roles.history.trigger');
  const tone = (
    {
      create: 'healthy',
      update: 'info',
      duplicate: 'info',
      scopes: 'info',
      field_permissions: 'info',
      revert: 'warning',
    } as const
  )[action];
  return <Badge tone={tone}>{t(action)}</Badge>;
}

function collectRiskHits(
  flags: RoleVersionListItem['changeSummary']['riskFlags'],
): readonly string[] {
  const out: string[] = [];
  if (flags.exportCapabilityAdded) out.push('exportCapabilityAdded');
  if (flags.exportCapabilityRevoked) out.push('exportCapabilityRevoked');
  if (flags.backupExportChanged) out.push('backupExportChanged');
  if (flags.auditVisibilityChanged) out.push('auditVisibilityChanged');
  if (flags.ownerHistoryVisibilityChanged) out.push('ownerHistoryVisibilityChanged');
  if (flags.permissionAdminChanged) out.push('permissionAdminChanged');
  if (flags.partnerMergeChanged) out.push('partnerMergeChanged');
  return out;
}

// ─── Version detail modal ─────────────────────────────────────────

function VersionDetailModal({
  detail,
  onClose,
}: {
  detail: RoleVersionDetail | null;
  onClose: () => void;
}): JSX.Element | null {
  const t = useTranslations('admin.roles.history.detail');
  if (!detail) return null;
  const snap = detail.snapshot;
  return (
    <Modal
      open={detail !== null}
      title={t('title', { version: detail.versionNumber })}
      onClose={onClose}
      width="lg"
      footer={
        <Button variant="ghost" onClick={onClose}>
          {t('close')}
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <section className="flex flex-col gap-1">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-tertiary">
            {t('metadata')}
          </h3>
          <dl className="grid grid-cols-2 gap-2 rounded-md border border-surface-border bg-surface px-3 py-2 text-xs">
            <div>
              <dt className="text-ink-tertiary">{t('fields.code')}</dt>
              <dd className="font-mono text-ink-primary">{snap.metadata.code}</dd>
            </div>
            <div>
              <dt className="text-ink-tertiary">{t('fields.level')}</dt>
              <dd className="text-ink-primary">{snap.metadata.level}</dd>
            </div>
            <div>
              <dt className="text-ink-tertiary">{t('fields.nameEn')}</dt>
              <dd className="text-ink-primary">{snap.metadata.nameEn}</dd>
            </div>
            <div>
              <dt className="text-ink-tertiary">{t('fields.nameAr')}</dt>
              <dd className="text-ink-primary">{snap.metadata.nameAr}</dd>
            </div>
          </dl>
        </section>

        <section className="flex flex-col gap-1">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-tertiary">
            {t('capabilities', { n: snap.capabilities.length })}
          </h3>
          <ul className="flex flex-wrap gap-1">
            {snap.capabilities.map((c) => (
              <li
                key={c}
                className="inline-flex items-center rounded-md border border-surface-border bg-surface px-2 py-0.5 font-mono text-[11px] text-ink-secondary"
              >
                {c}
              </li>
            ))}
          </ul>
        </section>

        <section className="flex flex-col gap-1">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-tertiary">
            {t('scopes')}
          </h3>
          <ul className="flex flex-col gap-1">
            {snap.scopes.map((s) => (
              <li
                key={s.resource}
                className="flex items-center justify-between rounded-md border border-surface-border bg-surface px-3 py-1.5 text-xs"
              >
                <code className="font-mono text-ink-primary">{s.resource}</code>
                <code className="font-mono text-ink-secondary">{s.scope}</code>
              </li>
            ))}
            {snap.scopes.length === 0 ? (
              <li className="text-[11px] italic text-ink-tertiary">{t('emptyScopes')}</li>
            ) : null}
          </ul>
        </section>

        <section className="flex flex-col gap-1">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-tertiary">
            {t('fieldPermissions', { n: snap.fieldPermissions.length })}
          </h3>
          <ul className="flex flex-col gap-1">
            {snap.fieldPermissions.map((p) => (
              <li
                key={`${p.resource}::${p.field}`}
                className="flex items-center justify-between rounded-md border border-surface-border bg-surface px-3 py-1.5 text-xs"
              >
                <code className="font-mono text-ink-primary">
                  {p.resource}.{p.field}
                </code>
                <span className="inline-flex items-center gap-1 text-[11px] text-ink-secondary">
                  <span className={cn(p.canRead ? 'text-status-healthy' : 'text-status-breach')}>
                    {p.canRead ? 'R' : 'r̶'}
                  </span>
                  <span className={cn(p.canWrite ? 'text-status-healthy' : 'text-status-breach')}>
                    {p.canWrite ? 'W' : 'w̶'}
                  </span>
                </span>
              </li>
            ))}
            {snap.fieldPermissions.length === 0 ? (
              <li className="text-[11px] italic text-ink-tertiary">{t('emptyFieldPermissions')}</li>
            ) : null}
          </ul>
        </section>
      </div>
    </Modal>
  );
}

// ─── Revert modal ────────────────────────────────────────────────

function RevertVersionModal({
  roleId,
  target,
  onCancel,
  onSuccess,
}: {
  roleId: string;
  target: RoleVersionListItem | null;
  onCancel: () => void;
  onSuccess: () => Promise<void>;
}): JSX.Element | null {
  const t = useTranslations('admin.roles.history.revert');
  const [confirmation, setConfirmation] = useState<string>('');
  const [reason, setReason] = useState<string>('');
  const [pendingPhrase, setPendingPhrase] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  if (!target) return null;
  const requiresPhrase = pendingPhrase !== null;
  const matches = !requiresPhrase || confirmation === pendingPhrase;

  async function onConfirm(): Promise<void> {
    if (!target) return;
    setSubmitting(true);
    setError(null);
    try {
      await rolesApi.revertVersion(roleId, target.id, {
        ...(requiresPhrase ? { confirmation } : {}),
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      });
      await onSuccess();
      setConfirmation('');
      setReason('');
      setPendingPhrase(null);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'role.dependency.confirmation_required') {
        const raw = err.raw as { requiredPhrase?: string } | undefined;
        if (raw?.requiredPhrase) setPendingPhrase(raw.requiredPhrase);
        setError(t('typedConfirmationRequired'));
      } else {
        setError(err instanceof ApiError ? err.message : String(err));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={target !== null}
      title={t('title', { version: target.versionNumber })}
      onClose={onCancel}
      width="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={submitting}>
            {t('actions.cancel')}
          </Button>
          <Button
            variant="danger"
            onClick={() => void onConfirm()}
            loading={submitting}
            disabled={!matches || submitting}
            aria-disabled={!matches || submitting}
            data-testid="role-history-revert-confirm"
          >
            {t('actions.confirm')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Notice tone="info">
          <span>{t('intro', { version: target.versionNumber })}</span>
        </Notice>
        {error ? <Notice tone="error">{error}</Notice> : null}

        <Field label={t('reasonLabel')} hint={t('reasonHint')}>
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
            data-testid="role-history-revert-reason"
          />
        </Field>

        {requiresPhrase ? (
          <div className="rounded-md border border-status-breach/40 bg-status-breach/5 p-3">
            <Field
              label={t('typedConfirmation.fieldLabel', { phrase: pendingPhrase ?? '' })}
              hint={t('typedConfirmation.fieldHint')}
            >
              <Input
                value={confirmation}
                onChange={(e) => setConfirmation(e.target.value)}
                spellCheck={false}
                autoComplete="off"
                autoFocus
                data-testid="role-history-revert-confirmation"
              />
            </Field>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
