'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Field, Select, Textarea } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Notice } from '@/components/ui/notice';
import { useToast } from '@/components/ui/toast';
import {
  ApiError,
  leadPartnerTargetsApi,
  type LeadPartnerTargetRow,
  type LeadPartnerTargetStatus,
} from '@/lib/api';

/**
 * Sprint 17 (D17) — Edit Partner Target modal.
 *
 * Pairs with the Sprint 13 AddPartnerTargetModal — same dialog
 * patterns, same i18n root, same capability gate
 * (`partner.target.write`, mounted only when the parent says so).
 * Calls `leadPartnerTargetsApi.update` which posts the PATCH body
 * with three-way null semantics: clearing the note submits `null`,
 * leaving the field unchanged submits `undefined` (the form filters
 * out unchanged fields before sending).
 *
 * The modal supports two operator workflows:
 *   1. Status transition — pick the new status, optionally edit the
 *      note, save.
 *   2. Note edit — leave status alone, update the note.
 *
 * `partnerSourceId` is not editable by design: changing the partner
 * source is a different operational decision (the dedupe key would
 * shift, the audit trail would be misleading). Operators who want a
 * different partner create a new target.
 */

const STATUSES: readonly LeadPartnerTargetStatus[] = [
  'target',
  'not_started',
  'contacted',
  'signup_started',
  'matched',
  'rejected',
  'inactive',
] as const;

interface EditPartnerTargetModalProps {
  open: boolean;
  leadId: string;
  /** The row being edited. Null while the parent hasn't picked one. */
  target: LeadPartnerTargetRow | null;
  onClose: () => void;
  /** Fires after a successful PATCH so the parent can refresh
   *  Partner Presence + Lead Detail timeline. */
  onUpdated?: () => void;
}

export function EditPartnerTargetModal({
  open,
  leadId,
  target,
  onClose,
  onUpdated,
}: EditPartnerTargetModalProps): JSX.Element {
  const t = useTranslations('admin.leads.detail.partnerPresence.editTarget');
  const tStatus = useTranslations('admin.leads.detail.partnerPresence.addTarget.status');
  const tCommon = useTranslations('admin.common');
  const { toast } = useToast();

  const [status, setStatus] = useState<LeadPartnerTargetStatus>('target');
  const [note, setNote] = useState<string>('');
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<boolean>(false);

  // Seed the form from the row each time the modal opens. We can't
  // rely on the target object identity changing because the parent
  // might pass the same reference; key on `open + target?.id`.
  useEffect(() => {
    if (open && target) {
      setStatus(target.status);
      setNote(target.note ?? '');
      setSubmitError(null);
      setSubmitting(false);
    }
  }, [open, target]);

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (submitting || !target) return;

    // Build the PATCH body. Only include fields that actually
    // changed so the audit row records a precise changedFields
    // list. `note` is `string | null` — undefined means unchanged,
    // null clears, value sets.
    const body: {
      status?: LeadPartnerTargetStatus;
      note?: string | null;
    } = {};
    if (status !== target.status) body.status = status;
    const nextNote = note.trim();
    const prevNote = (target.note ?? '').trim();
    if (nextNote !== prevNote) {
      body.note = nextNote.length > 0 ? nextNote : null;
    }
    if (Object.keys(body).length === 0) {
      // Nothing to send — close cleanly without firing a server call.
      onClose();
      return;
    }

    setSubmitting(true);
    setSubmitError(null);
    try {
      await leadPartnerTargetsApi.update(leadId, target.id, body);
      toast({ tone: 'success', title: t('toast.saved') });
      onUpdated?.();
      onClose();
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'lead.partner_target.not_found') {
          setSubmitError(t('errors.notFound'));
        } else if (err.code === 'lead.partner_target.owner_invalid') {
          setSubmitError(t('errors.ownerInvalid'));
        } else if (err.code === 'lead.partner_target.team_invalid') {
          setSubmitError(t('errors.teamInvalid'));
        } else if (err.code === 'lead.partner_target.country_invalid') {
          setSubmitError(t('errors.countryInvalid'));
        } else {
          setSubmitError(err.message);
        }
      } else {
        setSubmitError(String(err));
      }
    } finally {
      setSubmitting(false);
    }
  }

  const partnerLabel = target?.partnerSource?.displayName ?? t('unknownPartner');

  return (
    <Modal
      open={open}
      title={t('modalTitle')}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            {tCommon('cancel')}
          </Button>
          <Button type="submit" form="edit-partner-target-form" loading={submitting}>
            {t('action')}
          </Button>
        </>
      }
    >
      <form id="edit-partner-target-form" className="flex flex-col gap-3" onSubmit={onSubmit}>
        <Notice tone="info">
          <p className="text-xs text-ink-secondary">{t('preview', { partner: partnerLabel })}</p>
        </Notice>
        {submitError ? <Notice tone="error">{submitError}</Notice> : null}

        <Field label={t('form.status')} required>
          <Select
            value={status}
            onChange={(e) => setStatus(e.target.value as LeadPartnerTargetStatus)}
            required
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {tStatus(s)}
              </option>
            ))}
          </Select>
        </Field>

        <Field label={t('form.note')}>
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            placeholder={t('form.notePlaceholder')}
          />
        </Field>
      </form>
    </Modal>
  );
}
