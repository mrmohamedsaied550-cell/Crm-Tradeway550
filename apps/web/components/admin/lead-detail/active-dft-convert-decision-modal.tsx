'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, CheckCircle2, ShieldQuestion, XCircle } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Textarea } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Notice } from '@/components/ui/notice';
import { ApiError, partnerVerificationApi } from '@/lib/api';
import type { PartnerVerificationProjection, PartnerVerificationResult } from '@/lib/api-types';
import { hasCapability } from '@/lib/auth';
import { cn } from '@/lib/utils';

/**
 * Phase D4 — D4.8: Active / DFT / Convert Decision Modal.
 *
 * Replaces the legacy `window.confirm(t('convertHint'))` on lead
 * detail. Surfaces three product-distinct concepts at the moment
 * of conversion so an approver isn't tricked into thinking
 * "Convert" implies "Active":
 *
 *   • Convert  — technical CRM action. Creates / links a Captain
 *     row from the Lead. The modal triggers this through the
 *     existing `leadsApi.convert` path supplied by the caller.
 *
 *   • Active / DFT — operational partner-Active / first-trip
 *     decision. NOT performed here. The modal shows the latest
 *     partner snapshot (read-only) so the approver can decide,
 *     and points at the controlled-merge flow on PartnerDataCard
 *     for actually applying partner Active / DFT dates.
 *
 *   • Evidence — optional audit-only attach of the latest partner
 *     snapshot record as `LeadEvidence` (no Captain mutation, no
 *     merge). Renders only when the operator holds
 *     `partner.evidence.write`.
 *
 * The modal does NOT auto-merge partner dates and does NOT change
 * the conversion behaviour: the existing `onConvert` callback is
 * still the single source of truth for the technical conversion.
 */
