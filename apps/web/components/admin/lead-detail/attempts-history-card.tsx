'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations, useLocale } from 'next-intl';
import { Clock, ExternalLink, EyeOff, Repeat2, ShieldCheck, UserCircle2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { RedactedFieldBadge } from '@/components/ui/redacted-field-badge';
import { ApiError, leadsApi } from '@/lib/api';
import type { AttemptHistoryResult, AttemptHistoryRow } from '@/lib/api-types';
import { cn } from '@/lib/utils';

/**
 * Phase D2 — D2.5: Attempts History card for lead detail.
 *
 * UX rules:
 *   - First-attempt rows (totalAttempts === 1) → render nothing.
 *     A "Attempt 1 of 1" header would be visual noise; the lead
 *     detail already conveys everything an agent needs.
 *   - Multi-attempt rows render a prominent header "Attempt N of M",
 *     a plain-language explanation, the current-attempt chip on
 *     this row, and a compact timeline of every visible predecessor
 *     (newest first).
 *   - Out-of-scope predecessors are NOT leaked: the response carries
 *     `outOfScopeCount`; we surface it as a single italic line
 *     "{N} previous attempts are outside your access." instead of
 *     placeholder rows.
 *   - Reactivation rule codes ('reactivate_lost_aged_out', …) are
 *     translated to operational labels, never shown raw.
 */
export function AttemptsHistoryCard({ leadId }: { leadId: string }): JSX.Element | null {
  const t = useTranslations('admin.leads.detail.attempts');
  const tCommon = useTranslations('common');
  const locale = useLocale();
  const [data, setData] = useState<AttemptHistoryResult | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    leadsApi
      .attempts(leadId)
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
  }, [leadId, t]);

  if (loading) {
    return (
      <section className="rounded-lg border border-surface-border bg-surface-card p-3 shadow-sm">
        <p className="text-xs text-ink-tertiary">{t('loading')}</p>
      </section>
    );
  }

  if (error) {
    return (
      <section className="rounded-lg border border-surface-border bg-surface-card p-3 shadow-sm">
        <p className="text-xs text-status-breach">{error}</p>
      </section>
    );
  }

  if (!data || data.totalAttempts <= 1) {
    // First-attempt: stay quiet. Nothing to surface.
    return null;
  }

  const current = data.attempts.find((a) => a.id === data.currentLeadId);
  const currentIndex = current?.attemptIndex ?? 1;

  return (
    <section
      id="attempts"
      className="flex flex-col gap-3 scroll-mt-20 rounded-lg border border-status-warning/30 bg-status-warning/5 p-3 shadow-sm"
    >
      <header className="flex items-center justify-between gap-2">
        <h3 className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-tertiary">
          <Repeat2 className="h-3.5 w-3.5" aria-hidden="true" />
          {t('title')}
        </h3>
        <Badge tone="warning">
          {t('attemptN', { n: currentIndex, total: data.totalAttempts })}
        </Badge>
      </header>

      <p className="text-xs text-ink-secondary">{t('explainBody')}</p>

      <ul className="flex flex-col gap-2">
        {data.attempts.map((attempt) => (
          <AttemptRow
            key={attempt.id}
            attempt={attempt}
            isCurrent={attempt.id === data.currentLeadId}
            locale={locale}
          />
        ))}
      </ul>

      {data.outOfScopeCount === null ? (
        // Phase D5 — D5.8: the role's `lead.outOfScopeAttemptCount`
        // is denied. Don't disclose whether out-of-scope attempts
        // exist; render the generic "older attempts may be hidden"
        // hint so the UI is honest without leaking the count.
        <div className="flex items-start gap-2 rounded-md border border-surface-border bg-surface px-3 py-2 text-[11px] italic text-ink-tertiary">
          <EyeOff className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
          <span>{tCommon('olderAttemptsHidden')}</span>
        </div>
      ) : data.outOfScopeCount > 0 ? (
        <div className="flex items-start gap-2 rounded-md border border-surface-border bg-surface px-3 py-2 text-[11px] italic text-ink-tertiary">
          <EyeOff className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
          <span>{t('outOfScope', { n: data.outOfScopeCount })}</span>
        </div>
      ) : null}
    </section>
  );
}

