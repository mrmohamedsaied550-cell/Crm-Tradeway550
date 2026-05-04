'use client';

import { useTranslations } from 'next-intl';
import { ArrowLeft, ChevronRight, Phone } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { conversationInitials, conversationTitle } from '@/lib/whatsapp';
import type { WhatsAppConversation } from '@/lib/api-types';

import { AssignmentSourceBadge, CaptainBadge, OwnerBadge, StatusBadge } from './badges';
import { WindowPip } from './window-pip';

/**
 * D1.2 — thread header.
 *
 * Tells the operator at a glance:
 *   - WHO they're talking to (avatar + name + phone)
 *   - WHAT shape the conversation is in (status + 24h window)
 *   - WHO owns it (assignmentSource + owner)
 *
 * The action menu (handover / assign / close / reopen / link) lands
 * in D1.3; for now an `actionsSlot` prop accepts whatever the page
 * passes. The "Details" toggle (right) is for the mobile/tablet
 * side-panel drawer (wired by the page when in those layouts).
 */
export function ConversationHeader({
  conversation,
  onBack,
  onToggleDetails,
  detailsOpen,
  actionsSlot,
}: {
  conversation: WhatsAppConversation;
  /** Mobile: back to list. Hidden on desktop. */
  onBack?: () => void;
  /** Mobile/tablet: opens the side-panel drawer. Hidden on desktop. */
  onToggleDetails?: () => void;
  detailsOpen?: boolean;
  actionsSlot?: React.ReactNode;
}): JSX.Element {
  const t = useTranslations('admin.whatsapp.thread');
  const tCommon = useTranslations('admin.common');
  const title = conversationTitle(conversation);
  const initials = conversationInitials(conversation);
  const isCaptain = conversation.contact?.isCaptain ?? false;

  return (
    <header className="flex flex-wrap items-center gap-3 border-b border-surface-border bg-surface-card p-3">
      {onBack ? (
        <button
          type="button"
          onClick={onBack}
          className="rounded-md p-1.5 text-ink-secondary hover:bg-brand-50 hover:text-brand-700"
          aria-label={tCommon('cancel')}
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        </button>
      ) : null}

      <div
        className={
          isCaptain
            ? 'flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-status-warning/15 text-xs font-semibold text-status-warning ring-2 ring-status-warning/30'
            : 'flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-100 text-xs font-semibold text-brand-700'
        }
        aria-hidden="true"
      >
        {initials}
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="truncate text-base font-semibold leading-tight text-ink-primary">
            {title}
          </h2>
          <CaptainBadge visible={isCaptain} />
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-ink-tertiary">
          <span className="inline-flex items-center gap-1">
            <Phone className="h-3 w-3" aria-hidden="true" />
            <code className="font-mono">{conversation.phone}</code>
          </span>
          <StatusBadge status={conversation.status} />
          <AssignmentSourceBadge source={conversation.assignmentSource} />
          <OwnerBadge conversation={conversation} />
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <WindowPip conversation={conversation} />
        {actionsSlot}
        {onToggleDetails ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={onToggleDetails}
            aria-pressed={detailsOpen ?? false}
            aria-label={t('detailsToggle')}
          >
            {t('detailsToggle')}
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </Button>
        ) : null}
      </div>
    </header>
  );
}
