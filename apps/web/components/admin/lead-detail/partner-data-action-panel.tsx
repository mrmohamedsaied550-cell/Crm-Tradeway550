'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { hasCapability } from '@/lib/auth';
import type { Lead } from '@/lib/api-types';

import { AddPartnerTargetModal } from './add-partner-target-modal';
import { PartnerDataCard } from './partner-data-card';

/**
 * Sprint 2.F — Partner Data action panel.
 *
 * Originally a scaffold around the D4.4 read-only PartnerDataCard.
 * Sprint 13 (D13) bolts on the real "Add partner target" CTA so an
 * operator can open the Add Action drawer → Partner Data area and
 * register a new partner target on the same lead without leaving
 * the drawer. The CTA reuses the same `AddPartnerTargetModal` mounted
 * by the Partner Presence panel, so the dedupe contract, validation,
 * and audit/activity wiring are identical.
 *
 * Capability gates (client-side hint only — server is source of truth):
 *   • `partner.target.write` — required to see the CTA.
 *   • `partner.verification.read` — controls whether the D4.4 card
 *     renders any rows; the component itself handles the empty state.
 *
 * Write paths still missing (Sprint 4 scope):
 *   • Apply / link / review-as-mismatch against the imported partner
 *     projection. The gap Notice below names them for the implementer.
 */

interface PartnerDataActionPanelProps {
  lead: Lead;
  onClose: () => void;
  /** Bubble up so the Lead Detail page can refresh the timeline and
   *  Partner Presence panel after a successful target create. */
  onApplied?: () => void;
}

export function PartnerDataActionPanel({
  lead,
  onClose,
  onApplied,
}: PartnerDataActionPanelProps): JSX.Element {
  const t = useTranslations('admin.leads.detail.addAction.areas.partnerData');
  const tTarget = useTranslations('admin.leads.detail.partnerPresence.addTarget');
  const tCommon = useTranslations('admin.common');

  const canWriteTargets = hasCapability('partner.target.write');
  const [addOpen, setAddOpen] = useState<boolean>(false);

  return (
    <div className="flex flex-col gap-4">
      <Notice tone="info">
        <p className="text-sm font-medium">{t('gapTitle')}</p>
        <p className="mt-1 text-xs text-ink-secondary">{t('gapDescription')}</p>
      </Notice>

      {canWriteTargets ? (
        <div className="rounded-md border border-border bg-surface-muted p-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-ink-primary">{tTarget('drawer.title')}</p>
              <p className="mt-1 text-xs text-ink-secondary">{tTarget('drawer.description')}</p>
            </div>
            <Button size="sm" onClick={() => setAddOpen(true)}>
              {tTarget('action')}
            </Button>
          </div>
        </div>
      ) : null}

      {/* Existing D4.4 projection — renders null for callers
          without `partner.verification.read`. */}
      <PartnerDataCard leadId={lead.id} />

      <div className="flex items-center justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          {tCommon('close')}
        </Button>
      </div>

      <AddPartnerTargetModal
        open={addOpen}
        leadId={lead.id}
        onClose={() => setAddOpen(false)}
        onAdded={() => {
          onApplied?.();
        }}
      />
    </div>
  );
}
