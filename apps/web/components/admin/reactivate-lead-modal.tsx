'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Repeat2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Notice } from '@/components/ui/notice';

/**
 * Phase D2 — D2.6: manual reactivation modal.
 *
 * Confirms a manual override before the new attempt is created. The
 * checkbox keeps the operator from triggering reactivation by accident
 * — manual override is reserved for management-driven re-engagement
 * and the wording calls that out explicitly. On confirm we hand back
 * to the parent which calls `leadsApi.reactivate(...)` and routes to
 * the new lead.
 *
 * Visibility on the parent page is gated by the `lead.reactivate`
 * capability + a closed-lifecycle precondition; this modal trusts the
 * parent to have made those checks and renders only the confirmation
 * UX.
 */
export function ReactivateLeadModal({
  open,
  leadName,
  submitting,
  error,
  onConfirm,
  onClose,
}: {
  open: boolean;
  leadName: string;
  submitting: boolean;
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
}): JSX.Element {
  const t = useTranslations('admin.leads.detail.reactivate');
  const tCommon = useTranslations('admin.common');
  const [acknowledged, setAcknowledged] = useState<boolean>(false);

  useEffect(() => {
    if (!open) setAcknowledged(false);
  }, [open]);

  return (
    <Modal
      open={open}
      onClose={submitting ? () => {} : onClose}
      title={t('title')}
      width="md"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={submitting}>
            {tCommon('cancel')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={onConfirm}
            loading={submitting}
            disabled={!acknowledged}
          >
            <Repeat2 className="h-3.5 w-3.5" aria-hidden="true" />
            {t('confirm')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-sm text-ink-primary">{t('body', { name: leadName })}</p>
        <Notice tone="info">{t('warning')}</Notice>
        <label className="flex items-start gap-2 text-sm text-ink-primary">
          <input
            type="checkbox"
            className="mt-1"
            checked={acknowledged}
            disabled={submitting}
            onChange={(e) => setAcknowledged(e.target.checked)}
          />
          <span>{t('acknowledge')}</span>
        </label>
        {error ? <Notice tone="error">{error}</Notice> : null}
      </div>
    </Modal>
  );
}
