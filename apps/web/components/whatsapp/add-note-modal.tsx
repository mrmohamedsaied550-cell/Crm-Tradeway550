'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Field, Textarea } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Notice } from '@/components/ui/notice';
import { useToast } from '@/components/ui/toast';
import { ApiError, leadsApi } from '@/lib/api';

/**
 * D1.4 — add a note to the linked lead from the WhatsApp side panel.
 *
 * Posts to POST /leads/:id/activities with type='note' and the
 * D1.1 actionSource='whatsapp' attribution so the lead-detail
 * timeline shows the note came from the inbox, not from the lead
 * detail screen. The capability gate (`lead.activity.write`) is
 * enforced both client-side (the trigger button hides) and
 * server-side via @RequireCapability.
 *
 * Empty input is rejected client-side; server errors keep the form
 * open so the operator can read the message and retry without
 * retyping the body.
 */
export function AddNoteModal({
  open,
  leadId,
  onClose,
  onSuccess,
}: {
  open: boolean;
  /** Required — the modal only opens when there's a linked lead. */
  leadId: string;
  onClose: () => void;
  onSuccess: () => void;
}): JSX.Element {
  const t = useTranslations('admin.whatsapp.addNote');
  const tCommon = useTranslations('admin.common');
  const { toast } = useToast();
  const [body, setBody] = useState<string>('');
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setBody('');
      setError(null);
      setSubmitting(false);
    }
  }, [open]);

  async function onConfirm(): Promise<void> {
    const trimmed = body.trim();
    if (!trimmed) {
      setError(t('mustEnterBody'));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await leadsApi.addActivity(leadId, {
        type: 'note',
        body: trimmed,
        actionSource: 'whatsapp',
      });
      toast({ tone: 'success', title: t('success') });
      onSuccess();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

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
            size="sm"
            onClick={() => void onConfirm()}
            loading={submitting}
            disabled={body.trim().length === 0}
          >
            {t('confirmCta')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-sm text-ink-secondary">{t('helper')}</p>
        <Field label={t('bodyLabel')} required hint={t('bodyHint')}>
          <Textarea
            value={body}
            onChange={(e) => {
              setBody(e.target.value);
              if (error) setError(null);
            }}
            placeholder={t('bodyPlaceholder')}
            autoFocus
            maxLength={4000}
            rows={5}
          />
        </Field>
        {error ? <Notice tone="error">{error}</Notice> : null}
      </div>
    </Modal>
  );
}
