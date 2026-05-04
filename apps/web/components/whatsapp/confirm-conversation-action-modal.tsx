'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Notice } from '@/components/ui/notice';
import { useToast } from '@/components/ui/toast';
import { ApiError, conversationsApi } from '@/lib/api';

/**
 * D1.3 — generic confirm modal for the three "no-input" actions.
 *
 *   close       → POST /conversations/:id/close
 *   reopen      → POST /conversations/:id/reopen
 *   unlinkLead  → POST /conversations/:id/unlink-lead
 *
 * Each variant has its own title, body explanation and confirm-cta
 * label so the operator never sees a generic "Are you sure?" — the
 * copy spells out what the action does AND what it does NOT do
 * (e.g. unlinking does NOT delete the lead). Backend-rejection
 * messages surface verbatim inside the modal so the operator can
 * read them before retrying.
 */
export type ConfirmableAction = 'close' | 'reopen' | 'unlinkLead';

export function ConfirmConversationActionModal({
  open,
  action,
  conversationId,
  onClose,
  onSuccess,
}: {
  open: boolean;
  action: ConfirmableAction;
  conversationId: string;
  onClose: () => void;
  onSuccess: () => void;
}): JSX.Element {
  const t = useTranslations('admin.whatsapp');
  const tCommon = useTranslations('admin.common');
  const { toast } = useToast();
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const title = t(`${action}.title` as 'close.title');
  const body = t(`${action}.body` as 'close.body');
  const cta = t(`${action}.confirmCta` as 'close.confirmCta');
  const successMessage = t(`${action}.success` as 'close.success');

  async function onConfirm(): Promise<void> {
    setSubmitting(true);
    setError(null);
    try {
      if (action === 'close') {
        await conversationsApi.close(conversationId);
      } else if (action === 'reopen') {
        await conversationsApi.reopen(conversationId);
      } else {
        await conversationsApi.unlinkLead(conversationId);
      }
      toast({ tone: 'success', title: successMessage });
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
      title={title}
      width="md"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={submitting}>
            {tCommon('cancel')}
          </Button>
          <Button
            variant={action === 'reopen' ? 'primary' : 'danger'}
            size="sm"
            onClick={() => void onConfirm()}
            loading={submitting}
          >
            {cta}
          </Button>
        </>
      }
    >
      <p className="text-sm text-ink-primary">{body}</p>
      {error ? (
        <div className="mt-3">
          <Notice tone="error">{error}</Notice>
        </div>
      ) : null}
    </Modal>
  );
}
