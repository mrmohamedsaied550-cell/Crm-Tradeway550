'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ExternalLink, Phone, ShieldCheck } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { ApiError, captainsApi } from '@/lib/api';
import type { Captain } from '@/lib/api-types';

/**
 * D1.5 — candidate-captain mini-card used inside ReviewCard.
 *
 * For `reason='captain_active'` reviews: displays the existing
 * captain's identity so the operator can confirm "yes, this phone
 * really does belong to that captain" before resolving with
 * `linked_to_captain`. Read-only — there is no "select this
 * captain" radio; the resolution is a single-button confirm flow.
 */
export function ReviewCandidateCaptain({ captainId }: { captainId: string }): JSX.Element {
  const t = useTranslations('admin.whatsappReviews.candidate.captain');
  const [captain, setCaptain] = useState<Captain | null>(null);
  const [error, setError] = useState<'out_of_scope' | 'failed' | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    captainsApi
      .get(captainId)
      .then((row) => {
        if (cancelled) return;
        setCaptain(row);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) {
          setError('out_of_scope');
        } else {
          setError('failed');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [captainId]);

  return (
    <div className="flex flex-col gap-1 rounded-md border border-status-warning/30 bg-status-warning/5 px-3 py-2">
      {loading ? (
        <p className="text-xs text-ink-tertiary">{t('loading')}</p>
      ) : error === 'out_of_scope' ? (
        <p className="text-xs italic text-ink-tertiary">{t('outOfScope')}</p>
      ) : error === 'failed' ? (
        <p className="text-xs text-status-breach">{t('loadFailed')}</p>
      ) : captain ? (
        <>
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 truncate text-sm font-medium text-ink-primary">
              <ShieldCheck className="h-3.5 w-3.5 text-status-warning" aria-hidden="true" />
              {captain.name}
            </span>
            <Link
              href={`/admin/captains/${captain.id}`}
              className="inline-flex items-center gap-1 text-[11px] text-ink-secondary hover:text-brand-700"
            >
              <ExternalLink className="h-3 w-3" aria-hidden="true" />
              {t('openCta')}
            </Link>
          </div>
          <span className="inline-flex items-center gap-1 font-mono text-[11px] text-ink-tertiary">
            <Phone className="h-3 w-3" aria-hidden="true" />
            {captain.phone}
          </span>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={captainStatusTone(captain.status)}>
              {t(`status.${captain.status}` as 'status.active')}
            </Badge>
            {typeof captain.tripCount === 'number' ? (
              <span className="text-[11px] text-ink-tertiary">
                {t('tripCount', { count: captain.tripCount })}
              </span>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}

function captainStatusTone(status: string): 'healthy' | 'inactive' | 'breach' {
  if (status === 'active') return 'healthy';
  if (status === 'archived') return 'breach';
  return 'inactive';
}
