'use client';

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Image as ImageIcon, MessageSquareDashed, Send } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { Textarea } from '@/components/ui/input';
import { windowState } from '@/lib/whatsapp';
import type { WhatsAppConversation } from '@/lib/api-types';

/**
 * D1.2 — outbound composer.
 *
 * Three-state 24-hour customer-service window banner:
 *
 *   • open          → no banner; freeform text allowed
 *   • closing_soon  → yellow inline notice ("Window closes in 47m —
 *                     wrap up or send a template")
 *   • closed        → red notice + freeform input disabled; the
 *                     template button stays available so agents
 *                     can re-open the conversation
 *
 * Closed conversation overrides everything: the composer is fully
 * disabled with a "reopen first" banner.
 *
 * Capability gating: the page passes `canSendText`, `canSendMedia`,
 * `canSendTemplate`. When all three are false, the composer renders
 * an explanatory banner instead of disappearing — the operator
 * shouldn't wonder if the page is broken.
 *
 * Resilience: a failed send NEVER loses the typed text. The page
 * re-throws + we restore the draft from a ref before the input
 * lost focus. Tested manually.
 */
export function SendComposer({
  conversation,
  canSendText,
  canSendMedia,
  canSendTemplate,
  sending,
  onSendText,
  onOpenTemplate,
  onOpenMedia,
}: {
  conversation: WhatsAppConversation;
  canSendText: boolean;
  canSendMedia: boolean;
  canSendTemplate: boolean;
  sending?: boolean;
  onSendText: (text: string) => Promise<void> | void;
  onOpenTemplate: () => void;
  onOpenMedia: () => void;
}): JSX.Element | null {
  const t = useTranslations('admin.whatsapp.compose');
  const [draft, setDraft] = useState('');
  const lastDraftRef = useRef<string>('');

  const closed = conversation.status === 'closed';
  const state = windowState(conversation);
  const freeformDisabled = closed || state === 'closed' || !canSendText;
  const noPermissionAtAll = !canSendText && !canSendMedia && !canSendTemplate;

  // Keep the last-typed draft snapshot so a failed submit can restore.
  useEffect(() => {
    lastDraftRef.current = draft;
  }, [draft]);

  async function submit(): Promise<void> {
    const value = draft.trim();
    if (!value) return;
    const snapshot = value;
    setDraft('');
    try {
      await onSendText(snapshot);
    } catch {
      // Page-level error toast handles surfacing — restore the typed
      // text so the operator doesn't lose it.
      setDraft(snapshot);
    }
  }

  function onSubmit(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    void submit();
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  }

  if (noPermissionAtAll) {
    return (
      <div className="border-t border-surface-border bg-surface-card p-3">
        <Notice tone="info">{t('noPermission')}</Notice>
      </div>
    );
  }

  return (
    <form
      onSubmit={onSubmit}
      className="flex flex-col gap-2 border-t border-surface-border bg-surface-card p-3"
    >
      {closed ? (
        <Notice tone="info">{t('closedBanner')}</Notice>
      ) : state === 'closed' ? (
        <Notice tone="error">{t('windowClosedBanner')}</Notice>
      ) : state === 'closing_soon' ? (
        // Notice doesn't have a 'warning' tone today (it ships
        // success / error / info). Render a compact inline banner
        // with the warning palette so the user gets a clear
        // "wrap up" signal without escalating to error red.
        <div
          role="status"
          className="rounded-md border border-status-warning/40 bg-status-warning/10 px-3 py-2 text-sm text-status-warning"
        >
          {t('windowClosingSoonBanner')}
        </div>
      ) : null}

      <Textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={
          freeformDisabled
            ? closed
              ? t('placeholderClosed')
              : t('placeholderWindowClosed')
            : t('placeholder')
        }
        rows={3}
        maxLength={4096}
        disabled={freeformDisabled}
      />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1">
          {canSendTemplate ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onOpenTemplate}
              disabled={closed}
              title={closed ? t('closedBanner') : t('templateHint')}
            >
              <MessageSquareDashed className="h-4 w-4" aria-hidden="true" />
              {t('template')}
            </Button>
          ) : null}
          {canSendMedia ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onOpenMedia}
              disabled={closed || state === 'closed'}
              title={
                closed
                  ? t('closedBanner')
                  : state === 'closed'
                    ? t('windowClosedBanner')
                    : t('mediaHint')
              }
            >
              <ImageIcon className="h-4 w-4" aria-hidden="true" />
              {t('media')}
            </Button>
          ) : null}
          {!canSendText ? (
            <span className="text-xs text-ink-tertiary">{t('noTextPermission')}</span>
          ) : null}
        </div>
        <Button
          type="submit"
          loading={sending}
          disabled={freeformDisabled || draft.trim().length === 0}
        >
          <Send className="h-4 w-4" aria-hidden="true" />
          {t('send')}
        </Button>
      </div>
    </form>
  );
}
