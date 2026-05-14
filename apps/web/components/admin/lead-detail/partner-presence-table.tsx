'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, CheckCircle2, Network, Plus, ShieldQuestion } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Notice } from '@/components/ui/notice';
import { ApiError, partnerVerificationApi } from '@/lib/api';
import type { PartnerVerificationProjection, PartnerVerificationResult } from '@/lib/api-types';

import { toneForVerification } from './partner-presence-summary';

/**
 * Sprint 4 (D8.B) — Partner Presence detailed table for the
 * Partner Presence tab on Lead Detail.
 *
 * Replaces the Sprint 2.A scaffold (which just rendered the
 * existing PartnerDataCard with a "Sprint 4 will expand this"
 * note) with a proper per-partner row table:
 *
 *   Partner | Partner status | Verification | Last sync | Warnings
 *
 * Columns map to existing D4.4 `PartnerVerificationProjection`
 * fields:
 *   - Partner name + code (avatar uses initials; configurable
 *     logos land later via Branding & Asset Settings — flagged
 *     here as a data gap).
 *   - Partner imported status (free string from the partner sheet
 *     / integration).
 *   - Verification chip (Matched / No Match / Mismatch family) +
 *     icon, reusing the same tone resolver as the summary.
 *   - Last sync timestamp (lastSyncAt — relative via Intl).
 *   - Warnings list (e.g. "date_mismatch", "trips_mismatch") —
 *     stringified from the projection's `warnings` array.
 *
 * Below the table sits the "Add Partner Target" CTA — a clearly
 * disabled button with an explicit backend gap notice, per Sprint
 * 4 spec ("If backend is not ready: Show disabled/placeholder
 * state with exact backend gap. Do not fake success.").
 *
 * Multi-partner same-phone surfacing: the projection list already
 * IS one-to-many (one Lead = many PartnerVerificationProjection
 * entries), so the table inherently surfaces the "one person,
 * many partners" model the Sprint 4 spec asks for.
 *
 * Permissions: self-gates on the API endpoint's existing
 * `partner.verification.read` guard — a 403 from the endpoint
 * means the agent doesn't have permission, and the table renders
 * a no-access notice (no leak of "data exists but you can't see
 * it").
 */
interface PartnerPresenceTableProps {
  leadId: string;
  refreshKey?: string | number;
}

