'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Clock, ExternalLink, Link2, Phone, User } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { ApiError, usersApi } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { WhatsAppConversation } from '@/lib/api-types';

/**
 * D1.4 — Linked-lead card.
 *
 * Renders the lead snippet that the conversation detail include
 * already returns. The card answers, at a glance:
 *   - Who is this lead? (name + phone)
 *   - Where in the pipeline? (stage badge + lifecycle badge)
 *   - When is the next agent action due? (nextActionDueAt)
 *   - What's the SLA posture? (slaStatus)
 *   - Does the conversation owner match the lead owner? (mismatch banner)
 *   - How do I open the full lead file? (Open lead CTA)
 *
 * Empty state: when the conversation has no leadId, the card
 * renders a "no lead linked" copy plus the optional "Link lead"
 * CTA gated on capability.
 *
 * Out-of-scope state: when the conversation has a leadId but the
 * embedded lead is missing (server hides it via RLS), we show a
 * neutral "Linked lead is not available in your scope" notice
 * instead of a technical error — a TL who reassigned the
 * conversation across teams may legitimately lose the lead view.
 */
export function LeadCard({
  conversation,
  canLinkLead,
  onOpenLink,
  onAddNote,
  canAddNote,
}: {
  conversation: WhatsAppConversation;
  /** True when the actor has `whatsapp.link.lead`. */
  canLinkLead: boolean;
  /** Called when the operator clicks the "Link lead" empty-state button. */
  onOpenLink: () => void;
  /** Called when the operator clicks "Add note" — only meaningful
   *  when there is a linked lead. */
  onAddNote: () => void;
  /** True when the actor has `lead.activity.write`. */
  canAddNote: boolean;
}): JSX.Element {
  const t = useTranslations('admin.whatsapp.sidePanel.lead');
  const lead = conversation.lead ?? null;
  const leadId = conversation.leadId ?? null;
  const ownerMismatch =
    Boolean(conversation.assignedToId) &&
    Boolean(lead?.assignedToId) &&
    conversation.assignedToId !== lead?.assignedToId;

  // D1.6 — show the lead owner's name when it's available. The
  // conversation include doesn't carry it (the embedded
  // `ConversationLeadSummary` has only `assignedToId`), but a
  // single small `usersApi.get(id)` lookup gives us the cleaned
  // name. Optimisation: skip the call when the lead has no
  // assignee, OR when the lead owner is the same as the
  // conversation owner (in which case we already know the name
  // from `conversation.assignedTo`).
  const leadAssignedToId = lead?.assignedToId ?? null;
  const sameOwner = leadAssignedToId !== null && leadAssignedToId === conversation.assignedToId;
  const knownConvoName = conversation.assignedTo?.name ?? null;
  const [leadOwnerName, setLeadOwnerName] = useState<string | null>(
    sameOwner ? knownConvoName : null,
  );

  useEffect(() => {
    if (!leadAssignedToId) {
      setLeadOwnerName(null);
      return;
    }
    if (sameOwner && knownConvoName) {
      setLeadOwnerName(knownConvoName);
      return;
    }
    let cancelled = false;
    usersApi
      .get(leadAssignedToId)
      .then((u) => {
        if (cancelled) return;
        setLeadOwnerName(u.name);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // Out-of-scope user surfaces as 404 — leave the name null
        // and fall back to the generic mismatch copy.
        if (!(err instanceof ApiError && err.status === 404)) {
          // network / other errors are also non-fatal here.
        }
      });
    return () => {
      cancelled = true;
    };
  }, [leadAssignedToId, sameOwner, knownConvoName]);

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-surface-border bg-surface-card p-3 shadow-sm">
      <header className="flex items-center justify-between gap-2">
        <h3 className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-tertiary">
          <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
          {t('title')}
        </h3>
      </header>

      {!leadId ? (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-ink-tertiary">{t('notLinked')}</p>
          {canLinkLead ? (
            <Button variant="secondary" size="sm" onClick={onOpenLink}>
              {t('linkCta')}
            </Button>
          ) : (
            <p className="text-[11px] italic text-ink-tertiary">{t('linkLockedHint')}</p>
          )}
        </div>
      ) : !lead ? (
        // Lead id present but row is filtered out of scope.
        <Notice tone="info">{t('outOfScope')}</Notice>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium text-ink-primary">{lead.name}</span>
            <span className="inline-flex items-center gap-1 font-mono text-xs text-ink-tertiary">
              <Phone className="h-3 w-3" aria-hidden="true" />
              {lead.phone}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {/* D1.6 — stage uses the quiet `neutral` tone so the
                colored lifecycle / SLA chips next to it stand out
                instead of competing with another blue pill. */}
            {lead.stage ? <Badge tone="neutral">{lead.stage.name}</Badge> : null}
            <Badge tone={lifecycleTone(lead.lifecycleState)}>
              {t(`lifecycle.${lead.lifecycleState}` as 'lifecycle.open')}
            </Badge>
            {lead.slaStatus && lead.slaStatus !== 'active' ? (
              <Badge tone={slaTone(lead.slaStatus)}>
                {t(`sla.${lead.slaStatus}` as 'sla.breached')}
              </Badge>
            ) : null}
          </div>

          {lead.nextActionDueAt ? (
            <p
              className={cn(
                'inline-flex items-center gap-1 text-xs',
                isOverdue(lead.nextActionDueAt) ? 'text-status-breach' : 'text-ink-secondary',
              )}
            >
              <Clock className="h-3 w-3" aria-hidden="true" />
              {t('nextActionDue', { time: formatRelativeOrAbsolute(lead.nextActionDueAt) })}
            </p>
          ) : null}

          {leadAssignedToId ? (
            <p className="inline-flex items-center gap-1 text-xs text-ink-secondary">
              <User className="h-3 w-3" aria-hidden="true" />
              {t('ownedBy', { name: leadOwnerName ?? t('unknownOwner') })}
            </p>
          ) : (
            <p className="inline-flex items-center gap-1 text-xs italic text-ink-tertiary">
              <User className="h-3 w-3" aria-hidden="true" />
              {t('unassigned')}
            </p>
          )}

          {ownerMismatch ? (
            <div
              role="status"
              className="flex items-start gap-2 rounded-md border border-status-warning/40 bg-status-warning/10 px-2.5 py-2 text-xs text-status-warning"
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>
                {leadOwnerName
                  ? t('ownerMismatchNamed', {
                      leadOwner: leadOwnerName,
                      convoOwner: knownConvoName ?? t('unknownOwner'),
                    })
                  : t('ownerMismatch')}
              </span>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <Link
              href={`/admin/leads/${lead.id}`}
              className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-surface-border bg-surface-card px-3 text-xs font-medium text-ink-primary transition-colors hover:border-brand-200 hover:bg-brand-50"
            >
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              {t('openCta')}
            </Link>
            {canAddNote ? (
              <Button variant="secondary" size="sm" onClick={onAddNote}>
                {t('addNoteCta')}
              </Button>
            ) : null}
          </div>
        </div>
      )}
    </section>
  );
}

function lifecycleTone(state: string): 'healthy' | 'breach' | 'inactive' | 'info' {
  if (state === 'won') return 'healthy';
  if (state === 'lost') return 'breach';
  if (state === 'archived') return 'inactive';
  return 'info';
}

function slaTone(slaStatus: string): 'breach' | 'inactive' {
  if (slaStatus === 'breached') return 'breach';
  return 'inactive';
}

function isOverdue(iso: string): boolean {
  return new Date(iso).getTime() < Date.now();
}

function formatRelativeOrAbsolute(iso: string): string {
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return iso;
  const diffMs = ts - Date.now();
  const absHours = Math.abs(diffMs) / (60 * 60 * 1000);
  if (absHours < 24) {
    const sign = diffMs >= 0 ? '+' : '-';
    const hours = Math.floor(Math.abs(diffMs) / (60 * 60 * 1000));
    const minutes = Math.floor((Math.abs(diffMs) % (60 * 60 * 1000)) / (60 * 1000));
    return `${sign}${hours}h ${minutes}m`;
  }
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}
