'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { ArrowLeft, MessagesSquare, Phone, Send } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input, Textarea } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import { ApiError, conversationsApi } from '@/lib/api';
import type { ConversationStatus, WhatsAppConversation, WhatsAppMessage } from '@/lib/api-types';
import { cn } from '@/lib/utils';

/**
 * /agent/inbox (C23) — WhatsApp inbox for sales/activation agents.
 *
 * Two-pane layout: conversation list on the left, chat view on the right.
 * On mobile (<md) only one pane shows at a time — picking a conversation
 * swaps the list for the chat; a back arrow returns to the list.
 *
 * State management follows the existing admin convention (plain
 * useState + useEffect + a manual reload). No realtime, no optimistic
 * sends — the message list refreshes after the server confirms.
 */

/** Match the locale-aware short timestamp used by other admin screens. */
function formatRelative(target: Date, now: Date, locale: string): string {
  const diffMs = target.getTime() - now.getTime();
  const abs = Math.abs(diffMs);
  const units: ReadonlyArray<[Intl.RelativeTimeFormatUnit, number]> = [
    ['day', 24 * 60 * 60 * 1000],
    ['hour', 60 * 60 * 1000],
    ['minute', 60 * 1000],
    ['second', 1000],
  ];
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  for (const [unit, ms] of units) {
    if (abs >= ms || unit === 'second') return rtf.format(Math.round(diffMs / ms), unit);
  }
  return '';
}