export function PartnerPresenceTable({
  leadId,
  refreshKey,
}: PartnerPresenceTableProps): JSX.Element {
  const t = useTranslations('admin.leads.detail.partnerPresence');
  const tStatus = useTranslations('admin.partnerData.status');

  const [data, setData] = useState<PartnerVerificationResult | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState<boolean>(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setForbidden(false);
    partnerVerificationApi
      .forLead(leadId)
      .then((resp) => {
        if (cancelled) return;
        setData(resp);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 403) {
          setForbidden(true);
          return;
        }
        setError(err instanceof ApiError ? err.message : String(err));
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [leadId, refreshKey]);

  if (loading) {
    return (
      <section className="rounded-lg border border-surface-border bg-surface-card p-5 shadow-card">
        <p className="text-sm text-ink-tertiary">{t('loading')}</p>
      </section>
    );
  }
  if (forbidden) {
    return (
      <Notice tone="info">
        <p className="text-sm font-medium">{t('noAccess.title')}</p>
        <p className="mt-1 text-xs text-ink-secondary">{t('noAccess.description')}</p>
      </Notice>
    );
  }
  if (error) {
    return <Notice tone="error">{error}</Notice>;
  }
  if (!data) return <></>;

  const projections = data.projections ?? [];

  return (
    <div className="flex flex-col gap-3">
      {projections.length === 0 ? (
        <section className="rounded-lg border border-surface-border bg-surface-card p-5 shadow-card">
          <EmptyState
            icon={<Network className="h-8 w-8" aria-hidden="true" />}
            title={t('tableEmptyTitle')}
            body={t('tableEmptyBody')}
          />
        </section>
      ) : (
        <section className="overflow-hidden rounded-lg border border-surface-border bg-surface-card shadow-card">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-surface-border bg-surface text-xs uppercase tracking-wide text-ink-tertiary">
                  <th className="px-4 py-3 text-start font-semibold">{t('columns.partner')}</th>
                  <th className="px-4 py-3 text-start font-semibold">
                    {t('columns.partnerStatus')}
                  </th>
                  <th className="px-4 py-3 text-start font-semibold">
                    {t('columns.verification')}
                  </th>
                  <th className="px-4 py-3 text-start font-semibold">{t('columns.lastSync')}</th>
                  <th className="px-4 py-3 text-start font-semibold">{t('columns.warnings')}</th>
                </tr>
              </thead>
              <tbody>
                {projections.map((p) => (
                  <PartnerRow key={p.partnerSourceId} projection={p} tStatus={tStatus} />
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ─────── Add Partner Target — Sprint 4.E placeholder ───────
          The spec is explicit: "If backend is not ready: Show
          disabled/placeholder state with exact backend gap. Do
          not fake success." */}
      <section className="rounded-lg border border-dashed border-surface-border bg-surface p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-ink-primary">{t('addTarget.title')}</h3>
            <p className="mt-1 text-xs text-ink-secondary">{t('addTarget.gapDescription')}</p>
          </div>
          <Button variant="secondary" size="sm" disabled>
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            {t('addTarget.action')}
          </Button>
        </div>
      </section>

      {/* ─────── Duplicate / same-phone hint ───────
          When there are 2+ projections, the lead inherently
          carries multiple partner journeys for the same phone
          (the API's `getForLead` already groups them under one
          lead id). Surface this explicitly so the agent sees
          the unified-person model. */}
      {projections.length >= 2 ? (
        <Notice tone="info">
          <p className="text-sm font-medium">{t('sharedPhone.title')}</p>
          <p className="mt-1 text-xs text-ink-secondary">
            {t('sharedPhone.body', { n: projections.length })}
          </p>
        </Notice>
      ) : null}
    </div>
  );
}

function PartnerRow({
  projection,
  tStatus,
}: {
  projection: PartnerVerificationProjection;
  tStatus: ReturnType<typeof useTranslations>;
}): JSX.Element {
  const t = useTranslations('admin.leads.detail.partnerPresence');
  const tone = toneForVerification(projection.verificationStatus);
  const Icon =
    projection.verificationStatus === 'matched'
      ? CheckCircle2
      : projection.verificationStatus === 'not_found'
        ? ShieldQuestion
        : AlertTriangle;
  const initials = projection.partnerSourceName
    .split(/\s+/u)
    .map((part) => part.charAt(0).toUpperCase())
    .slice(0, 2)
    .join('');
  const lastSync = projection.lastSyncAt
    ? new Date(projection.lastSyncAt).toLocaleDateString()
    : t('lastSyncNever');
  return (
    <tr className="border-b border-surface-border last:border-b-0 hover:bg-surface">
      <td className="px-4 py-3 align-top">
        <div className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-brand-50 text-[11px] font-semibold text-brand-700"
          >
            {initials || '–'}
          </span>
          <div className="flex min-w-0 flex-col">
            <span className="truncate font-medium text-ink-primary">
              {projection.partnerSourceName}
            </span>
            <span className="text-[11px] uppercase tracking-wide text-ink-tertiary">
              {projection.partnerCode}
            </span>
          </div>
        </div>
      </td>
      <td className="px-4 py-3 align-top text-ink-primary">
        {projection.partnerStatus ?? <span className="text-ink-tertiary">—</span>}
      </td>
      <td className="px-4 py-3 align-top">
        <Badge tone={tone}>
          <Icon className="me-1 h-3 w-3" aria-hidden="true" />
          {tStatus(projection.verificationStatus as 'matched')}
        </Badge>
      </td>
      <td className="px-4 py-3 align-top text-ink-secondary">{lastSync}</td>
      <td className="px-4 py-3 align-top text-ink-secondary">
        {projection.warnings.length === 0 ? (
          <span className="text-ink-tertiary">—</span>
        ) : (
          <ul className="space-y-1">
            {projection.warnings.map((w) => (
              <li key={w} className="text-xs">
                {w}
              </li>
            ))}
          </ul>
        )}
      </td>
    </tr>
  );
}
