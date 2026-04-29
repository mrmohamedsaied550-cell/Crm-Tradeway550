'use client';

import { useCallback, useEffect, useMemo, useState, type DragEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Phone, User as UserIcon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Select } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { ApiError, leadsApi, pipelineApi, teamsApi, usersApi } from '@/lib/api';
import type {
  AdminUser,
  Lead,
  LeadStageCode,
  PipelineStage,
  SlaStatus,
  Team,
} from '@/lib/api-types';
import { cn } from '@/lib/utils';

const DRAG_MIME = 'application/x-tradeway-lead';

function slaTone(s: SlaStatus): 'healthy' | 'warning' | 'breach' | 'inactive' {
  if (s === 'breached') return 'breach';
  if (s === 'paused') return 'inactive';
  return 'healthy';
}

interface DragState {
  leadId: string;
  /** Plain string — pipeline stages come from the API and aren't constrained to LeadStageCode literals. */
  fromStageCode: string;
}

/**
 * Kanban-style pipeline view (C16).
 *
 * Reads pipeline stages + leads + users + teams via the existing API; lays
 * leads out into one column per stage. Native HTML5 drag-and-drop moves a
 * lead between stages — on drop we call `POST /leads/:id/stage`. Optimistic
 * UI: the card jumps columns immediately and rolls back on error.
 *
 * Filters are client-side only (the spec says "no backend logic"):
 *   - Team filter: matches if the lead's assignee belongs to the chosen team.
 *     Unassigned leads are visible only when no team filter is active.
 *   - Assignee filter: matches the lead's `assignedToId`. The "Unassigned"
 *     option matches `assignedToId === null`.
 */
