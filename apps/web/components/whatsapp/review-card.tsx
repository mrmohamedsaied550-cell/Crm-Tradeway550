'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import {
  AlertTriangle,
  Clock,
  ExternalLink,
  MessageSquare,
  ShieldCheck,
  UserPlus,
  X,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { timeAgo } from '@/lib/whatsapp';
import type { ReviewReason, ReviewResolution, WhatsAppConversationReview } from '@/lib/api-types';

import { ResolveReviewModal } from './resolve-review-modal';
import { ReviewCandidateCaptain } from './review-candidate-captain';
import { ReviewCandidateLead } from './review-candidate-lead';

/**
 * D1.5 — single review card.
 *
 * Layout reads top-down:
 *   1. Reason pill + plain-language explanation.
 *   2. Identity row — contact display name (or phone), phone,
 *      created-relative-time, conversation status / "Open thread"
 *      deep link.
 *   3. Latest 1–2 inbound message snippets from contextSnapshot —
 *      gives the operator the words the customer used so they can
 *      decide quickly. Never renders raw JSON.
 *   4. Candidate cards — for `duplicate_lead` we show up to 3 lead
 *      candidates with an expand-all toggle when there are more;
 *      for `captain_active` we show the candidate captain with a
 *      "Confirm captain" button. `unmatched_after_routing` has no
 *      candidates and goes straight to the bottom-row actions.
 *   5. Action row — reason-specific buttons. Read-only mode hides
 *      the buttons and replaces them with a small italic notice.
 */
