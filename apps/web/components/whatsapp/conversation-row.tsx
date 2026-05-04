'use client';

import { useTranslations } from 'next-intl';

import { cn } from '@/lib/utils';
import { conversationInitials, conversationTitle, timeAgo, windowState } from '@/lib/whatsapp';
import type { WhatsAppConversation } from '@/lib/api-types';

import {
  AssignmentSourceBadge,
  CaptainBadge,
  HasOpenLeadBadge,
  OwnerBadge,
  StatusBadge,
} from './badges';
import { WindowPip } from './window-pip';

/**
 * D1.2 — single conversation list row.
 *
 * Hierarchy reads top-down:
 *   line 1 — customer (displayName/phone) + relative time
 *   line 2 — last message preview (truncated)
 *   line 3 — operational chips: status + window pip (compact) +
 *            ownership source + owner + contact flags
 *
 * Captain conversations get a distinct avatar tone so ops eyes
 * land on them first. Out-of-window conversations get the red
 * compact pip so agents know template-only at a glance.
 */
export function ConversationRow({
  conversation,
  selected,
  onClick,
  showOwner,
}: {
  conversation: WhatsAppConversation;
  selected: boolean;
  onClick: () => void;
  /** TL/admin views show the owner name; agent's "Mine" view hides it (always self). */
  showOwner: boolean;
}): JSX.Element {
  const t = useTranslations('admin.whatsapp.list');
  const ago = timeAgo(conversation.lastMessageAt);
  const state = windowState(conversation);
  const isCaptain = conversation.contact?.isCaptain ?? false;
  const hasOpenLead = conversation.contact?.hasOpenLead ?? false;
  const initials = conversationInitials(conversation);
  const title = conversationTitle(conversation);

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-start gap-3 border-s-2 border-transparent p-3 text-start transition-colors',
        'hover:bg-brand-50/40 focus-visible:bg-brand-50/40 focus-visible:outline-none',
        selected && 'border-brand-600 bg-brand-50/60',
      )}
    >
      {/* Avatar — captain gets a warning-toned ring so ops spots it fast. */}
      <div
        className={cn(
          'flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
          isCaptain
            ? 'bg-status-warning/15 text-status-warning ring-2 ring-status-warning/30'
            : 'bg-brand-100 text-brand-700',
        )}
        aria-hidden="true"
      >
        {initials}
      </div>

      <div className="flex flex-1 flex-col gap-1 overflow-hidden">
        {/* Line 1 — title + time */}
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-medium text-ink-primary">{title}</span>
          <span className="shrink-0 text-[11px] text-ink-tertiary">
            {ago.unit === 'now'
              ? t('time.now')
              : t(`time.${ago.unit}` as 'time.m', { n: ago.value })}
          </span>
        </div>

        {/* Line 2 — last message preview */}
        <p className="line-clamp-1 text-xs text-ink-secondary">
          {conversation.lastMessageText || conversation.phone}
        </p>

        {/* Line 3 — operational chips */}
        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
          {conversation.status === 'closed' ? <StatusBadge status="closed" /> : null}
          <WindowPip conversation={conversation} compact />
          <AssignmentSourceBadge source={conversation.assignmentSource} />
          {showOwner ? <OwnerBadge conversation={conversation} showUnassigned={false} /> : null}
          <CaptainBadge visible={isCaptain} />
          <HasOpenLeadBadge visible={hasOpenLead && !isCaptain} />
          {/* Window state hint for screen readers */}
          <span className="sr-only">{state}</span>
        </div>
      </div>
    </button>
  );
}
