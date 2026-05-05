'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  Loader2,
  Phone,
  RefreshCw,
  Save,
  ShieldQuestion,
  XCircle,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field as InputField, Textarea } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Notice } from '@/components/ui/notice';
import { useToast } from '@/components/ui/toast';
import { ApiError, partnerVerificationApi } from '@/lib/api';
import type {
  PartnerMergeableField,
  PartnerVerificationProjection,
  PartnerVerificationResult,
  PartnerVerificationStatus,
} from '@/lib/api-types';
import { hasCapability } from '@/lib/auth';
import { cn } from '@/lib/utils';

/**
 * Phase D4 — D4.4 → D4.5: Partner Data Card on lead detail.
 *
 * D4.4 — read-only verification surface.
 * D4.5 — adds per-field "Use partner …" merge buttons gated on
 * `partner.merge.write`. Buttons appear only when:
 *   • the lead has a captain (otherwise we surface a friendly hint
 *     pointing the operator at the conversion flow),
 *   • the partner record exists with a non-null value for the
 *     selected field,
 *   • the merge result wouldn't be a no-op (we still let the
 *     server make the final call — the button is just a UX hint).
 *
 * No merge runs without a confirmation modal showing CRM value vs
 * partner value, source, snapshot time, and an optional evidence
 * note. The backend audits every merge with structured before /
 * after.
 */