export default function InboxPage(): JSX.Element {
  const t = useTranslations('agent.inbox');
  const tCommon = useTranslations('admin.common');
  const locale = useLocale();

  // ─────── List state ───────
  const [conversations, setConversations] = useState<WhatsAppConversation[]>([]);
  const [listLoading, setListLoading] = useState<boolean>(true);
  const [listError, setListError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<ConversationStatus | ''>('open');
  const [phoneFilter, setPhoneFilter] = useState<string>('');

  // ─────── Selection + chat state ───────
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<WhatsAppMessage[]>([]);
  const [chatLoading, setChatLoading] = useState<boolean>(false);
  const [chatError, setChatError] = useState<string | null>(null);

  // ─────── Composer ───────
  const [draft, setDraft] = useState<string>('');
  const [sending, setSending] = useState<boolean>(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLLIElement | null>(null);

  // ─────── Loaders ───────

  const reloadList = useCallback(async (): Promise<void> => {
    setListLoading(true);
    setListError(null);
    try {
      const page = await conversationsApi.list({
        status: statusFilter || undefined,
        phone: phoneFilter.trim() || undefined,
        limit: 100,
      });
      setConversations(page.items);
    } catch (err) {
      setListError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setListLoading(false);
    }
  }, [statusFilter, phoneFilter]);

  const reloadMessages = useCallback(async (id: string): Promise<void> => {
    setChatLoading(true);
    setChatError(null);
    try {
      const list = await conversationsApi.listMessages(id, { limit: 200 });
      setMessages(list);
    } catch (err) {
      setChatError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setChatLoading(false);
    }
  }, []);

  useEffect(() => {
    void reloadList();
  }, [reloadList]);

  useEffect(() => {
    if (selectedId) void reloadMessages(selectedId);
    else setMessages([]);
  }, [selectedId, reloadMessages]);

  // Auto-scroll to bottom when messages change.
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length]);

  const selected = useMemo(
    () => conversations.find((c) => c.id === selectedId) ?? null,
    [conversations, selectedId],
  );

  const now = new Date();

  async function onSend(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (!selectedId || !draft.trim()) return;
    setSending(true);
    setSendError(null);
    try {
      await conversationsApi.sendText(selectedId, draft.trim());
      setDraft('');
      // Refresh messages + list (so lastMessage* bubbles up the row).
      await Promise.all([reloadMessages(selectedId), reloadList()]);
    } catch (err) {
      setSendError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }

  function onSelect(id: string): void {
    setSelectedId(id);
    setSendError(null);
    setDraft('');
  }

  function onDeselect(): void {
    setSelectedId(null);
  }

  // ─────── Render ───────

  return (
    <div className="flex h-[calc(100vh-3.5rem-3rem)] min-h-[480px] flex-col gap-3 sm:gap-4">
      <header>
        <h1 className="flex items-center gap-2 text-xl font-semibold text-ink-primary">
          <MessagesSquare className="h-5 w-5 text-brand-700" aria-hidden="true" />
          {t('title')}
        </h1>
        <p className="mt-1 text-sm text-ink-secondary">{t('subtitle')}</p>
      </header>

      {/* Two-column on md+; single-pane on mobile (selection swaps pane). */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-hidden md:grid-cols-[320px_minmax(0,1fr)] md:gap-4">
        {/* ─── List pane ─── */}
        <section
          className={cn(
            'flex min-h-0 flex-col rounded-lg border border-surface-border bg-surface-card shadow-card',
            // Mobile: hide the list while a conversation is selected.
            selected ? 'hidden md:flex' : 'flex',
          )}
        >
          <div className="flex flex-col gap-2 border-b border-surface-border p-3">
            <Field label={t('phoneFilter')}>
              <Input
                value={phoneFilter}
                onChange={(e) => setPhoneFilter(e.target.value)}
                placeholder={t('phoneFilterPlaceholder')}
              />
            </Field>
            <div className="flex items-center gap-1.5">
              {(['open', 'closed', ''] as const).map((s) => (
                <button
                  key={s || 'all'}
                  type="button"
                  onClick={() => setStatusFilter(s)}
                  className={cn(
                    'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                    statusFilter === s
                      ? 'bg-brand-600 text-white'
                      : 'border border-surface-border bg-surface text-ink-secondary hover:bg-brand-50 hover:text-brand-700',
                  )}
                >
                  {s === '' ? tCommon('all') : t(`status.${s}`)}
                </button>
              ))}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto">
            {listError ? (
              <div className="p-3">
                <Notice tone="error">
                  <div className="flex items-start justify-between gap-2">
                    <span>{listError}</span>
                    <Button variant="ghost" size="sm" onClick={() => void reloadList()}>
                      {tCommon('retry')}
                    </Button>
                  </div>
                </Notice>
              </div>
            ) : null}

            {listLoading ? (
              <p className="p-6 text-center text-sm text-ink-secondary">{tCommon('loading')}</p>
            ) : conversations.length === 0 ? (
              <div className="p-3">
                <EmptyState
                  title={phoneFilter || statusFilter ? t('emptyFiltered') : t('empty')}
                  body={phoneFilter || statusFilter ? t('emptyFilteredHint') : t('emptyHint')}
                  action={
                    phoneFilter || statusFilter ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => {
                          setPhoneFilter('');
                          setStatusFilter('');
                        }}
                      >
                        {tCommon('clearFilters')}
                      </Button>
                    ) : null
                  }
                />
              </div>
            ) : (
              <ul className="divide-y divide-surface-border">
                {conversations.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => onSelect(c.id)}
                      className={cn(
                        'flex w-full flex-col items-start gap-0.5 px-3 py-2.5 text-start transition-colors',
                        selectedId === c.id ? 'bg-brand-50' : 'hover:bg-brand-50/50',
                      )}
                    >
                      <div className="flex w-full items-center justify-between gap-2">
                        <span className="flex items-center gap-1.5 text-sm font-medium text-ink-primary">
                          <Phone className="h-3 w-3 text-ink-tertiary" aria-hidden="true" />
                          <code className="font-mono">{c.phone}</code>
                        </span>
                        <span className="shrink-0 text-[11px] text-ink-tertiary">
                          {formatRelative(new Date(c.lastMessageAt), now, locale)}
                        </span>
                      </div>
                      <p className="line-clamp-1 w-full text-xs text-ink-secondary">
                        {c.lastMessageText || '—'}
                      </p>
                      {c.status === 'closed' ? (
                        <span className="text-[10px] font-medium uppercase tracking-wide text-ink-tertiary">
                          {t('status.closed')}
                        </span>
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        {/* ─── Chat pane ─── */}
        <section
          className={cn(
            'flex min-h-0 flex-col rounded-lg border border-surface-border bg-surface-card shadow-card',
            // Mobile: only show when a conversation is selected.
            selected ? 'flex' : 'hidden md:flex',
          )}
        >
          {selected ? (
            <>
              {/* Header */}
              <div className="flex items-center gap-2 border-b border-surface-border px-3 py-2">
                <button
                  type="button"
                  onClick={onDeselect}
                  className="inline-flex items-center justify-center rounded-md p-1.5 text-ink-secondary hover:bg-brand-50 hover:text-brand-700 md:hidden"
                  aria-label={t('back')}
                >
                  <ArrowLeft className="h-4 w-4" />
                </button>
                <div className="flex flex-col leading-tight">
                  <span className="flex items-center gap-1.5 text-sm font-medium text-ink-primary">
                    <Phone className="h-3.5 w-3.5 text-ink-tertiary" aria-hidden="true" />
                    <code className="font-mono">{selected.phone}</code>
                  </span>
                  <span className="text-[11px] text-ink-tertiary">
                    {selected.status === 'open' ? t('status.open') : t('status.closed')}
                  </span>
                </div>
              </div>

              {/* Messages */}
              <div className="flex-1 overflow-y-auto bg-surface px-3 py-3">
                {chatError ? (
                  <Notice tone="error">
                    <div className="flex items-start justify-between gap-2">
                      <span>{chatError}</span>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void reloadMessages(selected.id)}
                      >
                        {tCommon('retry')}
                      </Button>
                    </div>
                  </Notice>
                ) : null}

                {chatLoading && messages.length === 0 ? (
                  <p className="text-center text-sm text-ink-secondary">{tCommon('loading')}</p>
                ) : messages.length === 0 ? (
                  <p className="text-center text-sm text-ink-tertiary">{t('noMessages')}</p>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {messages.map((m) => (
                      <MessageBubble key={m.id} message={m} locale={locale} now={now} />
                    ))}
                    <li ref={messagesEndRef} aria-hidden="true" />
                  </ul>
                )}
              </div>

              {/* Composer */}
              <form
                onSubmit={onSend}
                className="flex flex-col gap-2 border-t border-surface-border p-3"
              >
                {sendError ? <Notice tone="error">{sendError}</Notice> : null}
                <div className="flex items-end gap-2">
                  <Textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder={t('composerPlaceholder')}
                    rows={2}
                    maxLength={4096}
                    disabled={sending}
                    className="flex-1"
                    onKeyDown={(e) => {
                      // Submit on Enter, newline on Shift+Enter — common chat affordance.
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        if (draft.trim() && !sending) {
                          (e.currentTarget.form as HTMLFormElement | null)?.requestSubmit();
                        }
                      }
                    }}
                  />
                  <Button type="submit" loading={sending} disabled={!draft.trim()}>
                    <Send className="h-3.5 w-3.5" aria-hidden="true" />
                    {t('send')}
                  </Button>
                </div>
              </form>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center p-6">
              <EmptyState
                icon={<MessagesSquare className="h-8 w-8" aria-hidden="true" />}
                title={t('selectAConversation')}
                body={t('selectAConversationHint')}
              />
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

interface MessageBubbleProps {
  message: WhatsAppMessage;
  locale: string;
  now: Date;
}

function MessageBubble({ message, locale, now }: MessageBubbleProps): JSX.Element {
  const isOutbound = message.direction === 'outbound';
  return (
    <li className={cn('flex', isOutbound ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[85%] rounded-lg px-3 py-2 text-sm shadow-sm sm:max-w-[70%]',
          isOutbound
            ? 'bg-brand-600 text-white'
            : 'border border-surface-border bg-surface-card text-ink-primary',
        )}
      >
        <p className="whitespace-pre-wrap break-words">{message.text}</p>
        <p
          className={cn('mt-1 text-[11px]', isOutbound ? 'text-white/70' : 'text-ink-tertiary')}
          title={new Date(message.createdAt).toLocaleString()}
        >
          {formatRelative(new Date(message.createdAt), now, locale)}
        </p>
      </div>
    </li>
  );
}
