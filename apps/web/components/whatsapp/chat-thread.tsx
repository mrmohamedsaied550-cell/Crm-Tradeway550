'use client';

import { useEffect, useRef } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Image as ImageIcon, MessageSquareDashed, Paperclip } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { WhatsAppMessage } from '@/lib/api-types';

/**
 * D1.2 — chat-thread renderer.
 *
 * Inbound messages → muted card-toned bubbles, start-aligned
 * (left in LTR, right in RTL).
 * Outbound messages → brand-toned bubbles, end-aligned.
 *
 * Logical alignment classes (`justify-start` / `justify-end`) flip
 * automatically with the page's `dir` attribute, so the same
 * component renders correctly in both directions.
 *
 * Status pip on outbound: queued, sent, delivered, read, failed.
 * Localised so Arabic operators read "تم التسليم" not "delivered".
 */
export function ChatThread({
  messages,
  loading,
}: {
  messages: readonly WhatsAppMessage[];
  loading?: boolean;
}): JSX.Element {
  const locale = useLocale();
  const t = useTranslations('admin.whatsapp.thread');
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll on new messages.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  const dir = locale === 'ar' ? 'rtl' : 'ltr';

  return (
    <div
      ref={scrollRef}
      dir={dir}
      className="flex flex-1 flex-col gap-2 overflow-y-auto bg-surface px-4 py-3"
    >
      {loading && messages.length === 0 ? (
        <p className="self-center text-xs text-ink-tertiary">{t('loading')}</p>
      ) : null}
      {!loading && messages.length === 0 ? (
        <p className="self-center text-xs text-ink-tertiary">{t('empty')}</p>
      ) : null}
      {messages.map((m) => (
        <MessageBubble key={m.id} message={m} />
      ))}
    </div>
  );
}

function MessageBubble({ message }: { message: WhatsAppMessage }): JSX.Element {
  const t = useTranslations('admin.whatsapp.thread');
  const inbound = message.direction === 'inbound';
  const time = new Date(message.createdAt).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
  const kind = message.messageType ?? 'text';

  return (
    <div className={cn('flex w-full', inbound ? 'justify-start' : 'justify-end')}>
      <div
        className={cn(
          'max-w-[80%] space-y-1 rounded-2xl px-3 py-2 text-sm leading-snug shadow-sm',
          inbound
            ? 'border border-surface-border bg-surface-card text-ink-primary'
            : 'bg-brand-600 text-white',
        )}
      >
        {kind === 'template' ? (
          <Badge tone={inbound ? 'info' : 'inactive'}>
            <MessageSquareDashed className="me-1 inline h-3 w-3" aria-hidden="true" />
            {t('templateBadge', { name: message.templateName ?? '' })}
          </Badge>
        ) : null}
        {kind === 'image' ? (
          <Badge tone={inbound ? 'info' : 'inactive'}>
            <ImageIcon className="me-1 inline h-3 w-3" aria-hidden="true" />
            {t('mediaImage')}
          </Badge>
        ) : null}
        {kind === 'document' ? (
          <Badge tone={inbound ? 'info' : 'inactive'}>
            <Paperclip className="me-1 inline h-3 w-3" aria-hidden="true" />
            {t('mediaDocument')}
          </Badge>
        ) : null}
        {message.text ? <p className="whitespace-pre-wrap break-words">{message.text}</p> : null}
        <div
          className={cn(
            'flex items-center justify-end gap-1.5 text-[10px]',
            inbound ? 'text-ink-tertiary' : 'text-white/80',
          )}
        >
          <span>{time}</span>
          {!inbound ? (
            <>
              <span aria-hidden="true">·</span>
              <span>{t(`status.${message.status}` as 'status.sent')}</span>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