function AttemptRow({
  attempt,
  isCurrent,
  locale,
}: {
  attempt: AttemptHistoryRow;
  isCurrent: boolean;
  locale: string;
}): JSX.Element {
  const t = useTranslations('admin.leads.detail.attempts');

  const lostLabel = attempt.lostReason
    ? locale === 'ar'
      ? attempt.lostReason.labelAr
      : attempt.lostReason.labelEn
    : null;

  // Phase D2 — D2.6: when the API redacted assignedTo on a predecessor
  // (sales agent without `lead.assign`), show the neutral "Handled
  // previously" line instead of the assignee name. The current row
  // keeps the real owner so the agent can always see their own
  // assignment.
  const ownerHidden = !isCurrent && !attempt.assignedTo;

  return (
    <li
      className={cn(
        'flex flex-col gap-1.5 rounded-md border bg-surface-card px-3 py-2',
        isCurrent ? 'border-brand-600' : 'border-surface-border',
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex items-center gap-2">
          <span className="text-sm font-medium text-ink-primary">
            {t('attemptLabel', { n: attempt.attemptIndex })}
          </span>
          {isCurrent ? (
            <Badge tone="info">
              <ShieldCheck className="me-1 inline h-3 w-3" aria-hidden="true" />
              {t('currentBadge')}
            </Badge>
          ) : null}
          {attempt.stage ? <Badge tone="neutral">{attempt.stage.name}</Badge> : null}
          <Badge tone={lifecycleTone(attempt.lifecycleState)}>
            {t(`lifecycle.${attempt.lifecycleState}` as 'lifecycle.open')}
          </Badge>
        </div>
        <span className="inline-flex items-center gap-1 text-[11px] text-ink-tertiary">
          <Clock className="h-3 w-3" aria-hidden="true" />
          {formatDate(attempt.createdAt)}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-secondary">
        {attempt.assignedTo ? (
          <span className="inline-flex items-center gap-1">
            <UserCircle2 className="h-3 w-3 text-ink-tertiary" aria-hidden="true" />
            {attempt.assignedTo.name}
          </span>
        ) : ownerHidden ? (
          // Phase D5 — D5.7: predecessor owner stripped server-side
          // by the field-permission gate on `lead.previousOwner`.
          // Use the reusable RedactedFieldBadge so the copy stays
          // consistent across every "hidden by your role" surface.
          <RedactedFieldBadge resource="lead" field="previousOwner" />
        ) : (
          <span className="italic text-ink-tertiary">{t('unassigned')}</span>
        )}
        {lostLabel ? (
          <span className="text-status-breach">{t('lostReasonLine', { reason: lostLabel })}</span>
        ) : null}
        {attempt.source ? (
          <span className="text-ink-tertiary">{t('sourceLine', { source: attempt.source })}</span>
        ) : null}
      </div>

      {attempt.reactivationRule ? (
        <div className="inline-flex items-center gap-1 text-[11px] text-status-warning">
          <Repeat2 className="h-3 w-3" aria-hidden="true" />
          <span>{translateReactivationRule(t, attempt.reactivationRule)}</span>
        </div>
      ) : null}

      {!isCurrent ? (
        <Link
          href={`/admin/leads/${attempt.id}`}
          className="inline-flex w-fit items-center gap-1 text-[11px] text-ink-secondary hover:text-brand-700"
        >
          <ExternalLink className="h-3 w-3" aria-hidden="true" />
          {t('openCta')}
        </Link>
      ) : null}
    </li>
  );
}

function lifecycleTone(state: string): 'healthy' | 'breach' | 'inactive' | 'info' {
  if (state === 'won') return 'healthy';
  if (state === 'lost') return 'breach';
  if (state === 'archived') return 'inactive';
  return 'info';
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
    });
  } catch {
    return iso;
  }
}

/** Map the engine's stable rule codes to operational labels. The
 *  codes themselves never reach the operator. Unknown codes render
 *  as `t('rule.unknown')` so a future engine extension doesn't show
 *  raw text by accident. */
function translateReactivationRule(
  t: ReturnType<typeof useTranslations>,
  ruleCode: string,
): string {
  switch (ruleCode) {
    case 'reactivate_lost_aged_out':
      return t('rule.reactivate_lost_aged_out');
    case 'reactivate_no_answer_aged_out':
      return t('rule.reactivate_no_answer_aged_out');
    case 'manual_override':
      return t('rule.manual_override');
    case 'route_to_review_active_captain':
    case 'route_to_review_won':
    case 'route_to_review_open_lead':
    case 'route_to_review_cooldown':
    case 'route_to_review_low_confidence':
    case 'route_to_review_cross_pipeline':
      return t('rule.sent_to_review');
    default:
      return t('rule.unknown');
  }
}
