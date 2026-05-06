'use client';

import { useTranslations } from 'next-intl';
import { EyeOff } from 'lucide-react';

import type { WhatsAppConversation } from '@/lib/api-types';
import { cn } from '@/lib/utils';

/**
 * Phase D5 — D5.12-B: visibility banners that surface server-side
 * redaction state on the WhatsApp conversation thread.
 *
 * The backend (`WhatsAppService.findConversationById` after D5.12-A)
 * sets up to three top-level safety flags on the detail response:
 *
 *   • `priorMessagesHidden` — older messages excluded by the
 *     `WhatsAppVisibilityService` strict-rule-wins gate (clean /
 *     summary transfer always hides; full transfer respects
 *     `priorAgentMessages` field permission).
 *   • `handoverChainHidden` — role denies
 *     `whatsapp.conversation.handoverChain`.
 *   • `historyHidden` — full history (or its prior-message slice)
 *     hidden either way.
 *
 * Renders a stacked notice list above the chat thread when ANY
 * flag is true. RTL/mobile-friendly. The server is the source of
 * truth — these banners are UX guidance only.
 *
 * Stable selectors:
 *   `data-testid="conversation-visibility-banners"` on the
 *   wrapper, `data-flag` on each banner so E2E can assert
 *   coverage.
 */
export function ConversationVisibilityBanners({
  conversation,
}: {
  conversation: WhatsAppConversation;
}): JSX.Element | null {
  const t = useTranslations('common');
  const flags: ReadonlyArray<{ flag: string; copy: string }> = [
    ...(conversation.priorMessagesHidden
      ? [{ flag: 'priorMessagesHidden', copy: t('whatsappPriorMessagesHidden') }]
      : []),
    ...(conversation.handoverChainHidden
      ? [{ flag: 'handoverChainHidden', copy: t('whatsappHandoverChainHidden') }]
      : []),
    ...(conversation.historyHidden
      ? [{ flag: 'historyHidden', copy: t('whatsappHistoryHidden') }]
      : []),
  ];
  if (flags.length === 0) return null;
  return (
    <div
      className="flex flex-col gap-1 border-b border-surface-border bg-surface px-4 py-2"
      data-testid="conversation-visibility-banners"
    >
      {flags.map(({ flag, copy }) => (
        <p
          key={flag}
          data-flag={flag}
          className={cn('inline-flex items-center gap-1.5 text-[11px] italic text-ink-tertiary')}
        >
          <EyeOff className="h-3 w-3 shrink-0" aria-hidden="true" />
          <span>{copy}</span>
        </p>
      ))}
    </div>
  );
}
