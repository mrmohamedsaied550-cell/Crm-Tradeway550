'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  ArrowRightLeft,
  CheckCircle2,
  ChevronUp,
  Clock,
  ExternalLink,
  XCircle,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { ApiError, leadReviewsApi } from '@/lib/api';
import type { LeadReviewResolution, LeadReviewRow } from '@/lib/api-types';
import { cn } from '@/lib/utils';

import { ResolveLeadReviewModal } from './resolve-lead-review-modal';

/**
 * Phase D3 — D3.6: single review card on the TL Review Queue page.
 *
 * Mirrors the D1.5 `ReviewCard` UX: a decision-card per row with
 * lead context + reason explanation + four resolution buttons
 * (Rotate / Keep owner / Escalate / Dismiss). The Rotate path
 * deep-links to the lead detail (where the existing
 * `RotateLeadModal` lives) — the queue card doesn't embed a
 * rotation modal of its own; one rotation flow, one source of
 * truth.
 *
 * `canResolve` is the parent's read of `lead.review.resolve`. When
 * false, the action buttons are hidden (read-only view) but the
 * card is still rendered so a TL/auditor without resolve perms can
 * inspect the queue.
 */
export function LeadReviewCard({
  review,
  canResolve,
  onResolved,
}: {
  review: LeadReviewRow;
  canResolve: boolean;
  onResolved: () => void;
}): JSX.Element {
  const t = useTranslations('admin.leadReviews');
  const { toast } = useToast();

  const [pendingResolution, setPendingResolution] = useState<LeadReviewResolution | null>(null);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const reasonLabel = t(`reason.${review.reason}` as 'reason.sla_breach_repeat');
  const reasonExplain = t(`reasonExplain.${review.reason}` as 'reasonExplain.sla_breach_repeat');
  const isResolved = review.resolvedAt !== null;
  const partnerContext = readPartnerContext(review.reasonPayload);

  async function onConfirm(notes?: string): Promise<void> {
    if (!pendingResolution) return;
    setSubmitting(true);
    setError(null);
    try {
      await leadReviewsApi.resolve(review.id, {
        resolution: pendingResolution,
        ...(notes && { notes }),
      });
      toast({
        tone: 'success',
        title: t(`resolve.toast.${pendingResolution}` as 'resolve.toast.rotated'),
      });
      setPendingResolution(null);
      onResolved();
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'lead.review.notes_required') {
          setError(t('resolve.errorNotesRequired'));
        } else if (err.code === 'lead.review.already_resolved') {
          setError(t('resolve.errorAlreadyResolved'));
        } else {
          setError(err.message);
        }
      } else {
        setError(String(err));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <article
      className={cn(
        'flex flex-col gap-3 rounded-lg border bg-surface-card p-4 shadow-sm',
        isResolved
          ? 'border-surface-border'
          : review.reason === 'sla_breach_repeat' || review.reason === 'rotation_failed'
            ? 'border-status-warning/40 bg-status-warning/5'
            : 'border-surface-border',
      )}
    >
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <div className="inline-flex items-center gap-2">
            <Badge tone="warning">{reasonLabel}</Badge>
            {review.lead.slaThreshold !== 'ok' ? (
              <Badge tone="breach">{review.lead.slaThreshold}</Badge>
            ) : null}
            {isResolved && review.resolution ? (
              <Badge tone="info">
                {t(`resolution.${review.resolution}` as 'resolution.rotated')}
              </Badge>
            ) : null}
          </div>
          <Link
            href={`/admin/leads/${review.leadId}`}
            className="inline-flex items-center gap-1 text-sm font-medium text-brand-700 hover:underline"
          >
            {review.lead.name}
            <ExternalLink className="h-3 w-3" aria-hidden="true" />
          </Link>
          <p className="text-xs text-ink-tertiary">
            {review.lead.phone} · {review.lead.stage.name}
            {review.lead.assignedTo ? ` · ${review.lead.assignedTo.name}` : ''}
          </p>
        </div>
        <span className="inline-flex items-center gap-1 text-[11px] text-ink-tertiary">
          <Clock className="h-3 w-3" aria-hidden="true" />
          {new Date(review.createdAt).toLocaleString()}
        </span>
      </header>

      <p className="text-sm text-ink-secondary">{reasonExplain}</p>

      {partnerContext ? (
        <dl className="grid grid-cols-1 gap-2 rounded-md border border-surface-border bg-surface px-3 py-2 sm:grid-cols-2">
          <div className="sm:col-span-2 inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-ink-tertiary">
            {t('partnerContext.header')}
          </div>
          {partnerContext.partnerSourceId ? (
            <PartnerContextField
              label={t('partnerContext.source')}
              value={partnerContext.partnerSourceId}
              mono
            />
          ) : null}
          {partnerContext.category ? (
            <PartnerContextField
              label={t('partnerContext.category')}
              value={t(`reason.${partnerContext.category}` as 'reason.partner_missing')}
            />
          ) : null}
          {partnerContext.partnerStatus ? (
            <PartnerContextField
              label={t('partnerContext.partnerStatus')}
              value={partnerContext.partnerStatus}
            />
          ) : null}
          {partnerContext.partnerActiveDate ? (
            <PartnerContextField
              label={t('partnerContext.partnerActiveDate')}
              value={formatDateMaybe(partnerContext.partnerActiveDate)}
            />
          ) : null}
          {partnerContext.partnerDftDate ? (
            <PartnerContextField
              label={t('partnerContext.partnerDftDate')}
              value={formatDateMaybe(partnerContext.partnerDftDate)}
            />
          ) : null}
          {partnerContext.partnerTripCount !== undefined ? (
            <PartnerContextField
              label={t('partnerContext.partnerTripCount')}
              value={String(partnerContext.partnerTripCount)}
            />
          ) : null}
          {partnerContext.crmTripCount !== undefined ? (
            <PartnerContextField
              label={t('partnerContext.crmTripCount')}
              value={String(partnerContext.crmTripCount)}
            />
          ) : null}
          {partnerContext.captainActivatedAt ? (
            <PartnerContextField
              label={t('partnerContext.captainActivatedAt')}
              value={formatDateMaybe(partnerContext.captainActivatedAt)}
            />
          ) : null}
          {partnerContext.captainDftAt ? (
            <PartnerContextField
              label={t('partnerContext.captainDftAt')}
              value={formatDateMaybe(partnerContext.captainDftAt)}
            />
          ) : null}
        </dl>
      ) : null}

      {isResolved && review.resolutionNotes ? (
        <p className="rounded-md bg-surface px-3 py-2 text-xs text-ink-secondary">
          <span className="font-medium text-ink-primary">{t('notesPrefix')}:</span>{' '}
          {review.resolutionNotes}
          {review.resolvedBy ? (
            <span className="ms-2 text-ink-tertiary">— {review.resolvedBy.name}</span>
          ) : null}
        </p>
      ) : null}

      {!isResolved && canResolve ? (
        <div className="flex flex-wrap gap-2">
          {/* Rotate is a deep-link — the rotation lives on lead detail. */}
          <Link href={`/admin/leads/${review.leadId}`}>
            <Button variant="primary" size="sm">
              <ArrowRightLeft className="h-3.5 w-3.5" aria-hidden="true" />
              {t('actions.rotate')}
            </Button>
          </Link>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setError(null);
              setPendingResolution('rotated');
            }}
          >
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
            {t('actions.markRotated')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setError(null);
              setPendingResolution('kept_owner');
            }}
          >
            {t('actions.keepOwner')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setError(null);
              setPendingResolution('escalated');
            }}
          >
            <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
            {t('actions.escalate')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setError(null);
              setPendingResolution('dismissed');
            }}
          >
            <XCircle className="h-3.5 w-3.5" aria-hidden="true" />
            {t('actions.dismiss')}
          </Button>
        </div>
      ) : null}

      <ResolveLeadReviewModal
        open={pendingResolution !== null}
        resolution={pendingResolution ?? 'dismissed'}
        submitting={submitting}
        error={error}
        onConfirm={onConfirm}
        onClose={() => setPendingResolution(null)}
      />
    </article>
  );
}

