'use client';

import { useTranslations } from 'next-intl';
import { CheckCircle2, Clock, Lock } from 'lucide-react';

import { cn } from '@/lib/utils';
import { formatRemaining, windowRemainingMs, windowState, type WindowState } from '@/lib/whatsapp';
import type { WhatsAppConversation } from '@/lib/api-types';

/**
 * D1.2 — three-state Meta 24-hour customer-service window pip.
 *
 * Renders inside the conversation header and (in compact mode) above
 * the composer. Plain-language wording — agents see "You can reply
 * freely for 14h 23m" instead of "lastInboundAt + 24h".
 *
 *   - open          → green pip + remaining countdown
 *   - closing_soon  → yellow pip + warning copy
 *   - closed        → red pip + template-only explanation
 */
const STATE_TONE: Record<WindowState, string> = {
  open: 'border-status-healthy/40 bg-status-healthy/10 text-status-healthy',
  closing_soon: 'border-status-warning/40 bg-status-warning/10 text-status-warning',
  closed: 'border-status-error/40 bg-status-error/10 text-status-error',
};

const STATE_ICON: Record<WindowState, typeof Clock> = {
  open: CheckCircle2,
  closing_soon: Clock,
  closed: Lock,
};

export function WindowPip({
  conversation,
  compact = false,
}: {
  conversation: WhatsAppConversation;
  /** Compact = no copy, just the icon + tone. Used in the list row. */
  compact?: boolean;
}): JSX.Element {
  const t = useTranslations('admin.whatsapp.window');
  const state = windowState(conversation);
  const Icon = STATE_ICON[state];
  const remaining = windowRemainingMs(conversation);

  if (compact) {
    return (
      <span
        className={cn(
          'inline-flex h-5 w-5 items-center justify-center rounded-full border',
          STATE_TONE[state],
        )}
        title={t(state)}
        aria-label={t(state)}
      >
        <Icon className="h-3 w-3" aria-hidden="true" />
      </span>
    );
  }

  // Full pip — used in the thread header.
  const message =
    state === 'open'
      ? t('openWithTime', { time: formatRemaining(remaining) })
      : state === 'closing_soon'
        ? t('closingSoonWithTime', { time: formatRemaining(remaining) })
        : t('closed');

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium',
        STATE_TONE[state],
      )}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      <span>{message}</span>
    </span>
  );
}
