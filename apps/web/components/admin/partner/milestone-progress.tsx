'use client';

import { useTranslations } from 'next-intl';
import { CheckCircle2, Flag, Loader2, Trophy, XCircle } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import type { MilestoneProgressProjection } from '@/lib/api-types';
import { cn } from '@/lib/utils';

/**
 * Phase D4 — D4.7: MilestoneProgress chip / inline block.
 *
 * Pure presentation. Reads everything from the projection passed
 * in by `PartnerDataCard`. NEVER triggers writes — milestone data
 * is read-only verification, mirroring the rest of D4.
 *
 * Compact: shows trips / target, milestone ladder, days left,
 * deadline, risk badge, and an optional "Needs push" badge when
 * the operator should act now.
 */
export function MilestoneProgress({
  projection,
}: {
  projection: MilestoneProgressProjection;
}): JSX.Element {
  const t = useTranslations('admin.partnerData.milestone');
  const tRisk = useTranslations('admin.partnerData.milestone.risk');

  if (projection.reason) {
    return (
      <div className="flex flex-col gap-1 rounded-md border border-surface-border bg-surface px-3 py-2 text-xs text-ink-tertiary">
        <span className="inline-flex items-center gap-1 font-medium text-ink-secondary">
          <Flag className="h-3 w-3" aria-hidden="true" />
          {projection.displayName}
        </span>
        <span>{t(`reason.${projection.reason}` as 'reason.no_partner_record')}</span>
      </div>
    );
  }

  const tripCount = projection.tripCount ?? 0;
  const pct = Math.round(projection.progressPct * 100);
  const completed = projection.risk === 'completed';
  const expired = projection.risk === 'expired';

  return (
    <div className="flex flex-col gap-2 rounded-md border border-surface-border bg-surface p-3">
      {/* Header: name + risk badge + needs-push */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex items-center gap-2">
          <Flag className="h-3.5 w-3.5 text-brand-700" aria-hidden="true" />
          <span className="text-sm font-semibold text-ink-primary">{projection.displayName}</span>
          <RiskBadge risk={projection.risk} tRisk={tRisk} />
          {projection.needsPush ? <Badge tone="breach">{t('needsPush')}</Badge> : null}
        </div>
        <span className="text-xs text-ink-tertiary">
          {t('window', { days: projection.windowDays })}
        </span>
      </div>

      {/* Trip count + progress bar */}
      <div className="flex flex-col gap-1">
        <div className="flex items-baseline justify-between gap-2 text-xs text-ink-tertiary">
          <span>
            {t('trips')}: <strong className="text-ink-primary">{tripCount}</strong> /{' '}
            {projection.targetTrips}
          </span>
          <span>
            {projection.daysLeft === null
              ? '—'
              : projection.daysLeft < 0
                ? t('expiredDaysAgo', { days: Math.abs(projection.daysLeft) })
                : t('daysLeft', { days: projection.daysLeft })}
          </span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-surface-card">
          <div
            className={cn(
              'h-full rounded-full transition-all',
              completed
                ? 'bg-status-success'
                : expired
                  ? 'bg-status-breach'
                  : projection.risk === 'high'
                    ? 'bg-status-warning'
                    : 'bg-brand-600',
            )}
            style={{ width: `${Math.min(100, Math.max(2, pct))}%` }}
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
          />
        </div>
      </div>

      {/* Milestone ladder — small chips */}
      {projection.milestoneSteps.length > 0 ? (
        <ul className="flex flex-wrap items-center gap-1">
          {projection.milestoneSteps.map((step) => {
            const reached = tripCount >= step;
            return (
              <li
                key={step}
                className={cn(
                  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium',
                  reached
                    ? 'border-status-success/40 bg-status-success/10 text-status-success'
                    : 'border-surface-border bg-surface-card text-ink-tertiary',
                )}
              >
                {reached ? (
                  <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
                ) : (
                  <Trophy className="h-3 w-3" aria-hidden="true" />
                )}
                {step}
              </li>
            );
          })}
        </ul>
      ) : null}

      {/* Deadline / next-milestone footer */}
      <p className="text-[11px] text-ink-tertiary">
        {projection.windowEndsAt
          ? t('deadline', { date: new Date(projection.windowEndsAt).toLocaleDateString() })
          : null}
        {projection.nextMilestone !== null ? (
          <>
            {projection.windowEndsAt ? ' · ' : ''}
            {t('nextMilestone', { step: projection.nextMilestone })}
          </>
        ) : null}
      </p>
    </div>
  );
}

function RiskBadge({
  risk,
  tRisk,
}: {
  risk: MilestoneProgressProjection['risk'];
  tRisk: ReturnType<typeof useTranslations>;
}): JSX.Element {
  const label = tRisk(risk as 'low');
  if (risk === 'completed') {
    return (
      <Badge tone="info">
        <Trophy className="me-1 h-3 w-3" aria-hidden="true" />
        {label}
      </Badge>
    );
  }
  if (risk === 'expired') {
    return (
      <Badge tone="breach">
        <XCircle className="me-1 h-3 w-3" aria-hidden="true" />
        {label}
      </Badge>
    );
  }
  if (risk === 'high') {
    return <Badge tone="breach">{label}</Badge>;
  }
  if (risk === 'medium') {
    return <Badge tone="warning">{label}</Badge>;
  }
  if (risk === 'low') {
    return <Badge tone="info">{label}</Badge>;
  }
  return (
    <Badge tone="neutral">
      <Loader2 className="me-1 h-3 w-3" aria-hidden="true" />
      {label}
    </Badge>
  );
}
