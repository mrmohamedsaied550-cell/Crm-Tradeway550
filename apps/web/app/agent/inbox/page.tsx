'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { ArrowLeft, Lock, MessagesSquare, Phone, Send } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import { ApiError, conversationsApi, whatsappAccountsApi } from '@/lib/api';
import type {
  ConversationStatus,
  WhatsAppAccount,
  WhatsAppConversation,
  WhatsAppMessage,
} from '@/lib/api-types';
import { cn } from '@/lib/utils';

/**
 * /agent/inbox (C23 + C24 polish) — WhatsApp inbox for sales/activation
 * agents.
 *
 * Two-pane layout: conversation list on the left, chat view on the right.
 * On mobile (<md) only one pane shows at a time — picking a conversation
 * swaps the list for the chat; a back arrow returns to the list.
 *
 * C24 additions:
 *   - WhatsApp account filter (defaults to "All accounts").
 *   - Status filter as a 3-way segmented control (open / closed / all).
 *   - Closed conversations show a clear notice and disable the composer.
 *   - Messages render with day separators and consecutive-bubble grouping.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Locale-aware short relative timestamp ("2 minutes ago"). */
function formatRelative(target: Date, now: Date, locale: string): string {
  const diffMs = target.getTime() - now.getTime();
  const abs = Math.abs(diffMs);
  const units: ReadonlyArray<[Intl.RelativeTimeFormatUnit, number]> = [
    ['day', DAY_MS],
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

/** Wall-clock day key — used for day separators inside the chat view. */
function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayLabel(
  d: Date,
  now: Date,
  locale: string,
  todayLabel: string,
  yesterdayLabel: string,
): string {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((target.getTime() - today.getTime()) / DAY_MS);
  if (diffDays === 0) return todayLabel;
  if (diffDays === -1) return yesterdayLabel;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(d);
}

function formatTimeOfDay(d: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(d);
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
  const [accountFilter, setAccountFilter] = useState<string>(''); // '' = all

  // ─────── Accounts (for the filter dropdown) ───────
  const [accounts, setAccounts] = useState<WhatsAppAccount[]>([]);
  const [accountsError, setAccountsError] = useState<string | null>(null);

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
        accountId: accountFilter || undefined,
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
  }, [accountFilter, statusFilter, phoneFilter]);

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

  // Load the account list once — agents pick from it to filter the inbox.
  // A failure here is surfaced inline but does NOT block the rest of the
  // page: the filter just falls back to "all accounts".
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const items = await whatsappAccountsApi.list();
        if (!cancelled) setAccounts(items);
      } catch (err) {
        if (!cancelled) {
          setAccountsError(err instanceof ApiError ? err.message : String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
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

  const accountById = useMemo(() => {
    const m = new Map<string, WhatsAppAccount>();
    for (const a of accounts) m.set(a.id, a);
    return m;
  }, [accounts]);

  const now = new Date();
  const hasFilters = Boolean(accountFilter || statusFilter || phoneFilter);
  const isClosed = selected?.status === 'closed';

  async function onSend(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (!selectedId || !draft.trim() || isClosed) return;
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

  function clearFilters(): void {
    setPhoneFilter('');
    setStatusFilter('');
    setAccountFilter('');
  }

  // Group consecutive same-direction messages and split by day so the
  // chat reads naturally without dozens of repeated avatars / day labels.
  const messageGroups = useMemo(() => groupMessages(messages), [messages]);

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
            <Field label={t('accountFilter')}>
              <Select
                value={accountFilter}
                onChange={(e) => setAccountFilter(e.target.value)}
                aria-label={t('accountFilter')}
              >
                <option value="">{t('allAccounts')}</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.displayName} — {a.phoneNumber}
                    {a.isActive ? '' : ` ${t('accountInactive')}`}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('phoneFilter')}>
              <Input
                value={phoneFilter}
                onChange={(e) => setPhoneFilter(e.target.value)}
                placeholder={t('phoneFilterPlaceholder')}
                inputMode="tel"
              />
            </Field>
            <div
              role="radiogroup"
              aria-label={t('status.open')}
              className="flex items-center gap-1"
            >
              {(['open', 'closed', ''] as const).map((s) => {
                const label = s === '' ? t('status.all') : t(`status.${s}`);
                const active = statusFilter === s;
                return (
                  <button
                    key={s || 'all'}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => setStatusFilter(s)}
                    className={cn(
                      'flex-1 rounded-md px-2 py-1 text-xs font-medium transition-colors',
                      active
                        ? 'bg-brand-600 text-white'
                        : 'border border-surface-border bg-surface text-ink-secondary hover:bg-brand-50 hover:text-brand-700',
                    )}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            {accountsError ? <Notice tone="error">{accountsError}</Notice> : null}
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
                  icon={<MessagesSquare className="h-7 w-7" aria-hidden="true" />}
                  title={hasFilters ? t('emptyFiltered') : t('empty')}
                  body={hasFilters ? t('emptyFilteredHint') : t('emptyHint')}
                  action={
                    hasFilters ? (
                      <Button variant="secondary" size="sm" onClick={clearFilters}>
                        {tCommon('clearFilters')}
                      </Button>
                    ) : null
                  }
                />
              </div>
            ) : (
              <ul className="divide-y divide-surface-border">
                {conversations.map((c) => {
                  const account = accountById.get(c.accountId);
                  return (
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
                        <div className="flex w-full items-center justify-between gap-2">
                          {account ? (
                            <span className="line-clamp-1 text-[10px] text-ink-tertiary">
                              {account.displayName}
                            </span>
                          ) : (
                            <span />
                          )}
                          {c.status === 'closed' ? (
                            <span className="inline-flex shrink-0 items-center gap-0.5 rounded bg-surface px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink-tertiary">
                              <Lock className="h-2.5 w-2.5" aria-hidden="true" />
                              {t('status.closed')}
                            </span>
                          ) : null}
                        </div>
                      </button>
                    </li>
                  );
                })}
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
                    {(() => {
                      const account = accountById.get(selected.accountId);
                      const statusLabel = isClosed ? t('status.closed') : t('status.open');
                      return account ? `${statusLabel} · ${account.displayName}` : statusLabel;
                    })()}
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
                  <EmptyState title={t('noMessages')} body={t('noMessagesHint')} />
                ) : (
                  <ul className="flex flex-col gap-3">
                    {messageGroups.map((group, gi) => (
                      <li key={`g${gi}`} className="flex flex-col gap-1">
                        {group.kind === 'day' ? (
                          <div className="flex items-center justify-center py-1">
                            <span className="rounded-full bg-surface-card px-2.5 py-0.5 text-[11px] font-medium text-ink-tertiary shadow-sm">
                              {dayLabel(group.day, now, locale, t('today'), t('yesterday'))}
                            </span>
                          </div>
                        ) : (
                          <ul
                            className={cn(
                              'flex flex-col gap-0.5',
                              group.direction === 'outbound' ? 'items-end' : 'items-start',
                            )}
                          >
                            {group.messages.map((m, idx) => (
                              <MessageBubble
                                key={m.id}
                                message={m}
                                locale={locale}
                                isFirstInGroup={idx === 0}
                                isLastInGroup={idx === group.messages.length - 1}
                              />
                            ))}
                          </ul>
                        )}
                      </li>
                    ))}
                    <li ref={messagesEndRef} aria-hidden="true" />
                  </ul>
                )}
              </div>

              {/* Composer */}
              {isClosed ? (
                <div className="border-t border-surface-border p-3">
                  <Notice tone="info">
                    <span className="inline-flex items-center gap-1.5">
                      <Lock className="h-3.5 w-3.5" aria-hidden="true" />
                      {t('composerClosed')}
                    </span>
                  </Notice>
                </div>
              ) : (
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
                    <Button type="submit" loading={sending} disabled={!draft.trim() || sending}>
                      <Send className="h-3.5 w-3.5" aria-hidden="true" />
                      {sending ? t('sending') : t('send')}
                    </Button>
                  </div>
                </form>
              )}
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

// ─── Message grouping ───

type MessageGroup =
  | { kind: 'day'; day: Date }
  | {
      kind: 'bubbles';
      direction: 'inbound' | 'outbound';
      messages: WhatsAppMessage[];
    };

/**
 * Group messages so consecutive bubbles from the same side stack with no
 * extra spacing, and a "Today / Yesterday / <date>" label appears
 * whenever the wall-clock day changes.
 */
function groupMessages(messages: WhatsAppMessage[]): MessageGroup[] {
  const out: MessageGroup[] = [];
  let lastDay: string | null = null;
  for (const m of messages) {
    const created = new Date(m.createdAt);
    const k = dayKey(created);
    if (k !== lastDay) {
      out.push({ kind: 'day', day: created });
      lastDay = k;
    }
    const last = out[out.length - 1];
    if (last && last.kind === 'bubbles' && last.direction === m.direction) {
      last.messages.push(m);
    } else {
      out.push({ kind: 'bubbles', direction: m.direction, messages: [m] });
    }
  }
  return out;
}

interface MessageBubbleProps {
  message: WhatsAppMessage;
  locale: string;
  isFirstInGroup: boolean;
  isLastInGroup: boolean;
}

function MessageBubble({
  message,
  locale,
  isFirstInGroup,
  isLastInGroup,
}: MessageBubbleProps): JSX.Element {
  const isOutbound = message.direction === 'outbound';
  const created = new Date(message.createdAt);
  return (
    <li className={cn('flex max-w-full', isOutbound ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[85%] px-3 py-2 text-sm shadow-sm sm:max-w-[70%]',
          isOutbound
            ? 'bg-brand-600 text-white'
            : 'border border-surface-border bg-surface-card text-ink-primary',
          // Tail rounding: tighter on the side facing the next bubble in the group.
          isOutbound
            ? cn(
                'rounded-l-lg',
                isFirstInGroup ? 'rounded-tr-lg' : 'rounded-tr-sm',
                isLastInGroup ? 'rounded-br-lg' : 'rounded-br-sm',
              )
            : cn(
                'rounded-r-lg',
                isFirstInGroup ? 'rounded-tl-lg' : 'rounded-tl-sm',
                isLastInGroup ? 'rounded-bl-lg' : 'rounded-bl-sm',
              ),
        )}
      >
        <p className="whitespace-pre-wrap break-words">{message.text}</p>
        {isLastInGroup ? (
          <p
            className={cn(
              'mt-1 text-end text-[11px]',
              isOutbound ? 'text-white/70' : 'text-ink-tertiary',
            )}
            title={created.toLocaleString(locale)}
          >
            {formatTimeOfDay(created, locale)}
          </p>
        ) : null}
      </div>
    </li>
  );
}
