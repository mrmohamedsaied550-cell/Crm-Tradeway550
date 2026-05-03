'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, Plus } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Notice } from '@/components/ui/notice';
import { ApiError, leadsApi } from '@/lib/api';
import type { AdminUser, Lead, LeadSource, SlaStatus } from '@/lib/api-types';
import { cn } from '@/lib/utils';

/**
 * Phase 1 — K1.3: Kanban board for the lead workspace.
 *
 * Renders one column per stage of the active pipeline using the
 * server-grouped GET /leads/by-stage endpoint. The same filter set
 * the list view uses is passed through, so the toggle between List
 * and Kanban is purely a presentation choice — both views see the
 * same leads.
 *
 * Drag-and-drop lands in K1.4. K1.3 ships static columns: cards
 * still show stage transitions when re-fetched after a list-view
 * move, but you can't move them from the board itself yet.
 *
 * Quick actions, SLA indicators, and detail drawer are deliberately
 * NOT here — those land in Phase 2.
 */

export interface KanbanFilters {
  pipelineId: string;
  companyId?: string;
  countryId?: string;
  assignedToId?: string;
  q?: string;
  source?: LeadSource;
  slaStatus?: SlaStatus;
  createdFrom?: string;
  createdTo?: string;
  unassigned?: boolean;
  hasOverdueFollowup?: boolean;
}

interface KanbanBoardProps {
  filters: KanbanFilters;
  /** Used to render assignee initials on cards. */
  users: readonly AdminUser[];
  /** Open the create-lead modal — wired by the parent. */
  onCreate?: () => void;
}

interface StageBucket {
  stage: { id: string; code: string; name: string; order: number; isTerminal: boolean };
  totalCount: number;
  leads: Lead[];
}

const PER_STAGE = 50;