export function PartnerDataCard({ leadId }: { leadId: string }): JSX.Element | null {
  const t = useTranslations('admin.partnerData');
  const tStatus = useTranslations('admin.partnerData.status');
  const tWarn = useTranslations('admin.partnerData.warnings');
  const tMerge = useTranslations('admin.partnerData.merge');
  const tCommon = useTranslations('admin.common');
  const { toast } = useToast();

  const canRead = hasCapability('partner.verification.read');
  const canMerge = hasCapability('partner.merge.write');

  const [data, setData] = useState<PartnerVerificationResult | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [featureDisabled, setFeatureDisabled] = useState<boolean>(false);
  const [activeSourceId, setActiveSourceId] = useState<string | null>(null);
  const [checking, setChecking] = useState<boolean>(false);

  // Merge confirmation modal state.
  const [mergeOpen, setMergeOpen] = useState<boolean>(false);
  const [mergeField, setMergeField] = useState<PartnerMergeableField | null>(null);
  const [mergeNote, setMergeNote] = useState<string>('');
  const [merging, setMerging] = useState<boolean>(false);
  const [mergeError, setMergeError] = useState<string | null>(null);

  const reload = useCallback(
    async (explicitCheck = false): Promise<void> => {
      if (!canRead) {
        setLoading(false);
        return;
      }
      if (explicitCheck) setChecking(true);
      else setLoading(true);
      setError(null);
      try {
        const result = await partnerVerificationApi.forLead(leadId, {
          ...(explicitCheck && { explicitCheck: true }),
        });
        setData(result);
        setFeatureDisabled(false);
        if (result.projections.length > 0) {
          const sorted = [...result.projections].sort((a, b) => {
            const at = a.lastSyncAt ? Date.parse(a.lastSyncAt) : 0;
            const bt = b.lastSyncAt ? Date.parse(b.lastSyncAt) : 0;
            return bt - at;
          });
          if (
            !activeSourceId ||
            !result.projections.some((p) => p.partnerSourceId === activeSourceId)
          ) {
            setActiveSourceId(sorted[0]?.partnerSourceId ?? null);
          }
        }
      } catch (err) {
        if (err instanceof ApiError && err.code === 'partner.feature.disabled') {
          setFeatureDisabled(true);
          setData(null);
        } else {
          setError(err instanceof ApiError ? err.message : String(err));
        }
      } finally {
        setLoading(false);
        setChecking(false);
      }
    },
    [canRead, leadId, activeSourceId],
  );

  useEffect(() => {
    void reload(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadId, canRead]);

  const active = useMemo(
    () =>
      data?.projections.find((p) => p.partnerSourceId === activeSourceId) ??
      data?.projections[0] ??
      null,
    [data, activeSourceId],
  );

  function openMerge(field: PartnerMergeableField): void {
    setMergeField(field);
    setMergeNote('');
    setMergeError(null);
    setMergeOpen(true);
  }

  async function onConfirmMerge(): Promise<void> {
    if (!mergeField || !active) return;
    setMerging(true);
    setMergeError(null);
    try {
      await partnerVerificationApi.merge(leadId, {
        partnerSourceId: active.partnerSourceId,
        fields: [mergeField],
        ...(mergeNote.trim().length > 0 ? { evidenceNote: mergeNote.trim() } : {}),
      });
      toast({
        tone: 'success',
        title: tMerge(`toast.${mergeField}` as 'toast.active_date'),
      });
      setMergeOpen(false);
      setMergeField(null);
      setMergeNote('');
      await reload(false);
    } catch (err) {
      setMergeError(err instanceof ApiError ? translateMergeError(err, tMerge) : String(err));
    } finally {
      setMerging(false);
    }
  }

  if (!canRead) return null;

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-surface-border bg-surface-card p-4 shadow-card">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-base font-semibold text-ink-primary">
          <Database className="h-4 w-4 text-brand-700" aria-hidden="true" />
          {t('title')}
        </h2>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void reload(true)}
          loading={checking}
          disabled={loading || featureDisabled}
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          {t('checkNow')}
        </Button>
      </header>

      {featureDisabled ? <Notice tone="info">{t('featureDisabled')}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}

      {loading ? (
        <p className="flex items-center gap-2 text-sm text-ink-tertiary">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          {t('loading')}
        </p>
      ) : !data || data.projections.length === 0 ? (
        <p className="text-sm text-ink-tertiary">{t('noPartnerData')}</p>
      ) : (
        <>
          {data.projections.length > 1 ? (
            <div className="flex flex-wrap gap-2">
              {data.projections.map((p) => (
                <button
                  key={p.partnerSourceId}
                  type="button"
                  onClick={() => setActiveSourceId(p.partnerSourceId)}
                  className={cn(
                    'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                    activeSourceId === p.partnerSourceId
                      ? 'border-brand-600 bg-brand-50 text-brand-700'
                      : 'border-surface-border bg-surface-card text-ink-secondary hover:bg-surface',
                  )}
                >
                  {p.partnerSourceName}
                </button>
              ))}
            </div>
          ) : null}

          {active ? (
            <SourcePanel
              projection={active}
              t={t}
              tStatus={tStatus}
              tWarn={tWarn}
              tMerge={tMerge}
              phone={data.phone}
              hasCaptain={data.hasCaptain}
              canMerge={canMerge}
              onMerge={openMerge}
            />
          ) : null}
        </>
      )}

      {/* Merge confirmation modal */}
      <Modal
        open={mergeOpen}
        title={tMerge('confirmTitle')}
        onClose={() => (merging ? undefined : setMergeOpen(false))}
        width="md"
        footer={
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setMergeOpen(false)}
              disabled={merging}
            >
              {tCommon('cancel')}
            </Button>
            <Button size="sm" onClick={() => void onConfirmMerge()} loading={merging}>
              <Save className="h-3.5 w-3.5" aria-hidden="true" />
              {tMerge('confirmCta')}
            </Button>
          </>
        }
      >
        {mergeField && active ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-ink-primary">
              {tMerge(`confirmBody.${mergeField}` as 'confirmBody.active_date')}
            </p>
            <div className="flex flex-col gap-2 rounded-md border border-status-warning/40 bg-status-warning/10 px-3 py-2 text-xs text-status-warning">
              <span className="inline-flex items-center gap-1 font-medium">
                <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                {tMerge('confirmWarning')}
              </span>
            </div>
            <dl className="grid grid-cols-1 gap-3 rounded-md border border-surface-border bg-surface px-3 py-2 sm:grid-cols-2">
              <ConfirmField label={tMerge('partnerSourceLabel')} value={active.partnerSourceName} />
              <ConfirmField
                label={tMerge('snapshotTimeLabel')}
                value={active.lastSyncAt ? new Date(active.lastSyncAt).toLocaleString() : null}
              />
              <ConfirmField
                label={tMerge('partnerValueLabel')}
                value={
                  mergeField === 'active_date'
                    ? formatDate(active.partnerActiveDate)
                    : formatDate(active.partnerDftDate)
                }
              />
              <ConfirmField label={tMerge('crmValueLabel')} value={tMerge('crmValueHint')} muted />
            </dl>
            <InputField label={tMerge('noteLabel')} hint={tMerge('noteHelper')}>
              <Textarea
                value={mergeNote}
                onChange={(e) => setMergeNote(e.target.value)}
                rows={3}
                maxLength={1000}
                placeholder={tMerge('notePlaceholder')}
              />
            </InputField>
            {mergeError ? <Notice tone="error">{mergeError}</Notice> : null}
          </div>
        ) : null}
      </Modal>
    </section>
  );
}

