'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Field, Textarea } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Notice } from '@/components/ui/notice';
import type { LeadReviewResolution } from '@/lib/api-types';

/**
 * Phase D3 — D3.6: lead-review resolve modal.
 *
 * Opens when a TL clicks one of the four resolve actions on a
 * `LeadReviewCard`. Resolution is pre-pinned by the parent (the
 * modal itself doesn't show a picker — the choice is made on the
 * card so the user gets a fast path). Notes are required by the
 * backend for `kept_owner` and `dismissed`; the modal validates
 * client-side before firing.
 *
 * `rotated` is a special case: the parent is expected to have
 * already triggered the rotation (via the existing rotate modal)
 * BEFORE opening this resolution. The resolve call here just
 * closes the queue row — no rotation re-fire — keeping the
 * rotation tx and the review tx independent.
 */
export function ResolveLeadReviewModal({
  open,
  resolution,
  submitting,
  error,
  onConfirm,
  onClose,
}: {
  open: boolean;
  resolution: LeadReviewResolution;
  submitting: boolean;
  error: string | null;
  onConfirm: (notes?: string) => void;
  onClose: () => void;
}): JSX.Element {
  const t = useTranslations('admin.leadReviews.resolve');
  const tCommon = useTranslations('admin.common');

  const [notes, setNotes] = useState<string>('');

  useEffect(() => {
    if (!open) setNotes('');
  }, [open]);

  const notesRequired = resolution === 'kept_owner' || resolution === 'dismissed';
  const canSubmit = !submitting && (!notesRequired || notes.trim().length > 0);

  return (
    <Modal
      open={open}
      onClose={submitting ? () => {} : onClose}
      title={t(`title.${resolution}` as 'title.rotated')}
      width="md"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={submitting}>
            {tCommon('cancel')}
          </Button>
          <Button
            variant={resolution === 'dismissed' ? 'secondary' : 'primary'}
            size="sm"
            onClick={() => onConfirm(notes.trim().length > 0 ? notes.trim() : undefined)}
            loading={submitting}
            disabled={!canSubmit}
          >
            {t(`confirm.${resolution}` as 'confirm.rotated')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-sm text-ink-primary">{t(`body.${resolution}` as 'body.rotated')}</p>
        <Field
          label={t(notesRequired ? 'notesLabelRequired' : 'notesLabel')}
          required={notesRequired}
          hint={t('notesHint')}
        >
          <Textarea
            rows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            maxLength={1000}
            disabled={submitting}
          />
        </Field>
        {error ? <Notice tone="error">{error}</Notice> : null}
      </div>
    </Modal>
  );
}
