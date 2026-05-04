'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  ChevronDown,
  Link as LinkIcon,
  Lock,
  LockOpen,
  MoreHorizontal,
  Unlink,
  UserCog,
  UserRoundPlus,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { hasCapability } from '@/lib/auth';
import { cn } from '@/lib/utils';
import type { WhatsAppConversation } from '@/lib/api-types';

/**
 * D1.3 — More-Actions dropdown for ConversationHeader.actionsSlot.
 *
 * Visibility rules:
 *   - Each item is hidden unless the calling user has the matching
 *     capability. The cached /auth/me payload drives the check; the
 *     server remains the source of truth.
 *   - Close is shown only when conversation.status === 'open'.
 *   - Reopen is shown only when conversation.status === 'closed'.
 *   - Link Lead is shown when there is no leadId AND the user has
 *     whatsapp.link.lead.
 *   - Unlink Lead is shown when there is a leadId AND the user has
 *     whatsapp.link.lead.
 *   - The whole menu collapses (returns null) when no actions are
 *     visible — we don't render an empty dropdown.
 *
 * Trigger UX: small ghost button with the `MoreHorizontal` icon
 * (⋯) plus a chevron — operators recognise "more" affordances by
 * the dot pattern. Closes on outside click + Escape; the trigger
 * button keeps its own aria-expanded.
 */

export type ConversationAction =
  | 'assign'
  | 'handover'
  | 'close'
  | 'reopen'
  | 'linkLead'
  | 'unlinkLead';

export function ConversationActionMenu({
  conversation,
  onAction,
}: {
  conversation: WhatsAppConversation;
  onAction: (action: ConversationAction) => void;
}): JSX.Element | null {
  const t = useTranslations('admin.whatsapp.actions');
  const [open, setOpen] = useState<boolean>(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    function onDocClick(e: MouseEvent): void {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') setOpen(false);
    }
    window.addEventListener('mousedown', onDocClick);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDocClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const isOpen = conversation.status === 'open';
  const isClosed = conversation.status === 'closed';
  const hasLead = Boolean(conversation.leadId);

  const items: Array<{
    key: ConversationAction;
    label: string;
    Icon: typeof UserCog;
    visible: boolean;
    danger?: boolean;
  }> = [
    {
      key: 'handover',
      label: t('handoverLabel'),
      Icon: UserRoundPlus,
      visible: hasCapability('whatsapp.handover'),
    },
    {
      key: 'assign',
      label: t('assignLabel'),
      Icon: UserCog,
      visible: hasCapability('whatsapp.conversation.assign'),
    },
    {
      key: 'linkLead',
      label: t('linkLabel'),
      Icon: LinkIcon,
      visible: !hasLead && hasCapability('whatsapp.link.lead'),
    },
    {
      key: 'unlinkLead',
      label: t('unlinkLabel'),
      Icon: Unlink,
      visible: hasLead && hasCapability('whatsapp.link.lead'),
    },
    {
      key: 'close',
      label: t('closeLabel'),
      Icon: Lock,
      visible: isOpen && hasCapability('whatsapp.conversation.close'),
      danger: true,
    },
    {
      key: 'reopen',
      label: t('reopenLabel'),
      Icon: LockOpen,
      visible: isClosed && hasCapability('whatsapp.conversation.reopen'),
    },
  ];

  const visible = items.filter((i) => i.visible);
  if (visible.length === 0) return null;

  return (
    <div ref={containerRef} className="relative">
      <Button
        variant="secondary"
        size="sm"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('menuAria')}
      >
        <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
        <span className="hidden sm:inline">{t('menuLabel')}</span>
        <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
      </Button>
      {open ? (
        <div
          role="menu"
          className="absolute end-0 z-30 mt-1 w-60 overflow-hidden rounded-md border border-surface-border bg-surface-card shadow-card"
        >
          <ul className="py-1">
            {visible.map(({ key, label, Icon, danger }) => (
              <li key={key}>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setOpen(false);
                    onAction(key);
                  }}
                  className={cn(
                    'flex w-full items-center gap-2 px-3 py-2 text-sm transition-colors',
                    'hover:bg-brand-50 focus-visible:bg-brand-50 focus-visible:outline-none',
                    danger ? 'text-status-breach' : 'text-ink-primary',
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>{label}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
