'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowRightLeft, Clock } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { RedactedFieldBadge } from '@/components/ui/redacted-field-badge';
import { ApiError, leadsApi } from '@/lib/api';
import type { RotationHistoryResponse } from '@/lib/api-types';
import { cn } from '@/lib/utils';

/**
 * Phase D3 — D3.4: rotation history card.
 *
 * Visibility:
 *   The server gates `fromUser` / `toUser` / `actor` / `notes` for
 *   callers without `lead.write` (D2.6 pattern). The response carries
 *   a `canSeeOwners` flag so the UI never has to second-guess null
 *   vs hidden — when `canSeeOwners === false`, every row renders
 *   neutral copy ("Rotated to you", "Handled previously") and the
 *   card hides the per-user lines entirely.
 *
 * For sales / activation / driving agents, the card collapses to a
 * single neutral chip when there's any rotation history at all —
 * just enough signal to say "this lead has been moved before"
 * without leaking owner identity. TL+ see the full from→to chain.
 *
 * Renders nothing when the history is empty (matches the
 * AttemptsHistoryCard "stay quiet on first-attempt" pattern from
 * D2.5).
 */
export function RotationHistoryCard({ leadId }: { leadId: string }): JSX.Element | null {
  const t = useTranslations('admin.leads.detail.rotate');
  const [data, setData] = useState<RotationHistoryResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    leadsApi
      .getRotations(leadId)
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

  if (loading || error || !data) return null;
  if (data.rotations.length === 0) return null;

  const canSee = data.canSeeOwners;
  return (
    <section
      className={cn(
        'flex flex-col gap-2 rounded-lg border bg-surface-card p-3 shadow-sm',
        canSee ? 'border-surface-border' : 'border-status-warning/30 bg-status-warning/5',
      )}
    >
      <header className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-tertiary">
        <ArrowRightLeft className="h-3.5 w-3.5" aria-hidden="true" />
        {t('historyTitle')}
      </header>

      {!canSee ? (
        // Phase D5 — D5.7 / D5.9: collapsed view when fromUser /
        // toUser / actor are server-redacted. Show the existing
        // count-based chip plus the standard RedactedFieldBadge so
        // the user gets consistent copy across every "hidden by
        // your role" surface.
        <div className="flex flex-col gap-1">
          <p className="text-xs italic text-ink-secondary">
            {t('historyRedacted', { count: data.rotations.length })}
          </p>
          <RedactedFieldBadge resource="rotation" field="fromUser" />
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {data.rotations.map((r) => (
            <li
              key={r.id}
              className="flex flex-col gap-1 rounded-md border border-surface-border bg-surface px-3 py-2"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="inline-flex items-center gap-2">
                  <Badge tone="info">{t(`mode.${r.handoverMode}` as 'mode.full')}</Badge>
                  <Badge tone="neutral">
                    {t(`trigger.${r.trigger}` as 'trigger.manual_tl', {
                      defaultValue: r.trigger,
                    })}
                  </Badge>
                </div>
                <span className="inline-flex items-center gap-1 text-[11px] text-ink-tertiary">
                  <Clock className="h-3 w-3" aria-hidden="true" />
                  {new Date(r.createdAt).toLocaleString()}
                </span>
              </div>
              <p className="text-[12px] text-ink-secondary">
                {r.fromUser ? (
                  <>
                    {t('fromTo', {
                      from: r.fromUser.name,
                      to: r.toUser?.name ?? t('targetAuto'),
                    })}
                  </>
                ) : (
                  t('toOnly', { to: r.toUser?.name ?? t('targetAuto') })
                )}
              </p>
              {r.actor ? (
                <p className="text-[11px] text-ink-tertiary">
                  {t('actorLine', { actor: r.actor.name })}
                </p>
              ) : null}
              {r.reasonCode ? (
                <p className="text-[11px] text-ink-tertiary">
                  {t('reasonLine', { reason: r.reasonCode })}
                </p>
              ) : null}
              {r.notes ? <p className="text-[12px] text-ink-secondary">{r.notes}</p> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
