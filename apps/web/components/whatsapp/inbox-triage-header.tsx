'use client';

import { useTranslations } from 'next-intl';
import {
  AlertCircle,
  CheckCircle2,
  CircleSlash,
  Clock,
  Inbox,
  Link2,
  Link2Off,
  MessageSquareWarning,
  User,
} from 'lucide-react';

import type { LucideIcon } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { ConversationInboxSummary, ConversationQueue } from '@/lib/api';

/**
 * Sprint 14 (D14) — WhatsApp Inbox triage header.
 *
 * Two stacked rows: a KPI strip and a queue chip strip. Both drive the
 * same backend `queue` filter on `GET /conversations` so clicking a
 * card and clicking a chip are interchangeable. The summary counts
 * come from `GET /conversations/summary`, which is scope-aware (every
 * count reflects only what the current operator can already see in
 * the list endpoint).
 *
 * Behavioural rules:
 *   - Clicking a KPI card toggles the matching queue on/off.
 *   - The "Failed" card is intentionally disabled with a gap title.
 *     Message-level `status='failed'` exists, but there's no aggregate
 *     conversation-level failure projection yet — surfacing it as a
 *     selectable queue would lie about what the backend supports.
 *   - When `summary` is null we render skeleton dashes instead of
 *     fake zeros, so the operator can tell load failure apart from
 *     real empty state.
 *
 * Accessibility:
 *   - The chip row is a single `role="tablist"`; the active queue
 *     receives `aria-selected="true"`. Disabled chips set
 *     `aria-disabled="true"` and keep keyboard focus skip-able.
 */

type Queue = ConversationQueue | null;

interface InboxTriageHeaderProps {
  summary: ConversationInboxSummary | null;
  selectedQueue: Queue;
  onQueueChange: (queue: Queue) => void;
  loading?: boolean;
}

interface CardSpec {
  queue: Queue;
  labelKey: string;
  valueKey: keyof ConversationInboxSummary;
  Icon: LucideIcon;
  /** Tailwind colour group applied when the chip is active. */
  tone: 'sky' | 'amber' | 'indigo' | 'emerald' | 'rose' | 'neutral';
  /** When true the card stays disabled with a gap subtitle. */
  disabled?: boolean;
  disabledKey?: string;
}

const CARDS: readonly CardSpec[] = [
  { queue: null, labelKey: 'queue.all', valueKey: 'open', Icon: Inbox, tone: 'neutral' },
  {
    queue: 'unassigned',
    labelKey: 'queue.unassigned',
    valueKey: 'unassigned',
    Icon: AlertCircle,
    tone: 'amber',
  },
  { queue: 'mine', labelKey: 'queue.mine', valueKey: 'mine', Icon: User, tone: 'indigo' },
  {
    queue: 'waiting_reply',
    labelKey: 'queue.waitingReply',
    valueKey: 'waitingReply',
    Icon: Clock,
    tone: 'amber',
  },
  {
    queue: 'needs_review',
    labelKey: 'queue.needsReview',
    valueKey: 'needsReview',
    Icon: MessageSquareWarning,
    tone: 'rose',
  },
  { queue: 'linked', labelKey: 'queue.linked', valueKey: 'linked', Icon: Link2, tone: 'emerald' },
  {
    queue: 'unlinked',
    labelKey: 'queue.unlinked',
    valueKey: 'unlinked',
    Icon: Link2Off,
    tone: 'neutral',
  },
  { queue: 'today', labelKey: 'queue.today', valueKey: 'today', Icon: CheckCircle2, tone: 'sky' },
  // Disabled — message-level failed status exists but no
  // conversation-level aggregate. Surfaced as a visible gap.
  {
    queue: null,
    labelKey: 'queue.failed',
    valueKey: 'open',
    Icon: CircleSlash,
    tone: 'neutral',
    disabled: true,
    disabledKey: 'queue.failedGap',
  },
] as const;

const TONE_BASE: Record<CardSpec['tone'], string> = {
  sky: 'border-sky-300 bg-sky-50 text-sky-700',
  amber: 'border-amber-300 bg-amber-50 text-amber-800',
  indigo: 'border-indigo-300 bg-indigo-50 text-indigo-700',
  emerald: 'border-emerald-300 bg-emerald-50 text-emerald-700',
  rose: 'border-rose-300 bg-rose-50 text-rose-700',
  neutral: 'border-surface-border bg-surface-muted text-ink-secondary',
};

export function InboxTriageHeader({
  summary,
  selectedQueue,
  onQueueChange,
  loading,
}: InboxTriageHeaderProps): JSX.Element {
  const t = useTranslations('admin.whatsapp');

  function valueFor(card: CardSpec): string {
    if (!summary) return loading ? '…' : '—';
    return String(summary[card.valueKey]);
  }

  return (
    <section
      aria-label={t('triage.label')}
      className="rounded-lg border border-surface-border bg-surface-card p-3 shadow-card"
    >
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-5 lg:grid-cols-9">
        {CARDS.map((card) => {
          const isActive = !card.disabled && card.queue === selectedQueue;
          const ariaDisabled = card.disabled ? true : undefined;
          return (
            <button
              key={`${card.queue ?? 'all'}-${card.labelKey}`}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-disabled={ariaDisabled}
              disabled={card.disabled}
              onClick={() => {
                if (card.disabled) return;
                onQueueChange(isActive ? null : card.queue);
              }}
              title={card.disabled && card.disabledKey ? t(card.disabledKey) : undefined}
              className={cn(
                'flex flex-col items-start gap-1 rounded-md border px-3 py-2 text-left transition',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary/40',
                card.disabled
                  ? 'cursor-not-allowed border-dashed border-surface-border bg-surface-muted text-ink-tertiary opacity-60'
                  : isActive
                    ? TONE_BASE[card.tone]
                    : 'border-surface-border bg-surface-card hover:bg-surface-muted',
              )}
            >
              <div className="flex w-full items-center justify-between gap-2 text-xs font-medium">
                <span className="inline-flex items-center gap-1">
                  <card.Icon className="h-3.5 w-3.5" aria-hidden />
                  {t(card.labelKey)}
                </span>
              </div>
              <span className="text-xl font-semibold tabular-nums text-ink-primary">
                {valueFor(card)}
              </span>
              {card.disabled && card.disabledKey ? (
                <span className="text-[10px] uppercase tracking-wide text-ink-tertiary">
                  {t('triage.gapPill')}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </section>
  );
}
