import { useTranslations } from 'next-intl';
import { Repeat2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';

/**
 * Phase D2 — D2.5: small "Attempt N" badge surfaced on lead-list
 * rows when `attemptIndex > 1`. First-attempt rows render nothing
 * to keep the list quiet. Operationally signals "this is a returning
 * lead" so a TL skimming the list spots problem-cohort phones at a
 * glance.
 */
export function AttemptBadge({ attemptIndex }: { attemptIndex: number }): JSX.Element | null {
  const t = useTranslations('admin.leads.detail.attempts');
  if (!attemptIndex || attemptIndex < 2) return null;
  return (
    <Badge tone="warning">
      <Repeat2 className="me-1 inline h-3 w-3" aria-hidden="true" />
      {t('badge', { n: attemptIndex })}
    </Badge>
  );
}
