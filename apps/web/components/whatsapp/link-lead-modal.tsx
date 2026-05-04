'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Notice } from '@/components/ui/notice';
import { useToast } from '@/components/ui/toast';
import { ApiError, conversationsApi } from '@/lib/api';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * D1.3 — minimum-viable link-lead modal.
 *
 * The proper search picker is an open ask for D1.4/D1.5 (it
 * needs cross-cutting lead-search APIs that aren't on D1's
 * critical path). For D1.3 we accept a Lead UUID directly so
 * the operational gap is closed: a TL/admin who knows the lead
 * id (typically copied from /admin/leads or from the lead
 * detail URL) can attach it without leaving the inbox.
 *
 * Server errors are mapped to friendly copy:
 *   - whatsapp.lead_not_found → "Lead not found in your scope"
 *   - whatsapp.lead_in_other_tenant → same friendly copy (RLS hides
 *     it as 404, so this maps under the same code).
 */
export function LinkLeadModal({
  open,
  conversationId,
  onClose,
  onSuccess,
}: {
  open: boolean;
  conversationId: string;
  onClose: () => void;
  onSuccess: () => void;
}): JSX.Element {
  const t = useTranslations('admin.whatsapp.linkLead');
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
    }
  }, [open]);

  async function onConfirm(): Promise<void> {
    const trimmed = leadId.trim();
    if (!trimmed) {
      setError(t('mustEnterId'));
      return;
    }
    if (!UUID_REGEX.test(trimmed)) {
      setError(t('invalidId'));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await conversationsApi.linkLead(conversationId, trimmed);
      toast({ tone: 'success', title: t('success') });
      onSuccess();
    } catch (err) {
      if (err instanceof ApiError) {
        // Backend hides cross-tenant leads as 404; map both shapes
        // to the same friendly copy.
        if (err.status === 404 || err.code === 'whatsapp.lead_not_found') {
          setError(t('notFound'));
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
      title={t('title')}
      width="md"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={submitting}>
            {tCommon('cancel')}
          </Button>
          <Button size="sm" onClick={() => void onConfirm()} loading={submitting}>
            {t('confirmCta')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-ink-secondary">{t('helper')}</p>

        <Field label={t('idLabel')} required hint={t('idHint')}>
          <Input
            type="text"
            value={leadId}
            autoFocus
            onChange={(e) => {
              setLeadId(e.target.value);
              if (error) setError(null);
            }}
            placeholder="00000000-0000-0000-0000-000000000000"
            inputMode="text"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>

        {error ? <Notice tone="error">{error}</Notice> : null}
      </div>
    </Modal>
  );
}
