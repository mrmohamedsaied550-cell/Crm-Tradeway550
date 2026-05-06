'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Filter, MessagesSquare, RefreshCw, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Select } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { useToast } from '@/components/ui/toast';
import { AssignConversationModal } from '@/components/whatsapp/assign-conversation-modal';
import { ChatThread } from '@/components/whatsapp/chat-thread';
import {
  ConversationActionMenu,
  type ConversationAction,
} from '@/components/whatsapp/conversation-action-menu';
import { ConversationHeader } from '@/components/whatsapp/conversation-header';
import { ConversationVisibilityBanners } from '@/components/whatsapp/conversation-visibility-banners';
import { ConversationRow } from '@/components/whatsapp/conversation-row';
import {
  ConfirmConversationActionModal,
  type ConfirmableAction,
} from '@/components/whatsapp/confirm-conversation-action-modal';
import { ConversationSidePanel } from '@/components/whatsapp/conversation-side-panel';
import { HandoverConversationModal } from '@/components/whatsapp/handover-conversation-modal';
import { LinkLeadModal } from '@/components/whatsapp/link-lead-modal';
import { SendComposer } from '@/components/whatsapp/send-composer';
import { ApiError, conversationsApi } from '@/lib/api';
import { getCachedMe, hasCapability } from '@/lib/auth';
import type { ConversationStatus, WhatsAppConversation, WhatsAppMessage } from '@/lib/api-types';
import { useRealtime } from '@/lib/realtime';
import { useMediaQuery } from '@/lib/use-media-query';
import { cn } from '@/lib/utils';
import { type InboxFilter, readPreferredFilter, writePreferredFilter } from '@/lib/whatsapp';

/**
 * D1.2 — unified WhatsApp inbox.
 *
 * Replaces the previous read-only `/admin/whatsapp` page AND the
 * separate `/agent/inbox`. One surface for every persona; backend
 * scope and the local Mine/All toggle decide what each operator
 * sees.
 *
 * Layout breakpoints:
 *   - desktop (≥1280px) — three-pane: list / thread / details
 *   - tablet  (768-1279px) — two-pane: list + thread; details
 *     panel slides in as an end-edge drawer when toggled
 *   - mobile  (<768px) — single pane stack:
 *       state 'list'    → conversation list
 *       state 'thread'  → thread + composer (back arrow returns to list)
 *       state 'details' → side panel (back arrow returns to thread)
 *
 * State plumbing is intentionally URL-free — bookmarking a single
 * conversation is a Phase D2 concern; for D1.2 we keep the
 * navigation in component state so a quick return-to-list never
 * loses the just-read context.
 *
 * Action buttons (assign / handover / close / reopen / link /
 * unlink) and the full Contact + Lead side panel land in D1.3 +
 * D1.4. The header has an `actionsSlot` ready for them; the side
 * panel placeholder renders read-only contact + lead summary today.
 */

type MobileView = 'list' | 'thread' | 'details';