export function ReviewCard({
  review,
  canResolve,
  onResolved,
}: {
  review: WhatsAppConversationReview;
  /** True when the actor has whatsapp.review.resolve. False
   *  flips the card to read-only. */
  canResolve: boolean;
  /** Called after a successful resolution; the parent list reloads. */
  onResolved: () => void;
}): JSX.Element {
  const t = useTranslations('admin.whatsappReviews');
  const [expanded, setExpanded] = useState<boolean>(false);
  const [pendingResolution, setPendingResolution] = useState<{
    resolution: ReviewResolution;
    leadId?: string | null;
  } | null>(null);

  const conversation = review.conversation;
  const contact = review.contact;
  const ago = timeAgo(review.createdAt);
  const displayName = contact?.displayName ?? conversation?.phone ?? review.id.slice(0, 8);
  const phone = contact?.phone ?? conversation?.phone ?? '';

  // Pluck the most recent 2 inbound snippets (already serialised by
  // the backend into safe { text, createdAt } entries).
  const snapshot = review.contextSnapshot ?? [];
  const recentMessages = snapshot.slice(-2);

  const candidateLeads = review.candidateLeadIds ?? [];
  const candidateCaptainId = review.candidateCaptainId ?? null;
  const VISIBLE_CAP = 3;
  const visibleLeads = expanded ? candidateLeads : candidateLeads.slice(0, VISIBLE_CAP);
  const hiddenCount = Math.max(0, candidateLeads.length - VISIBLE_CAP);

  const isResolved = review.resolvedAt !== null;

  function openResolve(resolution: ReviewResolution, leadId?: string | null): void {
    setPendingResolution({ resolution, ...(leadId !== undefined && { leadId }) });
  }

  return (
    <article
      className={cn(
        'flex flex-col gap-3 rounded-lg border bg-surface-card p-4 shadow-sm',
        REASON_BORDER[review.reason] ?? 'border-surface-border',
      )}
    >
      {/* 1. Reason + plain-language explanation */}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <Badge tone={REASON_TONE[review.reason]}>
              {t(`reason.${review.reason}` as 'reason.captain_active')}
            </Badge>
            {isResolved ? (
              <Badge tone="inactive">
                {t(
                  `resolutionLabel.${review.resolution ?? 'dismissed'}` as 'resolutionLabel.dismissed',
                )}
              </Badge>
            ) : null}
          </div>
          <p className="text-xs text-ink-secondary">
            {t(`reasonExplain.${review.reason}` as 'reasonExplain.captain_active')}
          </p>
        </div>
        <span className="inline-flex items-center gap-1 text-[11px] text-ink-tertiary">
          <Clock className="h-3 w-3" aria-hidden="true" />
          {ago.unit === 'now' ? t('time.now') : t(`time.${ago.unit}` as 'time.m', { n: ago.value })}
        </span>
      </div>

      {/* 2. Identity row */}
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex flex-col">
          <span className="text-sm font-medium text-ink-primary">{displayName}</span>
          {phone ? <span className="font-mono text-xs text-ink-tertiary">{phone}</span> : null}
        </div>
        {conversation ? (
          <Link
            href={`/admin/whatsapp?selected=${conversation.id}`}
            className="inline-flex items-center gap-1 text-xs text-ink-secondary hover:text-brand-700"
          >
            <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
            {t('openThread')}
            <ExternalLink className="h-3 w-3" aria-hidden="true" />
          </Link>
        ) : null}
      </div>

      {/* 3. Recent context snippets */}
      {recentMessages.length > 0 ? (
        <div className="flex flex-col gap-1.5 rounded-md border border-surface-border bg-surface px-3 py-2">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-tertiary">
            {t('recentMessages')}
          </p>
          {recentMessages.map((m, i) => (
            <p key={`${m.createdAt}-${i}`} className="text-xs text-ink-secondary">
              <span className="line-clamp-2">{m.text}</span>
            </p>
          ))}
        </div>
      ) : null}

      {/* 4. Candidates */}
      {review.reason === 'captain_active' && candidateCaptainId ? (
        <ReviewCandidateCaptain captainId={candidateCaptainId} />
      ) : null}

      {review.reason === 'duplicate_lead' && candidateLeads.length > 0 ? (
        <div className="flex flex-col gap-2">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-tertiary">
            {t('candidateLeads', { n: candidateLeads.length })}
          </p>
          <ul className="flex flex-col gap-1.5">
            {visibleLeads.map((id) => (
              <li key={id}>
                <ReviewCandidateLead
                  leadId={id}
                  selected={
                    pendingResolution?.resolution === 'linked_to_lead' &&
                    pendingResolution?.leadId === id
                  }
                  onSelect={() => canResolve && openResolve('linked_to_lead', id)}
                  selectable={canResolve && !isResolved}
                />
              </li>
            ))}
          </ul>
          {hiddenCount > 0 && !expanded ? (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="self-start text-xs text-brand-700 hover:underline"
            >
              {t('showMoreCandidates', { n: hiddenCount })}
            </button>
          ) : null}
        </div>
      ) : null}

      {/* 5. Action row — reason-specific */}
      {!isResolved && canResolve ? (
        <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
          {review.reason === 'captain_active' && candidateCaptainId ? (
            <Button size="sm" onClick={() => openResolve('linked_to_captain')}>
              <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
              {t('action.linkToCaptain')}
            </Button>
          ) : null}
          {review.reason === 'duplicate_lead' || review.reason === 'unmatched_after_routing' ? (
            <Button size="sm" onClick={() => openResolve('new_lead')}>
              <UserPlus className="h-3.5 w-3.5" aria-hidden="true" />
              {t('action.createNewLead')}
            </Button>
          ) : null}
          <Button variant="secondary" size="sm" onClick={() => openResolve('dismissed')}>
            <X className="h-3.5 w-3.5" aria-hidden="true" />
            {t('action.dismiss')}
          </Button>
        </div>
      ) : null}

      {!isResolved && !canResolve ? (
        <div className="flex items-start gap-2 rounded-md border border-surface-border bg-surface px-3 py-2 text-[11px] text-ink-tertiary">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
          <span>{t('readOnlyHint')}</span>
        </div>
      ) : null}

      {pendingResolution ? (
        <ResolveReviewModal
          open
          reviewId={review.id}
          resolution={pendingResolution.resolution}
          presetLeadId={pendingResolution.leadId ?? null}
          onClose={() => setPendingResolution(null)}
          onSuccess={() => {
            setPendingResolution(null);
            onResolved();
          }}
        />
      ) : null}
    </article>
  );
}

const REASON_TONE: Record<ReviewReason, 'warning' | 'info' | 'breach'> = {
  captain_active: 'warning',
  duplicate_lead: 'info',
  unmatched_after_routing: 'breach',
};

const REASON_BORDER: Record<ReviewReason, string> = {
  captain_active: 'border-status-warning/40',
  duplicate_lead: 'border-status-info/40',
  unmatched_after_routing: 'border-status-breach/40',
};
