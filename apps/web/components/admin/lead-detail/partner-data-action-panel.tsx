'use client';

import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { PartnerDataCard } from './partner-data-card';
import type { Lead } from '@/lib/api-types';

/**
 * Sprint 2.F — Partner Data action panel (UI scaffold).
 *
 * Reuses the existing `PartnerDataCard` from Sprint D4.4 so any
 * partner data already configured (mappings, last sync, match
 * state) renders immediately. The Sprint 2.F write paths
 * (apply / link / review-as-mismatch) are NOT yet exposed by the
 * API — see the explicit gap below.
 *
 * Backend gap (logged here for the eventual implementer):
 *
 *   • Today's `partnerVerificationApi` (D4.4) exposes a read-only
 *     projection: matched / not matched / mismatch list. There is
 *     no `POST /leads/:id/partner-data/apply`,
 *     `POST /leads/:id/partner-data/link`, or
 *     `POST /leads/:id/partner-data/review` endpoint.
 *   • The Sprint 2 / Sprint 4 spec requires:
 *       - Apply imported partner record → CRM with optional
 *         preview + (per-rule) approval before write.
 *       - Link a partner record to a different contact (one
 *         contact, many partner journeys).
 *       - Mark a mismatch as "needs review" → opens a review row
 *         that appears in Returned to Me / Sprint 5 dashboards.
 *   • Sprint 4 owns the per-partner journey matrix
 *     (Uber EG / inDrive EG / DiDi EG / Careem / Yango) — the
 *     write paths above feed that view.
 *   • Capability gates to add: `partner.data.apply`,
 *     `partner.data.link`, `partner.data.review`.
 *
 * Sprint discipline: show the existing read-only projection so
 * the agent has full visibility, but do not surface write CTAs
 * that would silently disappear. The placeholder Notice names
 * the missing endpoints so the operator knows where the limit
 * sits today.
 */

interface PartnerDataActionPanelProps {
  lead: Lead;
  onClose: () => void;
}

export function PartnerDataActionPanel({
  lead,
  onClose,
}: PartnerDataActionPanelProps): JSX.Element {
  const t = useTranslations('admin.leads.detail.addAction.areas.partnerData');
  const tCommon = useTranslations('admin.common');

  return (
    <div className="flex flex-col gap-4">
      <Notice tone="info">
        <p className="text-sm font-medium">{t('gapTitle')}</p>
        <p className="mt-1 text-xs text-ink-secondary">{t('gapDescription')}</p>
      </Notice>

      {/* Existing D4.4 projection — renders null for callers
          without `partner.verification.read` so sales agents see
          nothing, TLs / Ops / Account Manager / Super Admin see
          the matched/mismatch surface. */}
      <PartnerDataCard leadId={lead.id} />

      <div className="flex items-center justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          {tCommon('close')}
        </Button>
      </div>
    </div>
  );
}
