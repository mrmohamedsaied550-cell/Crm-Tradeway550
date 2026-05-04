'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Notice } from '@/components/ui/notice';
import { useToast } from '@/components/ui/toast';
import { ApiError, reviewsApi } from '@/lib/api';
import type { ReviewResolution } from '@/lib/api-types';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * D1.5 — resolve-review modal.
 *
 * Single dialog shape, four action variants:
 *
 *   - linked_to_lead    — body explains the conversation will be
 *                         attached to the picked lead AND the lead's
 *                         owner / company / country will denormalise
 *                         onto the conversation. Accepts a Lead ID
 *                         when no candidate was preselected (the
 *                         caller passes `presetLeadId` for one-click
 *                         flows).
 *   - linked_to_captain — body explains the conversation is being
 *                         marked as belonging to an existing captain
 *                         and that no sales lead will be created.
 *                         No input.
 *   - new_lead          — body explains a fresh sales lead will be
 *                         created and assigned to the actor (the
 *                         backend reads `claims.userId`).
 *                         No input.
 *   - dismissed         — body explains the row will be marked
 *                         resolved without any state change to the
 *                         conversation. No input.
 *
 * Every variant runs through the same /whatsapp/reviews/:id/resolve
 * endpoint; the backend re-validates the resolution against the
 * review's reason. Backend errors surface as a red Notice inside
 * the modal — the operator can read and retry without losing input.
 */
export function ResolveReviewModal({
  open,
  reviewId,
  resolution,
  presetLeadId,
  onClose,
  onSuccess,
}: {
  open: boolean;
  reviewId: string;
  resolution: ReviewResolution;
  /** When the operator clicked a candidate-lead card, the parent
   *  passes its id so the modal opens with the lead-id pre-filled
   *  and read-only. Pure free-form link still allows manual entry. */
  presetLeadId?: string | null;
  onClose: () => void;
  onSuccess: () => void;
}): JSX.Element {
  const t = useTranslations('admin.whatsappReviews.resolve');
  const tCommon = useTranslations('admin.common');
  const { toast } = useToast();
  const [leadId, setLeadId] = useState<string>('');
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setLeadId('');
      setError(null);
      setSubmitting(false);
      return;
    }
    if (resolution === 'linked_to_lead' && presetLeadId) {
      setLeadId(presetLeadId);
    } else {
      setLeadId('');
    }
  }, [open, resolution, presetLeadId]);

  const isLinkLead = resolution === 'linked_to_lead';
  const needsLeadId = isLinkLead;

  async function onConfirm(): Promise<void> {
    if (needsLeadId) {
      const trimmed = leadId.trim();
      if (!trimmed) {
        setError(t('leadIdRequired'));
        return;
      }
      if (!UUID_REGEX.test(trimmed)) {
        setError(t('invalidLeadId'));
        return;
      }
    }
    setSubmitting(true);
    setError(null);
    try {
      await reviewsApi.resolve(reviewId, {
        resolution,
        ...(needsLeadId && { leadId: leadId.trim() }),
      });
      toast({ tone: 'success', title: t(`success.${resolution}` as 'success.dismissed') });
      onSuccess();
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'whatsapp.review.already_resolved') {
          setError(t('alreadyResolved'));
        } else if (err.code === 'lead.not_found') {
          setError(t('leadNotFound'));
        } else {
          setError(err.message);
        }
      } else {
        setError(String(err));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={submitting ? () => {} : onClose}
      title={t(`title.${resolution}` as 'title.dismissed')}
      width="md"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={submitting}>
            {tCommon('cancel')}
          </Button>
          <Button
            variant={resolution === 'dismissed' ? 'secondary' : 'primary'}
            size="sm"
            onClick={() => void onConfirm()}
            loading={submitting}
            disabled={needsLeadId && leadId.trim().length === 0}
          >
            {t(`confirm.${resolution}` as 'confirm.dismissed')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-sm text-ink-primary">{t(`body.${resolution}` as 'body.dismissed')}</p>

        {needsLeadId ? (
          <Field
            label={t('leadIdLabel')}
            required
            hint={presetLeadId ? t('leadIdHintPreset') : t('leadIdHint')}
          >
            <Input
              type="text"
              value={leadId}
              onChange={(e) => {
                setLeadId(e.target.value);
                if (error) setError(null);
              }}
              readOnly={Boolean(presetLeadId)}
              placeholder="00000000-0000-0000-0000-000000000000"
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
        ) : null}

        {error ? <Notice tone="error">{error}</Notice> : null}
      </div>
    </Modal>
  );
}