export function KanbanBoard({ filters, users, onCreate }: KanbanBoardProps): JSX.Element {
  const t = useTranslations('admin.leads.kanban');
  const tCommon = useTranslations('admin.common');

  const [buckets, setBuckets] = useState<StageBucket[] | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const userById = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const r = await leadsApi.listByStage({ ...filters, perStage: PER_STAGE });
      setBuckets(r.stages);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (error) {
    return (
      <Notice tone="error">
        <div className="flex items-start justify-between gap-3">
          <span>{error}</span>
          <Button variant="ghost" size="sm" onClick={() => void reload()}>
            {tCommon('retry')}
          </Button>
        </div>
      </Notice>
    );
  }

  // First-load skeleton: render four placeholder columns. The width
  // approximates the real columns so the layout doesn't reflow when
  // data arrives.
  if (loading && buckets === null) {
    return (
      <div className="flex gap-3 overflow-x-auto pb-2">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="flex h-[480px] w-72 shrink-0 animate-pulse flex-col gap-2 rounded-lg border border-surface-border bg-surface-card p-3 shadow-card"
            aria-hidden="true"
          >
            <div className="h-4 w-1/2 rounded bg-surface-border/60" />
            <div className="h-2 w-1/3 rounded bg-surface-border/60" />
            <div className="mt-2 h-20 rounded bg-surface-border/40" />
            <div className="h-20 rounded bg-surface-border/40" />
            <div className="h-20 rounded bg-surface-border/40" />
          </div>
        ))}
      </div>
    );
  }

  if (!buckets || buckets.length === 0) {
    return (
      <EmptyState
        title={t('emptyPipeline')}
        body={t('emptyPipelineHint')}
        action={
          onCreate ? (
            <Button variant="secondary" size="sm" onClick={onCreate}>
              <Plus className="h-4 w-4" />
              {t('newButton')}
            </Button>
          ) : null
        }
      />
    );
  }

  const totalLeads = buckets.reduce((acc, b) => acc + b.totalCount, 0);
  const allColumnsEmpty = totalLeads === 0;

  return (
    <div className="flex flex-col gap-2">
      {/* Soft refresh indicator. The cards stay visible, only opacity dims. */}
      {loading ? (
        <div className="inline-flex items-center gap-1.5 self-end text-xs text-ink-tertiary">
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
          {tCommon('loading')}
        </div>
      ) : null}

      {allColumnsEmpty ? (
        <EmptyState title={t('emptyFiltered')} body={t('emptyFilteredHint')} />
      ) : (
        <div
          className={cn(
            'flex gap-3 overflow-x-auto pb-2 transition-opacity',
            loading ? 'opacity-60' : 'opacity-100',
          )}
        >
          {buckets.map((b) => (
            <KanbanColumn key={b.stage.id} bucket={b} userById={userById} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Column ──────────────────────────────────────────────────────────

interface KanbanColumnProps {
  bucket: StageBucket;
  userById: Map<string, AdminUser>;
}

function KanbanColumn({ bucket, userById }: KanbanColumnProps): JSX.Element {
  const t = useTranslations('admin.leads.kanban');
  const overflow = bucket.totalCount - bucket.leads.length;

  return (
    <section
      aria-label={bucket.stage.name}
      className={cn(
        'flex h-[640px] w-72 shrink-0 flex-col rounded-lg border border-surface-border bg-surface shadow-card',
        bucket.stage.isTerminal ? 'opacity-95' : '',
      )}
    >
      <header className="flex items-center justify-between gap-2 border-b border-surface-border bg-surface-card px-3 py-2">
        <div className="flex min-w-0 flex-col leading-tight">
          <span className="truncate text-sm font-semibold text-ink-primary">
            {bucket.stage.name}
          </span>
          <span className="text-[11px] uppercase tracking-wide text-ink-tertiary">
            {t('cardsTotal', { count: bucket.totalCount })}
          </span>
        </div>
        {bucket.stage.isTerminal ? <Badge tone="inactive">{t('terminal')}</Badge> : null}
      </header>

      <div className="flex-1 overflow-y-auto p-2">
        {bucket.leads.length === 0 ? (
          <div className="flex h-full items-center justify-center px-2 text-center text-xs text-ink-tertiary">
            {t('columnEmpty')}
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {bucket.leads.map((l) => (
              <li key={l.id}>
                <LeadCard
                  lead={l}
                  assignee={l.assignedToId ? userById.get(l.assignedToId) : null}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      {overflow > 0 ? (
        <footer className="border-t border-surface-border bg-surface-card px-3 py-2 text-center text-xs text-ink-tertiary">
          {t('moreInColumn', { count: overflow })}
        </footer>
      ) : null}
    </section>
  );
}

// ─── Card ────────────────────────────────────────────────────────────

interface LeadCardProps {
  lead: Lead;
  assignee: AdminUser | null | undefined;
}

function LeadCard({ lead, assignee }: LeadCardProps): JSX.Element {
  const t = useTranslations('admin.leads.kanban');
  const initials =
    (assignee?.name ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((s) => s[0]!.toUpperCase())
      .join('') || '?';

  return (
    <Link
      href={`/admin/leads/${lead.id}`}
      className={cn(
        'block rounded-md border border-surface-border bg-surface-card p-2.5 shadow-sm transition-all',
        'hover:border-brand-200 hover:bg-brand-50/40 hover:shadow-md',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-ink-primary">{lead.name}</div>
          <div className="truncate font-mono text-xs text-ink-tertiary">{lead.phone}</div>
        </div>
        <span
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-100 text-[10px] font-semibold text-brand-700"
          title={assignee?.name ?? t('unassigned')}
          aria-label={assignee?.name ?? t('unassigned')}
        >
          {assignee ? initials : '·'}
        </span>
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-[10px] uppercase tracking-wide text-ink-tertiary">{lead.source}</span>
        <span className="text-[10px] text-ink-tertiary">
          {formatRelative(new Date(lead.createdAt), new Date())}
        </span>
      </div>
    </Link>
  );
}

/**
 * Compact relative-time formatter without bringing in date-fns.
 * Returns at most one unit ("2h ago", "3d ago"). Mirrors the shape
 * used elsewhere in the admin surface so users see consistent
 * timestamps.
 */
function formatRelative(target: Date, now: Date): string {
  const diff = now.getTime() - target.getTime();
  const day = 24 * 60 * 60 * 1000;
  const hour = 60 * 60 * 1000;
  const min = 60 * 1000;
  if (diff > 7 * day) return `${Math.floor(diff / day)}d ago`;
  if (diff > day) return `${Math.floor(diff / day)}d ago`;
  if (diff > hour) return `${Math.floor(diff / hour)}h ago`;
  if (diff > min) return `${Math.floor(diff / min)}m ago`;
  return 'just now';
}
