'use client';

import { useTranslations } from 'next-intl';
import { CheckCircle2, Circle, FileText, RotateCcw, XCircle } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import type { Lead } from '@/lib/api-types';

/**
 * Sprint 2.E — Documents action panel (UI scaffold).
 *
 * Renders the 5 status states agreed in the Sprint 2 spec
 * (Uploaded / Accepted / Rejected / Missing / Needs Resubmission)
 * as visible read-only chips with empty-state counts of zero. The
 * actual document data is NOT YET MODELLED in the backend — see
 * the explicit gap below.
 *
 * Backend gap (logged here, in one place, for the eventual
 * implementer):
 *
 *   • No `LeadDocument` model in `apps/api/prisma/schema.prisma`.
 *   • No `documents` array on the Lead GET response.
 *   • No upload endpoint (would need an object-storage provider
 *     wired through the API — S3 / GCS / blob storage).
 *   • No status-update endpoint (would need
 *     POST /leads/:id/documents/:docId/status with
 *     `{status: 'uploaded' | 'accepted' | 'rejected' | 'missing'
 *     | 'needs_resubmission'}` + reason capture when rejected /
 *     needs-resubmission).
 *   • Capability gates to add: `lead.document.read`,
 *     `lead.document.write`, `lead.document.accept`,
 *     `lead.document.reject`.
 *
 * Sprint discipline: render the agreed UI shape so the agent
 * sees the slot, but do NOT fake writes that would silently
 * disappear. The CTA buttons are disabled with an explicit
 * "coming soon" tooltip text.
 */

interface DocumentsActionPanelProps {
  /** Prop kept so the panel can light up automatically when the
   *  backend model lands — no caller change required at that
   *  point. */
  lead: Lead;
  onClose: () => void;
}

interface StatusRow {
  id: 'uploaded' | 'accepted' | 'rejected' | 'missing' | 'needs_resubmission';
  icon: typeof CheckCircle2;
  toneClass: string;
}

const ROWS: ReadonlyArray<StatusRow> = [
  { id: 'uploaded', icon: FileText, toneClass: 'text-status-info' },
  { id: 'accepted', icon: CheckCircle2, toneClass: 'text-status-healthy' },
  { id: 'rejected', icon: XCircle, toneClass: 'text-status-breach' },
  { id: 'missing', icon: Circle, toneClass: 'text-ink-tertiary' },
  { id: 'needs_resubmission', icon: RotateCcw, toneClass: 'text-status-warning' },
];

export function DocumentsActionPanel({
  lead: _lead,
  onClose,
}: DocumentsActionPanelProps): JSX.Element {
  const t = useTranslations('admin.leads.detail.addAction.areas.documents');
  const tCommon = useTranslations('admin.common');

  return (
    <div className="flex flex-col gap-4">
      <Notice tone="info">
        <p className="text-sm font-medium">{t('gapTitle')}</p>
        <p className="mt-1 text-xs text-ink-secondary">{t('gapDescription')}</p>
      </Notice>

      <section className="rounded-lg border border-surface-border bg-surface-card p-3">
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-tertiary">
          {t('statusBreakdown')}
        </h3>
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-5">
          {ROWS.map((row) => {
            const Icon = row.icon;
            return (
              <li
                key={row.id}
                className="flex flex-col items-center gap-1 rounded-md border border-surface-border bg-surface p-3 text-center"
              >
                <Icon className={`h-5 w-5 ${row.toneClass}`} aria-hidden="true" />
                <p className="text-[11px] font-medium uppercase tracking-wide text-ink-secondary">
                  {t(`states.${row.id}`)}
                </p>
                <p className="text-lg font-semibold text-ink-primary">0</p>
              </li>
            );
          })}
        </ul>
      </section>

      <div className="flex items-center justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          {tCommon('close')}
        </Button>
      </div>
    </div>
  );
}
