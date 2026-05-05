'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Repeat2 } from 'lucide-react';

import { ApiError, leadsApi } from '@/lib/api';

/**
 * Phase D2 — D2.5: lightweight "N attempts on this contact" line
 * for the WhatsApp side panel.
 *
 * Renders nothing for first-attempt contacts (totalAttempts <= 1).
 * Fetch is deferred until the panel mounts; failures and
 * out-of-scope contacts silently render nothing — this is a
 * supplementary hint, not a critical surface, and we don't want
 * a flaky network call to clutter the side panel with errors.
 *
 * Linked to /admin/leads/:id so the operator can deep-link into the
 * full Attempts History card (D2.5 lead detail).
 */
export function ContactAttemptsHint({ leadId }: { leadId: string }): JSX.Element | null {
  const t = useTranslations('admin.whatsapp.sidePanel.attempts');
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    leadsApi
      .attempts(leadId)
      .then((row) => {
        if (cancelled) return;
        setCount(row.totalAttempts);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // Silent — see comment above. ApiError instance is preserved
        // for future debugging via the dev-tools network panel.
        if (!(err instanceof ApiError)) return;
      });
    return () => {
      cancelled = true;
    };
  }, [leadId]);

  if (count === null || count <= 1) return null;

  return (
    <Link
      href={`/admin/leads/${leadId}#attempts`}
      className="inline-flex items-center gap-1.5 self-start rounded-md border border-status-warning/40 bg-status-warning/10 px-2 py-1 text-[11px] font-medium text-status-warning hover:border-status-warning/60"
    >
      <Repeat2 className="h-3 w-3" aria-hidden="true" />
      {t('count', { n: count })}
    </Link>
  );
}