export default function PipelinePage(): JSX.Element {
  const t = useTranslations('admin.pipeline');
  const tCommon = useTranslations('admin.common');

  const [stages, setStages] = useState<PipelineStage[]>([]);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Filters
  const [filterTeamId, setFilterTeamId] = useState<string>('');
  const [filterAssigneeId, setFilterAssigneeId] = useState<string>('');

  // Drag state (which card is being dragged + where it started)
  const [drag, setDrag] = useState<DragState | null>(null);
  const [hoverStage, setHoverStage] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const [st, page, allUsers, allTeams] = await Promise.all([
        pipelineApi.listStages(),
        leadsApi.list({ limit: 200 }),
        usersApi
          .list({ limit: 200 })
          .catch(() => ({ items: [] as AdminUser[], total: 0, limit: 200, offset: 0 })),
        teamsApi.list().catch(() => [] as Team[]),
      ]);
      setStages(st);
      setLeads(page.items);
      setUsers(allUsers.items);
      setTeams(allTeams);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const userById = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);
  const teamById = useMemo(() => new Map(teams.map((tm) => [tm.id, tm])), [teams]);
  const stageByCode = useMemo(() => new Map(stages.map((s) => [s.code, s])), [stages]);

  // Apply filters to leads — once, then group by stage code.
  const visibleLeads = useMemo(() => {
    return leads.filter((l) => {
      if (filterAssigneeId === '__unassigned__') {
        if (l.assignedToId !== null) return false;
      } else if (filterAssigneeId) {
        if (l.assignedToId !== filterAssigneeId) return false;
      }
      if (filterTeamId) {
        const u = l.assignedToId ? userById.get(l.assignedToId) : null;
        if (!u || u.teamId !== filterTeamId) return false;
      }
      return true;
    });
  }, [leads, filterAssigneeId, filterTeamId, userById]);

  const leadsByStage = useMemo(() => {
    const map = new Map<string, Lead[]>();
    for (const s of stages) map.set(s.code, []);
    for (const l of visibleLeads) {
      const arr = map.get(l.stage.code);
      if (arr) arr.push(l);
    }
    return map;
  }, [stages, visibleLeads]);

  // ─────── Drag handlers ───────

  function onDragStart(e: DragEvent<HTMLDivElement>, lead: Lead): void {
    e.dataTransfer.setData(DRAG_MIME, lead.id);
    e.dataTransfer.effectAllowed = 'move';
    setDrag({ leadId: lead.id, fromStageCode: lead.stage.code });
  }

  function onDragEnd(): void {
    setDrag(null);
    setHoverStage(null);
  }

  function onColumnDragOver(e: DragEvent<HTMLDivElement>, stageCode: string): void {
    if (!drag) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setHoverStage(stageCode);
  }

  function onColumnDragLeave(stageCode: string): void {
    if (hoverStage === stageCode) setHoverStage(null);
  }

  async function onColumnDrop(
    e: DragEvent<HTMLDivElement>,
    targetStage: PipelineStage,
  ): Promise<void> {
    e.preventDefault();
    setHoverStage(null);
    if (!drag) return;

    const leadId = drag.leadId;
    const fromStageCode = drag.fromStageCode;
    setDrag(null);

    if (fromStageCode === targetStage.code) {
      // Drop on same stage: silent no-op (the API would also short-circuit).
      return;
    }

    // Optimistic update: re-stamp the lead's stage in local state.
    const original = leads.find((l) => l.id === leadId);
    if (!original) return;

    setLeads((prev) =>
      prev.map((l) =>
        l.id === leadId
          ? {
              ...l,
              stageId: targetStage.id,
              stage: {
                // The API returns LeadStageCode; the registry-known codes are
                // a subset of `string` so casting is safe at the optimistic
                // boundary. The next reload() reconciles with the server.
                code: targetStage.code as LeadStageCode,
                name: targetStage.name,
                order: targetStage.order,
                isTerminal: targetStage.isTerminal,
              },
            }
          : l,
      ),
    );
    setError(null);
    setNotice(null);

    try {
      await leadsApi.moveStage(leadId, targetStage.code as LeadStageCode);
      setNotice(t('movedTo', { stage: targetStage.name }));
    } catch (err) {
      // Roll back local state.
      setLeads((prev) => prev.map((l) => (l.id === leadId ? original : l)));
      setError(err instanceof ApiError ? err.message : t('moveFailed'));
    }
  }

  // ─────── Render ───────

  const isEmpty = !loading && !error && stages.length === 0;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={t('title')} subtitle={t('subtitle')} />

      <div className="flex flex-wrap items-end gap-3">
        <div className="w-full max-w-xs">
          <Field label={t('filterByTeam')}>
            <Select
              value={filterTeamId}
              onChange={(e) => setFilterTeamId(e.target.value)}
              disabled={loading}
            >
              <option value="">{t('anyTeam')}</option>
              {teams.map((tm) => (
                <option key={tm.id} value={tm.id}>
                  {tm.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="w-full max-w-xs">
          <Field label={t('filterByAssignee')}>
            <Select
              value={filterAssigneeId}
              onChange={(e) => setFilterAssigneeId(e.target.value)}
              disabled={loading}
            >
              <option value="">{tCommon('all')}</option>
              <option value="__unassigned__">{t('unassigned')}</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} ({u.email})
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {filterTeamId || filterAssigneeId ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setFilterTeamId('');
              setFilterAssigneeId('');
            }}
          >
            {tCommon('clearFilters')}
          </Button>
        ) : null}
      </div>

      {error ? (
        <Notice tone="error">
          <div className="flex items-start justify-between gap-3">
            <span>{error}</span>
            <Button variant="ghost" size="sm" onClick={() => void reload()}>
              {tCommon('retry')}
            </Button>
          </div>
        </Notice>
      ) : null}
      {notice ? <Notice tone="success">{notice}</Notice> : null}

      {loading ? (
        <p className="rounded-lg border border-surface-border bg-surface-card px-4 py-10 text-center text-sm text-ink-secondary shadow-card">
          {tCommon('loading')}
        </p>
      ) : isEmpty ? (
        <EmptyState title={t('noLeads')} />
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-2">
          {stages.map((stage) => {
            const cards = leadsByStage.get(stage.code) ?? [];
            const isHover = hoverStage === stage.code;
            const isSource = drag?.fromStageCode === stage.code;
            return (
              <div
                key={stage.code}
                className={cn(
                  'flex w-72 shrink-0 flex-col rounded-lg border bg-surface-card shadow-card',
                  isHover ? 'border-brand-400 bg-brand-50/40' : 'border-surface-border',
                )}
                onDragOver={(e) => onColumnDragOver(e, stage.code)}
                onDragLeave={() => onColumnDragLeave(stage.code)}
                onDrop={(e) => void onColumnDrop(e, stage)}
              >
                <header className="flex items-center justify-between border-b border-surface-border px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-ink-primary">{stage.name}</span>
                    {stage.isTerminal ? <Badge tone="inactive">{tCommon('inactive')}</Badge> : null}
                  </div>
                  <span className="text-xs text-ink-tertiary">{cards.length}</span>
                </header>

                <div className="flex flex-col gap-2 p-2">
                  {cards.length === 0 ? (
                    <p
                      className={cn(
                        'rounded-md border border-dashed px-3 py-6 text-center text-xs text-ink-tertiary',
                        isHover && !isSource ? 'border-brand-400' : 'border-surface-border',
                      )}
                    >
                      —
                    </p>
                  ) : (
                    cards.map((lead) => (
                      <LeadCard
                        key={lead.id}
                        lead={lead}
                        assignee={
                          lead.assignedToId ? (userById.get(lead.assignedToId) ?? null) : null
                        }
                        team={
                          lead.assignedToId
                            ? userById.get(lead.assignedToId)?.teamId
                              ? (teamById.get(userById.get(lead.assignedToId)!.teamId!) ?? null)
                              : null
                            : null
                        }
                        unassignedLabel={t('unassigned')}
                        dragging={drag?.leadId === lead.id}
                        onDragStart={(e) => onDragStart(e, lead)}
                        onDragEnd={onDragEnd}
                      />
                    ))
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Empty hint when filters return nothing inside an otherwise non-empty board. */}
      {!loading && !error && !isEmpty && visibleLeads.length === 0 ? (
        <p className="text-center text-xs text-ink-tertiary">{t('noLeads')}</p>
      ) : null}

      {/* Sanity: keep stageByCode referenced so the lint rule doesn't drop the memo. */}
      <span className="hidden">{stageByCode.size}</span>
    </div>
  );
}

interface LeadCardProps {
  lead: Lead;
  assignee: AdminUser | null;
  team: Team | null;
  unassignedLabel: string;
  dragging: boolean;
  onDragStart: (e: DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
}

function LeadCard({
  lead,
  assignee,
  team,
  unassignedLabel,
  dragging,
  onDragStart,
  onDragEnd,
}: LeadCardProps): JSX.Element {
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={cn(
        'cursor-grab rounded-md border border-surface-border bg-surface px-3 py-2 text-sm shadow-sm transition-opacity',
        'hover:border-brand-200 hover:bg-brand-50/40',
        'active:cursor-grabbing',
        dragging && 'opacity-50',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="font-medium text-ink-primary">{lead.name}</span>
        <Badge tone={slaTone(lead.slaStatus)}>{lead.slaStatus}</Badge>
      </div>
      <div className="mt-1.5 flex items-center gap-1.5 text-xs text-ink-secondary">
        <Phone className="h-3 w-3" aria-hidden="true" />
        <code className="font-mono">{lead.phone}</code>
      </div>
      <div className="mt-1 flex items-center gap-1.5 text-xs text-ink-secondary">
        <UserIcon className="h-3 w-3" aria-hidden="true" />
        {assignee ? (
          <span>
            {assignee.name}
            {team ? <span className="text-ink-tertiary"> · {team.name}</span> : null}
          </span>
        ) : (
          <span className="text-ink-tertiary">{unassignedLabel}</span>
        )}
      </div>
    </div>
  );
}
