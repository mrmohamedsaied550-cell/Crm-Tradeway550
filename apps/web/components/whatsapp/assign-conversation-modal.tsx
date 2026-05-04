'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Notice } from '@/components/ui/notice';
import { useToast } from '@/components/ui/toast';
import { ApiError, conversationsApi } from '@/lib/api';
import type { AdminUser, WhatsAppConversation } from '@/lib/api-types';

import { UserPicker } from './user-picker';

/**
 * D1.3 — direct reassignment modal.
 *
 * Distinct from Handover: there's no transfer-mode picker, no
 * summary, no notify flag. The operator just picks a new owner and
 * confirms. Used by ops/admin when they need to forcibly reassign
 * a stuck thread without going through the agent-driven handover
 * flow.
 *
 * Endpoint: POST /conversations/:id/assign
 * Capability: whatsapp.conversation.assign
 */
export function AssignConversationModal({
  open,
  conversation,
  onClose,
  onSuccess,
}: {
  open: boolean;
  conversation: WhatsAppConversation;
  onClose: () => void;
  onSuccess: () => void;
}): JSX.Element {
  const t = useTranslations('admin.whatsapp.assign');
  const tCommon = useTranslations('admin.common');
  const { toast } = useToast();
  const [target, setTarget] = useState<AdminUser | null>(null);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Reset state when the modal re-opens for a different conversation.
  useEffect(() => {
    if (!open) {
      setTarget(null);
      setError(null);
      setSubmitting(false);
    }
  }, [open]);

  const currentOwner =
    conversation.assignedTo?.name ??
    (conversation.assignedToId ? t('unknownOwner') : t('unassigned'));

  async function onConfirm(): Promise<void> {
    if (!target) {
      setError(t('mustSelect'));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await conversationsApi.assign(conversation.id, target.id);
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
            disabled={!target}
          >
            {t('confirmCta')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-ink-secondary">{t('helper')}</p>

        <Field label={t('currentOwnerLabel')}>
          <p className="rounded-md border border-surface-border bg-surface px-3 py-2 text-sm text-ink-primary">
            {currentOwner}
          </p>
        </Field>

        <Field label={t('newOwnerLabel')} required>
          <UserPicker
            value={target}
            onChange={(u) => {
              setTarget(u);
              if (u) setError(null);
            }}
            excludeUserId={conversation.assignedToId ?? null}
            autoFocus
            ariaLabel={t('newOwnerLabel')}
          />
        </Field>

        {error ? <Notice tone="error">{error}</Notice> : null}
      </div>
    </Modal>
  );
}