function SourcePanel({
  projection,
  t,
  tStatus,
  tWarn,
  tMerge,
  phone,
  hasCaptain,
  canMerge,
  onMerge,
}: {
  projection: PartnerVerificationProjection;
  t: ReturnType<typeof useTranslations>;
  tStatus: ReturnType<typeof useTranslations>;
  tWarn: ReturnType<typeof useTranslations>;
  tMerge: ReturnType<typeof useTranslations>;
  phone: string | null;
  hasCaptain: boolean;
  canMerge: boolean;
  onMerge: (field: PartnerMergeableField) => void;
}): JSX.Element {
  const found = projection.recordId !== null;
  const neverSynced = projection.lastSyncAt === null;

  if (neverSynced) {
    return (
      <Notice tone="info">
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium text-ink-primary">
            {projection.partnerSourceName}
          </span>
          <span className="text-xs text-ink-secondary">{t('neverSynced')}</span>
        </div>
      </Notice>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Source + last sync header */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-ink-primary">
            {projection.partnerSourceName}
          </span>
          <Badge tone="neutral">{projection.partnerCode}</Badge>
          {found ? (
            <Badge tone="info">
              <CheckCircle2 className="me-1 h-3 w-3" aria-hidden="true" />
              {t('foundBadge')}
            </Badge>
          ) : (
            <Badge tone="neutral">
              <XCircle className="me-1 h-3 w-3" aria-hidden="true" />
              {t('notFoundBadge')}
            </Badge>
          )}
          <VerificationBadge status={projection.verificationStatus} tStatus={tStatus} />
        </div>
        <span className="text-xs text-ink-tertiary">
          {t('lastSync')}: {new Date(projection.lastSyncAt!).toLocaleString()}
        </span>
      </div>

      {phone ? (
        <p className="inline-flex items-center gap-1 text-xs text-ink-tertiary">
          <Phone className="h-3 w-3" aria-hidden="true" />
          <span className="font-mono">{phone}</span>
        </p>
      ) : null}

      {/* Field grid + per-field merge buttons */}
      {found ? (
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <DataField label={t('fields.partnerStatus')} value={projection.partnerStatus} />
          <DataField
            label={t('fields.partnerActiveDate')}
            value={formatDate(projection.partnerActiveDate)}
            action={
              canMerge && projection.partnerActiveDate ? (
                <MergeButton
                  field="active_date"
                  hasCaptain={hasCaptain}
                  onClick={onMerge}
                  tMerge={tMerge}
                />
              ) : null
            }
          />
          <DataField
            label={t('fields.partnerDftDate')}
            value={formatDate(projection.partnerDftDate)}
            action={
              canMerge && projection.partnerDftDate ? (
                <MergeButton
                  field="dft_date"
                  hasCaptain={hasCaptain}
                  onClick={onMerge}
                  tMerge={tMerge}
                />
              ) : null
            }
          />
          <DataField
            label={t('fields.tripCount')}
            value={projection.tripCount?.toString() ?? null}
          />
          <DataField
            label={t('fields.lastTripAt')}
            value={projection.lastTripAt ? new Date(projection.lastTripAt).toLocaleString() : null}
          />
        </dl>
      ) : (
        <p className="text-sm text-ink-tertiary">{t('notFoundBody')}</p>
      )}

      {/* Captain-required hint when merge buttons are visible but
          there's no captain. Plays the role of the inline "Create or
          link a captain before merging" copy from the spec. */}
      {canMerge && found && !hasCaptain ? (
        <p className="rounded-md border border-surface-border bg-surface px-3 py-2 text-xs text-ink-secondary">
          {tMerge('noCaptainHint')}
        </p>
      ) : null}

      {/* Warnings */}
      {projection.warnings.length > 0 ? (
        <div className="flex flex-col gap-1 rounded-md border border-status-warning/40 bg-status-warning/10 px-3 py-2 text-xs text-status-warning">
          <span className="inline-flex items-center gap-1 font-medium">
            <AlertTriangle className="h-3 w-3" aria-hidden="true" />
            {t('warningsHeader')}
          </span>
          <ul className="ms-4 list-disc">
            {projection.warnings.map((w) => (
              <li key={w}>{tWarn(w as 'date_mismatch')}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function DataField({
  label,
  value,
  action,
}: {
  label: string;
  value: string | null;
  action?: JSX.Element | null;
}): JSX.Element {
  return (
    <div className="flex flex-col">
      <dt className="text-[11px] uppercase tracking-wide text-ink-tertiary">{label}</dt>
      <dd className="flex flex-wrap items-center justify-between gap-2 text-sm text-ink-primary">
        <span>{value ?? <span className="text-ink-tertiary">—</span>}</span>
        {action}
      </dd>
    </div>
  );
}

function MergeButton({
  field,
  hasCaptain,
  onClick,
  tMerge,
}: {
  field: PartnerMergeableField;
  hasCaptain: boolean;
  onClick: (field: PartnerMergeableField) => void;
  tMerge: ReturnType<typeof useTranslations>;
}): JSX.Element {
  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={() => onClick(field)}
      disabled={!hasCaptain}
      title={!hasCaptain ? tMerge('noCaptainHint') : undefined}
    >
      {tMerge(`useCta.${field}` as 'useCta.active_date')}
    </Button>
  );
}

function VerificationBadge({
  status,
  tStatus,
}: {
  status: PartnerVerificationStatus;
  tStatus: ReturnType<typeof useTranslations>;
}): JSX.Element {
  const label = tStatus(status as 'matched');
  if (status === 'matched') {
    return (
      <Badge tone="info">
        <CheckCircle2 className="me-1 h-3 w-3" aria-hidden="true" />
        {label}
      </Badge>
    );
  }
  if (status === 'not_found') {
    return (
      <Badge tone="neutral">
        <ShieldQuestion className="me-1 h-3 w-3" aria-hidden="true" />
        {label}
      </Badge>
    );
  }
  return (
    <Badge tone="warning">
      <AlertTriangle className="me-1 h-3 w-3" aria-hidden="true" />
      {label}
    </Badge>
  );
}

function ConfirmField({
  label,
  value,
  muted = false,
}: {
  label: string;
  value: string | null;
  muted?: boolean;
}): JSX.Element {
  return (
    <div className="flex flex-col">
      <dt className="text-[11px] uppercase tracking-wide text-ink-tertiary">{label}</dt>
      <dd className={cn('text-sm', muted ? 'text-ink-tertiary' : 'text-ink-primary')}>
        {value ?? <span className="text-ink-tertiary">—</span>}
      </dd>
    </div>
  );
}

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString();
}

function translateMergeError(err: ApiError, tMerge: ReturnType<typeof useTranslations>): string {
  const code = err.code ?? '';
  if (code === 'partner.merge.no_captain') return tMerge('errors.no_captain');
  if (code === 'partner.merge.no_record') return tMerge('errors.no_record');
  if (code === 'partner.merge.field_not_mergeable') return tMerge('errors.field_not_mergeable');
  if (code === 'partner.merge.field_missing_in_partner')
    return tMerge('errors.field_missing_in_partner');
  if (code === 'partner.merge.value_unchanged') return tMerge('errors.value_unchanged');
  if (code === 'partner.merge.snapshot_stale') return tMerge('errors.snapshot_stale');
  if (code === 'partner.feature.disabled') return tMerge('errors.feature_disabled');
  return err.message;
}