export default function WhatsAppInboxPage(): JSX.Element {
  const t = useTranslations('admin.whatsapp');
  const tCommon = useTranslations('admin.common');
  const { toast } = useToast();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const queryParamSelected = searchParams?.get('selected') ?? null;

  const me = getCachedMe();
  const myUserId = me?.userId ?? null;
  const roleCode = me?.roleCode ?? null;
  const canSendText = hasCapability('whatsapp.message.send');
  const canSendMedia = hasCapability('whatsapp.media.send');
  const canSendTemplate = hasCapability('whatsapp.message.send');

  const [filter, setFilter] = useState<InboxFilter>(() => readPreferredFilter(roleCode));
  const [statusFilter, setStatusFilter] = useState<ConversationStatus | ''>('open');
  const [rows, setRows] = useState<WhatsAppConversation[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // D1.6 — `selectedId` is initialised from the `?selected=` query
  // param so deep-links from the Review Queue ("Open thread") jump
  // straight to the conversation. Subsequent navigation keeps the
  // URL in sync via `replace` so the back-button doesn't pile up
  // intermediate selections.
  const [selectedId, setSelectedId] = useState<string | null>(queryParamSelected);
  const [selectedDetail, setSelectedDetail] = useState<WhatsAppConversation | null>(null);
  const [messages, setMessages] = useState<WhatsAppMessage[]>([]);
  const [chatLoading, setChatLoading] = useState<boolean>(false);
  const [sending, setSending] = useState<boolean>(false);
  // D1.6 — when the selected conversation isn't visible to the
  // actor (RLS hides it), we surface an inline "not in your scope"
  // notice in the thread pane instead of the empty-state.
  const [selectedNotFound, setSelectedNotFound] = useState<boolean>(false);
  // D1.6 — bumped every 60 s to force a re-render when a thread
  // sits open across the 24h window's "open → closing_soon →
  // closed" transitions. Used as a child prop so React can
  // memoise the rest of the page.
  const [windowTick, setWindowTick] = useState<number>(0);

  // Layout state — derived from media-queries + a mobile view stack.
  const isMobile = useMediaQuery('(max-width: 767px)');
  const isTabletOrSmaller = useMediaQuery('(max-width: 1279px)');
  const [mobileView, setMobileView] = useState<MobileView>('list');
  const [tabletDetailsOpen, setTabletDetailsOpen] = useState<boolean>(false);

  // D1.3 — modal state for the More Actions menu. Only one is open
  // at a time; opening any closes the dropdown via the action menu's
  // own outside-click handler.
  const [assignOpen, setAssignOpen] = useState<boolean>(false);
  const [handoverOpen, setHandoverOpen] = useState<boolean>(false);
  const [linkLeadOpen, setLinkLeadOpen] = useState<boolean>(false);
  const [confirmAction, setConfirmAction] = useState<ConfirmableAction | null>(null);

  // Persist filter preference whenever it changes.
  useEffect(() => {
    writePreferredFilter(filter);
  }, [filter]);

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const page = await conversationsApi.list({
        ...(statusFilter && { status: statusFilter }),
        limit: 100,
      });
      // The "Mine" filter is a client-side narrow on top of the
      // backend's scope-filtered list. The list endpoint doesn't
      // accept `assignedToId` today; adding it would be a backend
      // change beyond locked D1 scope.
      const filtered =
        filter === 'mine' && myUserId
          ? page.items.filter((c) => c.assignedToId === myUserId)
          : page.items;
      setRows(filtered);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [filter, myUserId, statusFilter]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Refetch the selected conversation detail (with included lead +
  // contact + assignedTo) and its messages when the selection
  // changes or after a write that may have mutated either.
  //
  // D1.6 — a 404 here means the conversation is out of the actor's
  // scope (e.g. deep-linked from a Review Queue item the actor
  // can see but a thread their role can't). We render a clean
  // "not in your scope" notice in the thread pane instead of the
  // empty-state.
  useEffect(() => {
    if (!selectedId) {
      setSelectedDetail(null);
      setMessages([]);
      setSelectedNotFound(false);
      return;
    }
    let cancelled = false;
    setChatLoading(true);
    setSelectedNotFound(false);
    Promise.all([
      conversationsApi.get(selectedId),
      conversationsApi.listMessages(selectedId, { limit: 200 }),
    ])
      .then(([detail, msgs]) => {
        if (cancelled) return;
        setSelectedDetail(detail);
        setMessages(msgs ?? []);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) {
          setSelectedNotFound(true);
          setSelectedDetail(null);
          setMessages([]);
        } else {
          setError(err instanceof ApiError ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) setChatLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  // D1.6 — keep the URL `?selected=` in sync with the in-state
  // `selectedId`. Uses `replace` so back-navigation pops out of
  // the inbox rather than walking through every clicked thread.
  useEffect(() => {
    if (!pathname) return;
    const current = searchParams?.get('selected') ?? null;
    if (current === selectedId) return;
    const next = new URLSearchParams(searchParams?.toString() ?? '');
    if (selectedId) next.set('selected', selectedId);
    else next.delete('selected');
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- searchParams identity changes per render; we only react to selectedId
  }, [selectedId, pathname]);

  // D1.6 — pick up external query-param changes (e.g. the user
  // edits the URL or a deep-link arrives from the Review Queue's
  // "Open thread" action) so the thread pane always tracks
  // `?selected=`. On mobile we also flip `mobileView` to 'thread'
  // so the deep-link lands directly on the conversation rather
  // than on the list with a hidden selection underneath.
  useEffect(() => {
    if (queryParamSelected && queryParamSelected !== selectedId) {
      setSelectedId(queryParamSelected);
      if (isMobile) setMobileView('thread');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional one-way sync
  }, [queryParamSelected]);

  // D1.6 — 24h-window ticker. While a conversation is selected,
  // bump `windowTick` every 60 seconds so `WindowPip` /
  // `SendComposer` re-evaluate `windowState(...)` and roll the
  // thread from `open → closing_soon → closed` while the operator
  // sits on the page. Cleared on unmount and when no conversation
  // is open. The interval doesn't touch the network — it only
  // forces a render of the bits that read `Date.now()`.
  const tickerActiveRef = useRef<boolean>(false);
  useEffect(() => {
    if (!selectedId) {
      tickerActiveRef.current = false;
      return;
    }
    tickerActiveRef.current = true;
    const id = setInterval(() => {
      if (!tickerActiveRef.current) return;
      setWindowTick((n) => n + 1);
    }, 60 * 1000);
    return () => {
      tickerActiveRef.current = false;
      clearInterval(id);
    };
  }, [selectedId]);

  // Realtime: a new inbound bumps the list and refreshes the open
  // thread. Subtle UX rule (per UX plan §U6): the visible thread
  // never auto-switches; only the list refreshes.
  //
  // D1.6 — also re-fetch the selected conversation detail when the
  // event matches it, so `lastInboundAt`, `lastMessageText` and
  // any newly-attached lead/contact roll into the side panel
  // without a manual refresh.
  useRealtime('whatsapp.message', (event) => {
    if (event.type !== 'whatsapp.message') return;
    void reload();
    if (event.conversationId === selectedId) {
      Promise.all([
        conversationsApi.get(event.conversationId),
        conversationsApi.listMessages(event.conversationId, { limit: 200 }),
      ])
        .then(([detail, msgs]) => {
          setSelectedDetail(detail);
          setMessages(msgs ?? []);
        })
        .catch(() => {
          // Silent — a transient failure here just means the next
          // user-initiated refresh will reconcile.
        });
    }
  });

  async function onSendText(text: string): Promise<void> {
    if (!selectedId) return;
    setSending(true);
    try {
      await conversationsApi.sendText(selectedId, text);
      const [detail, msgs] = await Promise.all([
        conversationsApi.get(selectedId),
        conversationsApi.listMessages(selectedId, { limit: 200 }),
      ]);
      setSelectedDetail(detail);
      setMessages(msgs ?? []);
      void reload();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : String(err);
      toast({ tone: 'error', title: t('thread.sendFailed'), body: message });
      throw err;
    } finally {
      setSending(false);
    }
  }

  function selectRow(id: string): void {
    setSelectedId(id);
    if (isMobile) setMobileView('thread');
    if (isTabletOrSmaller) setTabletDetailsOpen(false);
  }

  function openAction(action: ConversationAction): void {
    if (action === 'assign') setAssignOpen(true);
    else if (action === 'handover') setHandoverOpen(true);
    else if (action === 'linkLead') setLinkLeadOpen(true);
    else setConfirmAction(action);
  }

  // After a successful conversation action, refetch the selected
  // detail (owner, status, leadId, contact may have changed) and
  // refresh the list so the row mirrors the new state.
  const refreshAfterAction = useCallback(async (): Promise<void> => {
    setAssignOpen(false);
    setHandoverOpen(false);
    setLinkLeadOpen(false);
    setConfirmAction(null);
    if (!selectedId) {
      void reload();
      return;
    }
    try {
      const [detail, msgs] = await Promise.all([
        conversationsApi.get(selectedId),
        conversationsApi.listMessages(selectedId, { limit: 200 }),
      ]);
      setSelectedDetail(detail);
      setMessages(msgs ?? []);
    } catch {
      // Ignore — the next reload will reconcile if the conversation
      // is now out of scope for the operator (e.g. handover to
      // another team member with no shared scope).
    }
    void reload();
  }, [reload, selectedId]);

  const selectedFromList = useMemo(
    () => rows.find((c) => c.id === selectedId) ?? null,
    [rows, selectedId],
  );
  const selected = selectedDetail ?? selectedFromList;

  // D1.6 — single page-level "now" reference. Re-evaluated each
  // time `windowTick` increments (every 60 s while a conversation
  // is open); threaded into <WindowPip>, <SendComposer> and the
  // side panel so all three roll together. The eslint-disable is
  // intentional: the *change* of `windowTick` IS the dependency
  // that drives the new timestamp; we don't want `Date.now()` to
  // be called inside the memo's deps array.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const now = useMemo(() => Date.now(), [windowTick]);

  // Show the owner badge on rows when the current view is "All in
  // scope" — agents on "Mine" are looking at their own work and
  // don't need the badge.
  const showOwnerOnRow = filter === 'all';

  return (
    <div className="flex flex-col gap-3">
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <div className="w-32">
              <Field label={t('filter.statusLabel')}>
                <Select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value as ConversationStatus | '')}
                >
                  <option value="">{tCommon('all')}</option>
                  <option value="open">{t('status.open')}</option>
                  <option value="closed">{t('status.closed')}</option>
                </Select>
              </Field>
            </div>
            <div
              className="inline-flex overflow-hidden rounded-md border border-surface-border"
              role="tablist"
              aria-label={t('filter.label')}
            >
              <FilterButton
                active={filter === 'mine'}
                onClick={() => setFilter('mine')}
                label={t('filter.mine')}
              />
              <FilterButton
                active={filter === 'all'}
                onClick={() => setFilter('all')}
                label={t('filter.all')}
              />
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void reload()}
              disabled={loading}
              aria-label={t('refresh')}
            >
              <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} aria-hidden="true" />
            </Button>
          </div>
        }
      />

      {error ? <Notice tone="error">{error}</Notice> : null}

      {/* Layout — desktop three-pane / tablet two-pane + drawer / mobile single-pane stack
          D1.6 — bind the grid height to the viewport on md+ so the
          ChatThread's `overflow-y-auto` actually fires and the side
          panel stays in view as the thread scrolls. The
          `calc(100vh-13rem)` budgets ~208 px for the page header,
          filter bar, and outer admin shell padding. Mobile keeps
          its natural flex-col growth so the bottom-sheet flow
          behaves as before. */}
      <div
        className={cn(
          'min-h-[560px] gap-3 md:gap-4',
          'md:h-[calc(100vh-13rem)] md:min-h-[560px]',
          // Desktop ≥1280px → three columns. Tablet 768-1279px →
          // two columns with the drawer overlaying the right side.
          // Mobile <768px → single column controlled by `mobileView`.
          'xl:grid xl:grid-cols-[340px_minmax(0,1fr)_360px]',
          'md:grid md:grid-cols-[340px_minmax(0,1fr)]',
          'flex flex-col',
        )}
      >
        {/* LIST PANE — hidden on mobile when not on `list` view */}
        <section
          className={cn(
            'min-h-0 rounded-lg border border-surface-border bg-surface-card shadow-card',
            'flex flex-col',
            isMobile && mobileView !== 'list' ? 'hidden' : '',
          )}
        >
          <header className="flex items-center justify-between border-b border-surface-border px-3 py-2 text-xs font-medium uppercase tracking-wide text-ink-tertiary">
            <span className="inline-flex items-center gap-1">
              <Filter className="h-3 w-3" aria-hidden="true" />
              {filter === 'mine' ? t('filter.mine') : t('filter.all')}
            </span>
            <span>{t('list.count', { n: rows.length })}</span>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {loading && rows.length === 0 ? (
              <p className="p-6 text-center text-sm text-ink-secondary">{tCommon('loading')}</p>
            ) : rows.length === 0 ? (
              <div className="p-3">
                <EmptyState
                  icon={<MessagesSquare className="h-7 w-7" aria-hidden="true" />}
                  title={filter === 'mine' ? t('list.emptyMineTitle') : t('list.emptyAllTitle')}
                  body={filter === 'mine' ? t('list.emptyMineBody') : t('list.emptyAllBody')}
                  action={
                    filter === 'mine' ? (
                      <Button variant="secondary" size="sm" onClick={() => setFilter('all')}>
                        {t('list.switchToAll')}
                      </Button>
                    ) : null
                  }
                />
              </div>
            ) : (
              <ul className="divide-y divide-surface-border">
                {rows.map((c) => (
                  <li key={c.id}>
                    <ConversationRow
                      conversation={c}
                      selected={selectedId === c.id}
                      onClick={() => selectRow(c.id)}
                      showOwner={showOwnerOnRow}
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        {/* THREAD PANE — hidden on mobile when not on `thread` view */}
        <section
          className={cn(
            'min-h-0 rounded-lg border border-surface-border bg-surface-card shadow-card',
            'flex flex-col',
            isMobile && mobileView !== 'thread' ? 'hidden' : '',
          )}
        >
          {selected ? (
            <>
              <ConversationHeader
                conversation={selected}
                onBack={isMobile ? () => setMobileView('list') : undefined}
                onToggleDetails={
                  isTabletOrSmaller && !isMobile
                    ? () => setTabletDetailsOpen((v) => !v)
                    : isMobile
                      ? () => setMobileView('details')
                      : undefined
                }
                detailsOpen={tabletDetailsOpen}
                actionsSlot={
                  <ConversationActionMenu conversation={selected} onAction={openAction} />
                }
                now={now}
              />
              <ConversationVisibilityBanners conversation={selected} />
              <ChatThread messages={messages} loading={chatLoading} />
              <SendComposer
                conversation={selected}
                canSendText={canSendText}
                canSendMedia={canSendMedia}
                canSendTemplate={canSendTemplate}
                sending={sending}
                onSendText={onSendText}
                onOpenTemplate={() =>
                  toast({ tone: 'info', title: t('compose.templateComingSoon') })
                }
                onOpenMedia={() => toast({ tone: 'info', title: t('compose.mediaComingSoon') })}
                now={now}
              />
            </>
          ) : selectedNotFound ? (
            <div className="flex flex-1 items-center justify-center p-6">
              <EmptyState
                icon={<MessagesSquare className="h-8 w-8" aria-hidden="true" />}
                title={t('thread.notFoundTitle')}
                body={t('thread.notFoundBody')}
                action={
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setSelectedId(null);
                      setSelectedNotFound(false);
                      if (isMobile) setMobileView('list');
                    }}
                  >
                    {t('thread.notFoundCta')}
                  </Button>
                }
              />
            </div>
          ) : (
            <div className="flex flex-1 items-center justify-center p-6">
              <EmptyState
                icon={<MessagesSquare className="h-8 w-8" aria-hidden="true" />}
                title={t('thread.selectTitle')}
                body={t('thread.selectBody')}
              />
            </div>
          )}
        </section>

        {/* DETAILS PANE
              desktop  — always visible as the third column
              tablet   — drawer overlay, open via header toggle
              mobile   — full-screen view when `mobileView === 'details'`
        */}
        {selected ? (
          <>
            {/* Desktop pane (xl:) */}
            <div className="hidden xl:flex xl:min-h-0">
              <ConversationSidePanel
                conversation={selected}
                onOpenLink={() => setLinkLeadOpen(true)}
                onActionSuccess={() => void refreshAfterAction()}
              />
            </div>

            {/* Tablet drawer (md → xl) */}
            {!isMobile && tabletDetailsOpen ? (
              <div className="fixed inset-0 z-30 md:flex xl:hidden">
                <button
                  type="button"
                  className="flex-1 bg-ink-primary/30"
                  onClick={() => setTabletDetailsOpen(false)}
                  aria-label={t('thread.closeDetails')}
                />
                <div className="relative h-full w-[360px] max-w-full bg-surface-card shadow-2xl">
                  <button
                    type="button"
                    onClick={() => setTabletDetailsOpen(false)}
                    className="absolute end-3 top-3 rounded-md p-1 text-ink-secondary hover:bg-brand-50 hover:text-brand-700"
                    aria-label={t('thread.closeDetails')}
                  >
                    <X className="h-4 w-4" aria-hidden="true" />
                  </button>
                  <ConversationSidePanel
                    conversation={selected}
                    onOpenLink={() => setLinkLeadOpen(true)}
                    onActionSuccess={() => void refreshAfterAction()}
                  />
                </div>
              </div>
            ) : null}

            {/* Mobile full-screen */}
            {isMobile && mobileView === 'details' ? (
              <section className="min-h-0 rounded-lg border border-surface-border bg-surface-card shadow-card">
                <header className="flex items-center justify-between border-b border-surface-border px-3 py-2 text-xs font-medium uppercase tracking-wide text-ink-tertiary">
                  <button
                    type="button"
                    onClick={() => setMobileView('thread')}
                    className="rounded-md px-2 py-1 text-ink-secondary hover:bg-brand-50 hover:text-brand-700"
                  >
                    {tCommon('cancel')}
                  </button>
                  <span>{t('sidePanel.title')}</span>
                  <span aria-hidden="true" />
                </header>
                <ConversationSidePanel
                  conversation={selected}
                  onOpenLink={() => setLinkLeadOpen(true)}
                  onActionSuccess={() => void refreshAfterAction()}
                />
              </section>
            ) : null}
          </>
        ) : null}
      </div>

      {/* D1.3 — action modals. Only one is open at a time; the
          ConversationActionMenu owns the trigger surface. */}
      {selected ? (
        <>
          <AssignConversationModal
            open={assignOpen}
            conversation={selected}
            onClose={() => setAssignOpen(false)}
            onSuccess={() => void refreshAfterAction()}
          />
          <HandoverConversationModal
            open={handoverOpen}
            conversation={selected}
            onClose={() => setHandoverOpen(false)}
            onSuccess={() => void refreshAfterAction()}
          />
          <LinkLeadModal
            open={linkLeadOpen}
            conversationId={selected.id}
            onClose={() => setLinkLeadOpen(false)}
            onSuccess={() => void refreshAfterAction()}
          />
          <ConfirmConversationActionModal
            open={confirmAction !== null}
            action={confirmAction ?? 'close'}
            conversationId={selected.id}
            onClose={() => setConfirmAction(null)}
            onSuccess={() => void refreshAfterAction()}
          />
        </>
      ) : null}
    </div>
  );
}

/** Small inline button used by the Mine/All segmented toggle. */
function FilterButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}): JSX.Element {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'px-3 py-1.5 text-sm transition-colors',
        active
          ? 'bg-brand-600 text-white'
          : 'text-ink-secondary hover:bg-brand-50 hover:text-brand-700',
      )}
    >
      {label}
    </button>
  );
}
