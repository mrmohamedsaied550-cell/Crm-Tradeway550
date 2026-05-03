import { useTranslations } from 'next-intl';
import { Badge } from './badge';
import type { LeadLifecycleState } from '@/lib/api-types';

/**
 * Phase A — A6: lifecycle classifier badge.
 *
 * Renders one of {Open, Won, Lost, Archived} with a tone matching
 * the `Badge` primitive's existing palette so the lead detail
 * header / list / Kanban card stay visually consistent.
 *
 * The badge does not surface lostReason text — the lead detail
 * page renders that separately when relevant. Keeping the badge
 * intentionally narrow means it can sit anywhere a stage badge
 * sits without growing horizontally.
 */
export function LifecycleBadge({
  state,
  className,
}: {
  state: LeadLifecycleState;
  className?: string;
}): JSX.Element {
  const t = useTranslations('admin.leads.lifecycle');
  const tone = toneFor(state);
  return (
    <Badge tone={tone} className={className}>
      {t(state)}
    </Badge>
  );
}

function toneFor(
  state: LeadLifecycleState,
): 'healthy' | 'breach' | 'inactive' | 'info' | 'neutral' {
  switch (state) {
    case 'won':
      return 'healthy';
    case 'lost':
      return 'breach';
    case 'archived':
      return 'inactive';
    case 'open':
    default:
      return 'info';
  }
}