interface PartnerContext {
  partnerSourceId?: string;
  partnerRecordId?: string;
  category?: string;
  partnerStatus?: string;
  partnerActiveDate?: string;
  partnerDftDate?: string;
  partnerTripCount?: number;
  crmTripCount?: number;
  captainActivatedAt?: string;
  captainDftAt?: string;
}

/**
 * D4.8 — extract partner-context fields from a LeadReview's
 * `reasonPayload`. Returns null when the payload doesn't carry a
 * partner reference (non-partner reasons + legacy rows). Treats
 * unexpected shapes defensively — partner context is best-effort
 * decoration, never a render blocker.
 */
function readPartnerContext(payload: Record<string, unknown> | null): PartnerContext | null {
  if (!payload || typeof payload !== 'object') return null;
  const sourceId = stringOrUndef(payload['partnerSourceId']);
  if (!sourceId) return null;
  return {
    partnerSourceId: sourceId,
    partnerRecordId: stringOrUndef(payload['partnerRecordId']),
    category: stringOrUndef(payload['category']),
    partnerStatus: stringOrUndef(payload['partnerStatus']),
    partnerActiveDate: stringOrUndef(payload['partnerActiveDate']),
    partnerDftDate: stringOrUndef(payload['partnerDftDate']),
    partnerTripCount: numberOrUndef(payload['partnerTripCount']),
    crmTripCount: numberOrUndef(payload['crmTripCount']),
    captainActivatedAt: stringOrUndef(payload['captainActivatedAt']),
    captainDftAt: stringOrUndef(payload['captainDftAt']),
  };
}

function stringOrUndef(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function numberOrUndef(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function formatDateMaybe(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

function PartnerContextField({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}): JSX.Element {
  return (
    <div className="flex flex-col">
      <dt className="text-[11px] uppercase tracking-wide text-ink-tertiary">{label}</dt>
      <dd className={cn('text-sm text-ink-primary', mono && 'font-mono text-xs break-all')}>
        {value}
      </dd>
    </div>
  );
}
