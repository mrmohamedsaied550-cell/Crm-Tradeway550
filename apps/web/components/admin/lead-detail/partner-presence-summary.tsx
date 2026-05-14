'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, CheckCircle2, Network, ShieldQuestion } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { ApiError, partnerVerificationApi } from '@/lib/api';
import type {
  PartnerVerificationProjection,
  PartnerVerificationResult,
  PartnerVerificationStatus,
} from '@/lib/api-types';

/**
 * Sprint 4 (D8.A) — Partner Presence compact summary.
 *
 * Lives on Lead Detail above the tabs (Stage Context area). One
 * row per partner the lead has data for, capped at 4 chips with a
 * "+ N more" pill when there are more sources. Two roll-up counts
 * sit on the right:
 *
 *   • Matched in N partners
 *   • Mismatch in M partners
 *
 * Data source: the existing D4.4
 * `partnerVerificationApi.forLead(leadId)` projection. NO new
 * backend endpoint. Self-gates to render nothing when the caller
 * lacks `partner.verification.read` (the controller returns 403
 * which we treat as "no data to show" — same behaviour as the
 * existing PartnerDataCard).
 *
 * Empty states:
 *   • Endpoint returns 0 projections → "No partner data matched
 *     yet" hint.
 *   • Caller lacks the capability → component renders null (no
 *     leak of "this lead has partner data but you can't see it").
 *   • Network error → silent null (the page already has a real
 *     PartnerDataCard inside the Partner Presence tab; the
 *     summary is a "nice to have" header surface and never
 *     blocks the rest of the page).
 *
 * Why a separate component from PartnerDataCard:
 *   - The card lives inside the Partner Presence tab and renders
 *     rich merge / evidence / status panels. The summary is
 *     compact, always visible, header-area context.
 *   - Both consume the same fetch + permission gate; the summary
 *     intentionally returns null on error so it never competes
 *     with the card's own error UI.
 */
interface PartnerPresenceSummaryProps {
  leadId: string;
  /** Bumped after writes — same convention as the other cards. */
  refreshKey?: string | number;
}

const MAX_VISIBLE_CHIPS = 4;

type Tone = 'healthy' | 'warning' | 'breach' | 'info' | 'neutral';

/**
 * Maps the API's verification status to a tone for the partner
 * chip. Centralised here + reused by `PartnerPresenceTable` so
 * the colour rules stay consistent between the summary and the
 * detailed tab.
 */
export function toneForVerification(status: PartnerVerificationStatus): Tone {
  if (status === 'matched') return 'healthy';
  if (status === 'not_found') return 'neutral';
  return 'warning';
}

export function PartnerPresenceSummary({
  leadId,
  refreshKey,
}: PartnerPresenceSummaryProps): JSX.Element | null {
  const t = useTranslations('admin.leads.detail.partnerPresence');
  const tStatus = useTranslations('admin.partnerData.status');

  const [data, setData] = useState<PartnerVerificationResult | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    partnerVerificationApi
      .forLead(leadId)
      .then((resp) => {
        if (cancelled) return;
        setData(resp);
      })
      .catch((err: unknown) => {
        // Capability denied / network blip — treat as "no data".
        // The PartnerDataCard inside the tab will surface a real
        // error if the same fetch fails there.
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 403) {
          // Hard-deny: stay null so we don't leak "this lead has
          // partner data".
          setData(null);
          return;
        }
        setData(null);
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [leadId, refreshKey]);

  if (loading) return null;
  if (!data) return null;

  const projections = data.projections ?? [];
  if (projections.length === 0) {
    // Show the empty-state hint inline so the agent knows the
    // section exists but has no partner records yet. Renders the
    // same chrome as the populated case for visual stability.
    return (
      <section
        aria-labelledby="partner-presence-summary-heading"
        className="rounded-lg border border-surface-border bg-surface-card p-4 shadow-card"
      >
        <header className="mb-2 flex items-center gap-2">
          <Network className="h-4 w-4 text-ink-tertiary" aria-hidden="true" />
          <h3
            id="partner-presence-summary-heading"
            className="text-xs font-semibold uppercase tracking-wide text-ink-tertiary"
          >
            {t('summaryHeading')}
          </h3>
        </header>
        <p className="text-sm text-ink-tertiary">{t('summaryEmpty')}</p>
      </section>
    );
  }

  const matchedCount = projections.filter((p) => p.verificationStatus === 'matched').length;
  const mismatchCount = projections.filter(
    (p) => p.verificationStatus !== 'matched' && p.verificationStatus !== 'not_found',
  ).length;
  const visible = projections.slice(0, MAX_VISIBLE_CHIPS);
  const overflow = projections.length - visible.length;

  return (
    <section
      aria-labelledby="partner-presence-summary-heading"
      className="rounded-lg border border-surface-border bg-surface-card p-4 shadow-card"
    >
      <header className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Network className="h-4 w-4 text-ink-tertiary" aria-hidden="true" />
          <h3
            id="partner-presence-summary-heading"
            className="text-xs font-semibold uppercase tracking-wide text-ink-tertiary"
          >
            {t('summaryHeading')}
          </h3>
        </div>
        <div className="flex items-center gap-3 text-xs text-ink-secondary">
          <span className="inline-flex items-center gap-1">
            <CheckCircle2 className="h-3.5 w-3.5 text-status-healthy" aria-hidden="true" />
            {t('summaryMatched', { n: matchedCount })}
          </span>
          {mismatchCount > 0 ? (
            <span className="inline-flex items-center gap-1">
              <AlertTriangle className="h-3.5 w-3.5 text-status-warning" aria-hidden="true" />
              {t('summaryMismatch', { n: mismatchCount })}
            </span>
          ) : null}
        </div>
      </header>

      <ul className="flex flex-wrap items-center gap-2" aria-label={t('summaryChipListLabel')}>
        {visible.map((p) => (
          <li key={p.partnerSourceId}>
            <PartnerChip projection={p} tStatus={tStatus} />
          </li>
        ))}
        {overflow > 0 ? (
          <li>
            <Badge tone="neutral">{t('summaryOverflow', { n: overflow })}</Badge>
          </li>
        ) : null}
      </ul>
    </section>
  );
}

/** Single partner chip — partner name + verification icon + partner status text. */
function PartnerChip({
  projection,
  tStatus,
}: {
  projection: PartnerVerificationProjection;
  tStatus: ReturnType<typeof useTranslations>;
}): JSX.Element {
  const tone = toneForVerification(projection.verificationStatus);
  const Icon =
    projection.verificationStatus === 'matched'
      ? CheckCircle2
      : projection.verificationStatus === 'not_found'
        ? ShieldQuestion
        : AlertTriangle;
  return (
    <Badge tone={tone}>
      <Icon className="me-1 h-3 w-3" aria-hidden="true" />
      <span className="font-medium">{projection.partnerSourceName}</span>
      {projection.partnerStatus ? (
        <span className="ms-1 text-[11px] opacity-80">· {projection.partnerStatus}</span>
      ) : (
        <span className="ms-1 text-[11px] opacity-80">
          · {tStatus(projection.verificationStatus as 'matched')}
        </span>
      )}
    </Badge>
  );
}