export function ActiveDftConvertDecisionModal({
  open,
  leadName,
  leadPhone,
  leadId,
  onClose,
  onConvert,
  converting,
  convertError,
}: {
  open: boolean;
  leadName: string;
  leadPhone: string;
  leadId: string;
  onClose: () => void;
  onConvert: (opts: {
    evidence: { partnerSourceId: string; notes?: string } | null;
  }) => Promise<void>;
  converting: boolean;
  convertError: string | null;
}): JSX.Element {
  const t = useTranslations('admin.leads.detail.convertDecision');
  const tStatus = useTranslations('admin.partnerData.status');
  const tCommon = useTranslations('admin.common');

  const canAttachEvidence = hasCapability('partner.evidence.write');
  const canRead = hasCapability('partner.verification.read');

  const [verification, setVerification] = useState<PartnerVerificationResult | null>(null);
  const [verifyLoading, setVerifyLoading] = useState<boolean>(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [attachEvidence, setAttachEvidence] = useState<boolean>(false);
  const [evidenceSourceId, setEvidenceSourceId] = useState<string>('');
  const [evidenceNote, setEvidenceNote] = useState<string>('');

  useEffect(() => {
    if (!open) return;
    if (!canRead) {
      setVerification(null);
      return;
    }
    let cancelled = false;
    setVerifyLoading(true);
    setVerifyError(null);
    partnerVerificationApi
      .forLead(leadId)
      .then((res) => {
        if (cancelled) return;
        setVerification(res);
        // Default the evidence source to the freshest projection.
        if (res.projections.length > 0) {
          const sorted = [...res.projections].sort((a, b) => {
            const at = a.lastSyncAt ? Date.parse(a.lastSyncAt) : 0;
            const bt = b.lastSyncAt ? Date.parse(b.lastSyncAt) : 0;
            return bt - at;
          });
          setEvidenceSourceId(sorted[0]?.partnerSourceId ?? '');
        }
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.code === 'partner.feature.disabled') {
          setVerification(null);
          setVerifyError(null);
        } else {
          setVerifyError(err instanceof ApiError ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) setVerifyLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, leadId, canRead]);

  // Reset transient state when the modal closes.
  useEffect(() => {
    if (!open) {
      setAttachEvidence(false);
      setEvidenceNote('');
    }
  }, [open]);

  async function onConfirm(): Promise<void> {
    const evidence =
      attachEvidence && evidenceSourceId.length > 0
        ? {
            partnerSourceId: evidenceSourceId,
            ...(evidenceNote.trim().length > 0 ? { notes: evidenceNote.trim() } : {}),
          }
        : null;
    await onConvert({ evidence });
  }

  const evidenceSource = verification?.projections.find(
    (p) => p.partnerSourceId === evidenceSourceId,
  );
  const evidenceCheckboxDisabled =
    !canAttachEvidence || !verification || verification.projections.length === 0;

  return (
    <Modal
      open={open}
      title={t('title')}
      onClose={() => (converting ? undefined : onClose())}
      width="lg"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={converting}>
            {tCommon('cancel')}
          </Button>
          <Button size="sm" onClick={() => void onConfirm()} loading={converting}>
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
            {t('confirmCta')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {/* Distinction notice — Convert ≠ Active. */}
        <Notice tone="info">
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium text-ink-primary">{t('distinctionTitle')}</span>
            <span className="text-xs text-ink-secondary">{t('distinctionBody')}</span>
          </div>
        </Notice>

        {/* Lead summary */}
        <dl className="grid grid-cols-1 gap-3 rounded-md border border-surface-border bg-surface px-3 py-2 sm:grid-cols-2">
          <Field2 label={t('lead')} value={leadName} />
          <Field2 label={t('phone')} value={leadPhone} mono />
        </dl>

        {/* Read-only partner verification summary */}
        {!canRead ? (
          <Notice tone="info">{t('noPartnerAccess')}</Notice>
        ) : verifyLoading ? (
          <p className="text-sm text-ink-tertiary">{tCommon('loading')}</p>
        ) : verifyError ? (
          <Notice tone="error">{verifyError}</Notice>
        ) : !verification || verification.projections.length === 0 ? (
          <Notice tone="info">{t('noPartnerData')}</Notice>
        ) : (
          <div className="flex flex-col gap-2 rounded-md border border-surface-border bg-surface-card px-3 py-2">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-tertiary">
              {t('partnerSummaryHeader')}
            </span>
            <ul className="flex flex-col gap-2">
              {verification.projections.map((p) => (
                <li key={p.partnerSourceId}>
                  <PartnerProjectionRow projection={p} tStatus={tStatus} t={t} />
                </li>
              ))}
            </ul>
            <p className="text-[11px] text-ink-tertiary">{t('mergeRedirectHint')}</p>
          </div>
        )}

        {/* Optional evidence attach */}
        {canAttachEvidence ? (
          <div className="flex flex-col gap-2 rounded-md border border-surface-border bg-surface-card px-3 py-2">
            <label
              className={cn(
                'inline-flex items-start gap-2 text-sm text-ink-primary',
                evidenceCheckboxDisabled && 'opacity-60',
              )}
            >
              <input
                type="checkbox"
                checked={attachEvidence}
                disabled={evidenceCheckboxDisabled}
                onChange={(e) => setAttachEvidence(e.target.checked)}
                className="mt-1"
              />
              <span className="flex flex-col">
                <span className="font-medium">{t('attachEvidenceLabel')}</span>
                <span className="text-xs text-ink-tertiary">{t('attachEvidenceHelper')}</span>
              </span>
            </label>

            {attachEvidence && verification && verification.projections.length > 1 ? (
              <Field label={t('evidenceSourceLabel')}>
                <select
                  value={evidenceSourceId}
                  onChange={(e) => setEvidenceSourceId(e.target.value)}
                  className="rounded-md border border-surface-border bg-surface-card px-2 py-1 text-sm text-ink-primary"
                >
                  {verification.projections.map((p) => (
                    <option key={p.partnerSourceId} value={p.partnerSourceId}>
                      {p.partnerSourceName}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}

            {attachEvidence ? (
              <Field label={t('evidenceNoteLabel')} hint={t('evidenceNoteHelper')}>
                <Textarea
                  value={evidenceNote}
                  onChange={(e) => setEvidenceNote(e.target.value)}
                  rows={2}
                  maxLength={1000}
                />
              </Field>
            ) : null}

            {attachEvidence && evidenceSource && evidenceSource.recordId === null ? (
              <Notice tone="info">{t('evidenceNoRecord')}</Notice>
            ) : null}
          </div>
        ) : null}

        {convertError ? <Notice tone="error">{convertError}</Notice> : null}
      </div>
    </Modal>
  );
}

function PartnerProjectionRow({
  projection,
  t,
  tStatus,
}: {
  projection: PartnerVerificationProjection;
  t: ReturnType<typeof useTranslations>;
  tStatus: ReturnType<typeof useTranslations>;
}): JSX.Element {
  const found = projection.recordId !== null;
  return (
    <div className="flex flex-col gap-1 rounded-md border border-surface-border bg-surface px-2 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-ink-primary">{projection.partnerSourceName}</span>
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
        <VerificationStatusBadge status={projection.verificationStatus} tStatus={tStatus} />
      </div>
      {found ? (
        <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Field2 label={t('partnerStatus')} value={projection.partnerStatus} />
          <Field2 label={t('partnerActiveDate')} value={formatDate(projection.partnerActiveDate)} />
          <Field2 label={t('partnerDftDate')} value={formatDate(projection.partnerDftDate)} />
          <Field2
            label={t('partnerTrips')}
            value={projection.tripCount !== null ? String(projection.tripCount) : null}
          />
        </dl>
      ) : (
        <p className="text-xs text-ink-tertiary">{t('partnerNotFoundBody')}</p>
      )}
    </div>
  );
}

function VerificationStatusBadge({
  status,
  tStatus,
}: {
  status: string;
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

function Field2({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string | null;
  mono?: boolean;
}): JSX.Element {
  return (
    <div className="flex flex-col">
      <dt className="text-[11px] uppercase tracking-wide text-ink-tertiary">{label}</dt>
      <dd className={cn('text-sm text-ink-primary', mono && 'font-mono text-xs')}>
        {value ?? <span className="text-ink-tertiary">—</span>}
      </dd>
    </div>
  );
}

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString();
}
