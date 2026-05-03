'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, Plus } from 'lucide-react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Notice } from '@/components/ui/notice';
import { useToast } from '@/components/ui/toast';
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
  const { toast } = useToast();

  const [buckets, setBuckets] = useState<StageBucket[] | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  // K1.4 — drag state. `draggingId` drives the DragOverlay preview;
  // it's set on dragStart and cleared on dragEnd.
  const [draggingId, setDraggingId] = useState<string | null>(null);

  const userById = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);

  // PointerSensor with activationConstraint distance:6 prevents the
  // drag from starting on a regular click (the card is also a Link
  // — without this, every click would initiate a drag and swallow
  // navigation).
  // TouchSensor with delay:200 enables mobile drag without breaking
  // tap-to-open. Mobile auto-switch to List ships in K1.5 anyway,
  // but keep the sensor for tablet (>= 768px).
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
  );

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

  /**
   * Optimistic move: immediately relocate the card in local state,
   * then call the API. On failure roll back + toast. The server-side
   * cross-pipeline guard (B3) catches accidental drops onto stages
   * from a different pipeline — but our DnD only allows drops onto
   * columns of the SAME board, so cross-pipeline can only happen if
   * the data races with a pipeline change (rare; surfaced as toast).
   */
  const onDragStart = useCallback((e: DragStartEvent) => {
    setDraggingId(String(e.active.id));
  }, []);

  const onDragEnd = useCallback(
    (e: DragEndEvent) => {
      setDraggingId(null);
      const leadId = String(e.active.id);
      const targetStageId = e.over ? String(e.over.id) : null;
      if (!targetStageId || !buckets) return;

      // No-op if dropped back onto the source column.
      const sourceBucket = buckets.find((b) => b.leads.some((l) => l.id === leadId));
      if (!sourceBucket || sourceBucket.stage.id === targetStageId) return;

      const targetBucket = buckets.find((b) => b.stage.id === targetStageId);
      if (!targetBucket) return;

      const movedLead = sourceBucket.leads.find((l) => l.id === leadId);
      if (!movedLead) return;

      // 1. Optimistic update.
      const previous = buckets;
      const next: StageBucket[] = buckets.map((b) => {
        if (b.stage.id === sourceBucket.stage.id) {
          return {
            ...b,
            totalCount: b.totalCount - 1,
            leads: b.leads.filter((l) => l.id !== leadId),
          };
        }
        if (b.stage.id === targetBucket.stage.id) {
          // Update the lead's stage on the in-flight optimistic copy
          // so the card renders in the right column with the right
          // stage badge.
          const optimisticLead: Lead = {
            ...movedLead,
            stageId: targetBucket.stage.id,
            stage: {
              code: targetBucket.stage.code,
              name: targetBucket.stage.name,
              order: targetBucket.stage.order,
              isTerminal: targetBucket.stage.isTerminal,
            },
          };
          return {
            ...b,
            totalCount: b.totalCount + 1,
            leads: [optimisticLead, ...b.leads],
          };
        }
        return b;
      });
      setBuckets(next);

      // 2. Fire the mutation.
      void (async () => {
        try {
          await leadsApi.moveStage(leadId, { pipelineStageId: targetStageId });
        } catch (err) {
          // Roll back. Toast the reason — server-side error codes
          // surface as `err.message` via ApiError.
          setBuckets(previous);
          toast({
            tone: 'error',
            title: t('moveFailed', { name: movedLead.name }),
            body: err instanceof ApiError ? err.message : String(err),
          });
        }
      })();
    },
    [buckets, toast, t],
  );

  const draggedLead = useMemo(() => {
    if (!draggingId || !buckets) return null;
    for (const b of buckets) {
      const found = b.leads.find((l) => l.id === draggingId);
      if (found) return found;
    }
    return null;
  }, [draggingId, buckets]);

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
        <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
          <div
            className={cn(
              'flex gap-3 overflow-x-auto pb-2 transition-opacity',
              loading ? 'opacity-60' : 'opacity-100',
            )}
          >
            {buckets.map((b) => (
              <KanbanColumn
                key={b.stage.id}
                bucket={b}
                userById={userById}
                draggingId={draggingId}
              />
            ))}
          </div>
          {/* DragOverlay renders the dragged card under the cursor.
              Without it, the original card stays put visually and the
              drag feels broken. */}
          <DragOverlay dropAnimation={null}>
            {draggedLead ? (
              <div className="w-72 rotate-1 cursor-grabbing opacity-95">
                <LeadCardBody
                  lead={draggedLead}
                  assignee={
                    draggedLead.assignedToId ? userById.get(draggedLead.assignedToId) : null
                  }
                />
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      )}
    </div>
  );
}

// ─── Column ──────────────────────────────────────────────────────────

interface KanbanColumnProps {
  bucket: StageBucket;
  userById: Map<string, AdminUser>;
  draggingId: string | null;
}

function KanbanColumn({ bucket, userById, draggingId }: KanbanColumnProps): JSX.Element {
  const t = useTranslations('admin.leads.kanban');
  const overflow = bucket.totalCount - bucket.leads.length;
  // K1.4 — make the column a drop target. The dnd-kit `over` event
  // fires when the dragged card hovers over this droppable.
  const { setNodeRef, isOver } = useDroppable({ id: bucket.stage.id });

  return (
    <section
      aria-label={bucket.stage.name}
      className={cn(
        'flex h-[640px] w-72 shrink-0 flex-col rounded-lg border bg-surface shadow-card transition-colors',
        bucket.stage.isTerminal ? 'opacity-95' : '',
        isOver ? 'border-brand-500 bg-brand-50/40' : 'border-surface-border',
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

      <div ref={setNodeRef} className="flex-1 overflow-y-auto p-2">
        {bucket.leads.length === 0 ? (
          <div className="flex h-full items-center justify-center px-2 text-center text-xs text-ink-tertiary">
            {t('columnEmpty')}
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {bucket.leads.map((l) => (
              <li key={l.id}>
                <DraggableLeadCard
                  lead={l}
                  assignee={l.assignedToId ? userById.get(l.assignedToId) : null}
                  isDragging={draggingId === l.id}
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
  isDragging?: boolean;
}

/**
 * K1.4 — draggable wrapper. PointerSensor.activationConstraint
 * (distance:6) ensures a regular click navigates via the inner Link
 * instead of starting a drag. While the card is being dragged the
 * wrapper hides (opacity:0); the DragOverlay renders a copy under
 * the cursor.
 */
function DraggableLeadCard({ lead, assignee, isDragging }: LeadCardProps): JSX.Element {
  const { attributes, listeners, setNodeRef } = useDraggable({ id: lead.id });
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={cn('cursor-grab touch-none', isDragging ? 'opacity-0' : '')}
    >
      <LeadCardBody lead={lead} assignee={assignee} />
    </div>
  );
}

/**
 * Pure card render — used by both the in-column draggable wrapper
 * and the floating DragOverlay during a drag.
 */
function LeadCardBody({ lead, assignee }: LeadCardProps): JSX.Element {
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
