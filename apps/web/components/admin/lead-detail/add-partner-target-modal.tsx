'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Field, Select, Textarea } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Notice } from '@/components/ui/notice';
import { useToast } from '@/components/ui/toast';
import { ApiError, leadPartnerTargetsApi, partnerSourcesApi } from '@/lib/api';
import type { PartnerSourceRow } from '@/lib/api-types';

/**
 * Sprint 13 (D13) — Add Partner Target modal.
 *
 * Opens from the Partner Presence panel ("Add target" CTA) and
 * from the Add Action drawer's Partner Data area. Posts to
 * leadPartnerTargetsApi.create — the server's dedupe contract
 * raises lead.partner_target.duplicate on (lead, partner) collision,
 * which the modal surfaces as an inline error.
 *
 * Critical invariant: this flow never creates a Lead / Contact /
 * Captain — it only writes a LeadPartnerTarget row anchored on
 * the current leadId.
 *
 * Capability gates: caller must already have partner.target.write;
 * the parent surface only mounts the modal when so. The server
 * remains the source of truth.
 */

interface AddPartnerTargetModalProps {
  open: boolean;
  leadId: string;
  onClose: () => void;
  /** Fires after a successful create so the parent can refresh
   *  Partner Presence + Lead Detail timeline. */
  onAdded?: () => void;
}

export function AddPartnerTargetModal({
  open,
  leadId,
  onClose,
  onAdded,
}: AddPartnerTargetModalProps): JSX.Element {
  const t = useTranslations('admin.leads.detail.partnerPresence.addTarget');
  const tCommon = useTranslations('admin.common');
  const { toast } = useToast();

  const [sources, setSources] = useState<readonly PartnerSourceRow[]>([]);
  const [sourcesLoading, setSourcesLoading] = useState<boolean>(true);
  const [sourcesError, setSourcesError] = useState<string | null>(null);

  const [partnerSourceId, setPartnerSourceId] = useState<string>('');
  const [note, setNote] = useState<string>('');
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<boolean>(false);

  // Reset state on close so reopening doesn't show stale errors.
  useEffect(() => {
    if (!open) {
      setPartnerSourceId('');
      setNote('');
      setSubmitError(null);
      setSubmitting(false);
    }
  }, [open]);

  // Load partner sources when the modal first opens. The list is
  // small (handful per tenant) so we fetch once per open and let
  // the operator pick from a dropdown.
  const refreshSources = useCallback(async () => {
    setSourcesLoading(true);
    setSourcesError(null);
    try {
      const resp = await partnerSourcesApi.list({ isActive: true, limit: 100 });
      setSources(resp.items);
      if (resp.items.length > 0 && !partnerSourceId) {
        setPartnerSourceId(resp.items[0]!.id);
      }
    } catch (err) {
      setSourcesError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSourcesLoading(false);
    }
    // partnerSourceId is intentionally left out of deps — we only
    // want a default when the dropdown opens empty.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (open) void refreshSources();
  }, [open, refreshSources]);

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (submitting) return;
    if (!partnerSourceId) {
      setSubmitError(t('errors.partnerRequired'));
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      await leadPartnerTargetsApi.create(leadId, {
        partnerSourceId,
        ...(note.trim().length > 0 ? { note: note.trim() } : {}),
      });
      toast({ tone: 'success', title: t('toast.added') });
      onAdded?.();
      onClose();
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'lead.partner_target.duplicate') {
          setSubmitError(t('errors.duplicate'));
        } else if (err.code === 'lead.partner_target.partner_source_invalid') {
          setSubmitError(t('errors.partnerInvalid'));
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
          <Button
            type="submit"
            form="add-partner-target-form"
            loading={submitting}
            disabled={!partnerSourceId || sourcesLoading}
          >
            {t('action')}
          </Button>
        </>
      }
    >
      <form id="add-partner-target-form" className="flex flex-col gap-3" onSubmit={onSubmit}>
        <Notice tone="info">
          <p className="text-xs text-ink-secondary">{t('preview')}</p>
        </Notice>
        {submitError ? <Notice tone="error">{submitError}</Notice> : null}
        {sourcesError ? <Notice tone="error">{sourcesError}</Notice> : null}
        <Field label={t('form.partner')} required>
          {sourcesLoading ? (
            <p className="text-sm text-ink-secondary">{tCommon('loading')}</p>
          ) : sources.length === 0 ? (
            <p className="text-sm text-status-warning">{t('errors.noPartnerSources')}</p>
          ) : (
            <Select
              value={partnerSourceId}
              onChange={(e) => setPartnerSourceId(e.target.value)}
              required
            >
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.displayName}
                </option>
              ))}
            </Select>
          )}
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
