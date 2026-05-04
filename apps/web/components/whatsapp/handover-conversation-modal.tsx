'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Field, Textarea } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Notice } from '@/components/ui/notice';
import { useToast } from '@/components/ui/toast';
import { ApiError, conversationsApi } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { AdminUser, WhatsAppConversation } from '@/lib/api-types';

import { UserPicker } from './user-picker';

/**
 * D1.3 — guided handover modal.
 *
 * Endpoint: POST /conversations/:id/handover
 * Capability: whatsapp.handover
 *
 * Backend invariants reflected here:
 *   - The conversation MUST have a linked lead (handover reassigns
 *     both the conversation AND the lead). When the conversation
 *     has no leadId, the confirm button is disabled and a notice
 *     guides the operator to link a lead first.
 *   - `mode = 'summary'` requires a non-empty summary; the schema
 *     refine on the server matches the client validation here.
 *   - `notify` is informational on the audit payload only — the UI
 *     copy is honest about that.
 */
type HandoverMode = 'full' | 'clean' | 'summary';

const MODES: HandoverMode[] = ['full', 'clean', 'summary'];

export function HandoverConversationModal({
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
  const t = useTranslations('admin.whatsapp');
  const tAssign = useTranslations('admin.whatsapp.assign');
  const tCommon = useTranslations('admin.common');
  const { toast } = useToast();
  const [target, setTarget] = useState<AdminUser | null>(null);
  const [mode, setMode] = useState<HandoverMode>('full');
  const [summary, setSummary] = useState<string>('');
  const [notify, setNotify] = useState<boolean>(false);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setTarget(null);
      setMode('full');
      setSummary('');
      setNotify(false);
      setError(null);
      setSubmitting(false);
    }
  }, [open]);

  const hasLead = Boolean(conversation.leadId);
  const currentOwner =
    conversation.assignedTo?.name ??
    (conversation.assignedToId ? tAssign('unknownOwner') : tAssign('unassigned'));

  async function onConfirm(): Promise<void> {
    if (!target) {
      setError(tAssign('mustSelect'));
      return;
    }
    if (mode === 'summary' && !summary.trim()) {
      setError(t('handover.summaryRequired'));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await conversationsApi.handover(conversation.id, {
        newAssigneeId: target.id,
        mode,
        ...(mode === 'summary' && { summary: summary.trim() }),
        ...(notify && { notify: true }),
      });
      toast({ tone: 'success', title: t('handoverDone') });
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
      title={t('handoverTitle')}
      width="lg"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={submitting}>
            {tCommon('cancel')}
          </Button>
          <Button
            size="sm"
            onClick={() => void onConfirm()}
            loading={submitting}
            disabled={!hasLead || !target || (mode === 'summary' && summary.trim().length === 0)}
          >
            {t('handoverConfirm')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-ink-secondary">{t('handoverHint')}</p>

        {!hasLead ? <Notice tone="info">{t('handoverNeedsLead')}</Notice> : null}

        <Field label={tAssign('currentOwnerLabel')}>
          <p className="rounded-md border border-surface-border bg-surface px-3 py-2 text-sm text-ink-primary">
            {currentOwner}
          </p>
        </Field>

        <Field label={t('handoverNewAssignee')} required>
          <UserPicker
            value={target}
            onChange={(u) => {
              setTarget(u);
              if (u) setError(null);
            }}
            excludeUserId={conversation.assignedToId ?? null}
            ariaLabel={t('handoverNewAssignee')}
          />
        </Field>

        <Field label={t('handoverModeLabel')}>
          <div
            className="flex flex-col gap-2"
            role="radiogroup"
            aria-label={t('handoverModeLabel')}
          >
            {MODES.map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={mode === m}
                onClick={() => setMode(m)}
                className={cn(
                  'flex flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-start transition-colors',
                  mode === m
                    ? 'border-brand-600 bg-brand-50/60'
                    : 'border-surface-border hover:bg-brand-50/30',
                )}
              >
                <span className="text-sm font-medium text-ink-primary">
                  {t(`handoverModes.${m}.title` as 'handoverModes.full.title')}
                </span>
                <span className="text-xs text-ink-tertiary">
                  {t(`handoverModes.${m}.body` as 'handoverModes.full.body')}
                </span>
              </button>
            ))}
          </div>
        </Field>

        {mode === 'summary' ? (
          <Field label={t('handoverSummary')} required hint={t('handover.summaryHint')}>
            <Textarea
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder={t('handoverSummaryPlaceholder')}
              maxLength={2000}
            />
          </Field>
        ) : null}

        <label className="flex items-center gap-2 text-sm text-ink-primary">
          <input
            type="checkbox"
            checked={notify}
            onChange={(e) => setNotify(e.target.checked)}
            className="h-4 w-4 rounded border-surface-border text-brand-600 focus:ring-brand-600"
          />
          <span>{t('handoverNotify')}</span>
        </label>

        {error ? <Notice tone="error">{error}</Notice> : null}
      </div>
    </Modal>
  );
}
