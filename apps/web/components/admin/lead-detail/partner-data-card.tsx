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
  ShieldQuestion,
  XCircle,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { ApiError, partnerVerificationApi } from '@/lib/api';
import type {
  PartnerVerificationProjection,
  PartnerVerificationResult,
  PartnerVerificationStatus,
} from '@/lib/api-types';
import { hasCapability } from '@/lib/auth';
import { cn } from '@/lib/utils';

/**
 * Phase D4 — D4.4: Partner Data Card on lead detail.
 *
 * Read-only verification surface. Mounted on `/admin/leads/[id]`
 * by the lead detail page. Sales / activation / driving agents
 * fail the `partner.verification.read` capability gate and the
 * card hides itself entirely (returns null) — same pattern as
 * other capability-gated detail cards.
 *
 * No merge actions, no "Use this date" buttons, no
 * source-config link, no raw row payload. Multi-source: one tab
 * per matching partner source; default to the most-recently-
 * synced source.
 *
 * The "Check now" button re-fetches the projection AND audits
 * the read as `partner.verification.checked`. Page-load reads
 * never audit.
 */
export function PartnerDataCard({ leadId }: { leadId: string }): JSX.Element | null {
  const t = useTranslations('admin.partnerData');
  const tStatus = useTranslations('admin.partnerData.status');
  const tWarn = useTranslations('admin.partnerData.warnings');

  const canRead = hasCapability('partner.verification.read');

  const [data, setData] = useState<PartnerVerificationResult | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [featureDisabled, setFeatureDisabled] = useState<boolean>(false);
  const [activeSourceId, setActiveSourceId] = useState<string | null>(null);
  const [checking, setChecking] = useState<boolean>(false);

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
        // Default tab: source with the most-recent successful sync;
        // if none, the first source.
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
    // The reload identity changes when activeSourceId flips, but
    // we don't want a re-fetch on every tab click — we already
    // have the data for every source in `data.projections`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadId, canRead]);

  const active = useMemo(
    () =>
      data?.projections.find((p) => p.partnerSourceId === activeSourceId) ??
      data?.projections[0] ??
      null,
    [data, activeSourceId],
  );

  // Hide the card entirely when the user lacks the capability —
  // sales agents in D4.4 shouldn't even see the section header.
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
          {/* Multi-source tabs (only when > 1 active source) */}
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
              phone={data.phone}
            />
          ) : null}
        </>
      )}
    </section>
  );
}

function SourcePanel({
  projection,
  t,
  tStatus,
  tWarn,
  phone,
}: {
  projection: PartnerVerificationProjection;
  t: ReturnType<typeof useTranslations>;
  tStatus: ReturnType<typeof useTranslations>;
  tWarn: ReturnType<typeof useTranslations>;
  phone: string | null;
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

      {/* Phone reminder line — neutral; the join key */}
      {phone ? (
        <p className="inline-flex items-center gap-1 text-xs text-ink-tertiary">
          <Phone className="h-3 w-3" aria-hidden="true" />
          <span className="font-mono">{phone}</span>
        </p>
      ) : null}

      {/* Field grid — only when found */}
      {found ? (
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={t('fields.partnerStatus')} value={projection.partnerStatus} />
          <Field
            label={t('fields.partnerActiveDate')}
            value={
              projection.partnerActiveDate
                ? new Date(projection.partnerActiveDate).toLocaleDateString()
                : null
            }
          />
          <Field
            label={t('fields.partnerDftDate')}
            value={
              projection.partnerDftDate
                ? new Date(projection.partnerDftDate).toLocaleDateString()
                : null
            }
          />
          <Field label={t('fields.tripCount')} value={projection.tripCount?.toString() ?? null} />
          <Field
            label={t('fields.lastTripAt')}
            value={projection.lastTripAt ? new Date(projection.lastTripAt).toLocaleString() : null}
          />
        </dl>
      ) : (
        <p className="text-sm text-ink-tertiary">{t('notFoundBody')}</p>
      )}

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

function Field({ label, value }: { label: string; value: string | null }): JSX.Element {
  return (
    <div className="flex flex-col">
      <dt className="text-[11px] uppercase tracking-wide text-ink-tertiary">{label}</dt>
      <dd className="text-sm text-ink-primary">
        {value ?? <span className="text-ink-tertiary">—</span>}
      </dd>
    </div>
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
