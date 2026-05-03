'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState, useCallback, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Columns, List, Plus, Upload, UserPlus } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataTable, type Column } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input, Select } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { useToast } from '@/components/ui/toast';
import { KanbanBoard, type KanbanFilters } from '@/components/admin/leads-workspace/kanban-board';
import { useIsMobile } from '@/lib/use-media-query';
import { cn } from '@/lib/utils';
import {
  ApiError,
  companiesApi,
  countriesApi,
  leadsApi,
  pipelineApi,
  pipelinesApi,
  usersApi,
} from '@/lib/api';
import type {
  AdminUser,
  Company,
  Country,
  Lead,
  LeadSource,
  LeadStageCode,
  Pipeline,
  PipelineStage,
  SlaStatus,
} from '@/lib/api-types';

/**
 * Phase 1 — Lead Workspace.
 *
 * The page is a shell with three slots:
 *   1. Header (title, primary actions, create / import).
 *   2. Lens row — pipeline picker + view-mode toggle (List | Kanban).
 *   3. Body — depends on view mode. List uses the legacy DataTable;
 *      Kanban (added in K1.3) draws a board from `leadsApi.listByStage`.
 *
 * View mode persists per pipeline in localStorage so an agent who
 * lives on Kanban for one pipeline and List for another keeps both
 * preferences. (Server-side preferences land in Phase 3.)
 */

type ViewMode = 'list' | 'kanban';

const VIEW_MODE_KEY_PREFIX = 'crm.leads.viewMode.';
const ACTIVE_PIPELINE_KEY = 'crm.leads.activePipelineId';

function readViewMode(pipelineId: string | null): ViewMode {
  if (!pipelineId || typeof window === 'undefined') return 'list';
  const v = window.localStorage.getItem(VIEW_MODE_KEY_PREFIX + pipelineId);
  return v === 'kanban' ? 'kanban' : 'list';
}

function writeViewMode(pipelineId: string, mode: ViewMode): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(VIEW_MODE_KEY_PREFIX + pipelineId, mode);
}

function readActivePipelineId(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(ACTIVE_PIPELINE_KEY);
}

function writeActivePipelineId(id: string): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(ACTIVE_PIPELINE_KEY, id);
}

interface CreateForm {
  name: string;
  phone: string;
  email: string;
  source: LeadSource;
  /**
   * Phase 1B — explicit (company, country) on create. Both optional;
   * empty string falls back to the tenant default pipeline.
   */
  companyId: string;
  countryId: string;
  stageCode: LeadStageCode | '';
  assignedToId: string;
}

const EMPTY_CREATE_FORM: CreateForm = {
  name: '',
  phone: '',
  email: '',
  source: 'manual',
  companyId: '',
  countryId: '',
  stageCode: '',
  assignedToId: '',
};

const SOURCES: readonly LeadSource[] = ['manual', 'meta', 'tiktok', 'whatsapp', 'import'] as const;

function slaTone(s: SlaStatus): 'healthy' | 'warning' | 'breach' | 'inactive' {
  if (s === 'breached') return 'breach';
  if (s === 'paused') return 'inactive';
  return 'healthy';
}

/**
 * Quote-aware splitter for a single CSV header line. Mirrors enough of
 * the server-side parser to give the user a useful column dropdown
 * before they submit the import. Strips a UTF-8 BOM if present.
 */
function parseHeaderLine(line: string): string[] {
  const raw = line.charCodeAt(0) === 0xfeff ? line.slice(1) : line;
  const cells: string[] = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inQuotes) {
      if (ch === '"' && raw[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell.length === 0) {
      inQuotes = true;
      continue;
    }
    if (ch === ',') {
      cells.push(cell.trim());
      cell = '';
      continue;
    }
    cell += ch;
  }
  cells.push(cell.trim());
  return cells.filter((c) => c.length > 0);
}

export default function LeadsPage(): JSX.Element {
  const t = useTranslations('admin.leads');
  const tCommon = useTranslations('admin.common');
  const { toast } = useToast();

  const [rows, setRows] = useState<Lead[]>([]);
  const [stages, setStages] = useState<PipelineStage[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  // Phase 1B — companies + countries drive the create form's
  // (company × country) pickers so the new lead lands on the right
  // pipeline. Loaded once on mount; refreshing on filter changes
  // would be wasteful.
  const [companies, setCompanies] = useState<Company[]>([]);
  const [countries, setCountries] = useState<Country[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Phase 1 — workspace shell state.
  // Pipelines are loaded once on mount; the active pipeline drives
  // the future Kanban columns and persists across reloads.
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [activePipelineId, setActivePipelineId] = useState<string | null>(null);
  // View mode is per-pipeline so an agent who lives on Kanban for
  // pipeline A and List for pipeline B keeps both preferences.
  const [viewMode, setViewMode] = useState<ViewMode>('list');

  // K1.5 — Kanban is unusable on phones (columns don't fit, drag
  // fights with native scroll). The page auto-falls-back to List
  // below 768 px even if the saved preference is Kanban. The user
  // can still override per-session via `forceKanbanOnMobile`.
  const isMobile = useIsMobile();
  const [forceKanbanOnMobile, setForceKanbanOnMobile] = useState<boolean>(false);
  const effectiveViewMode: ViewMode = isMobile && !forceKanbanOnMobile ? 'list' : viewMode;

  const [filterStage, setFilterStage] = useState<LeadStageCode | ''>('');
  const [search, setSearch] = useState<string>('');
  // Q3 — debounced mirror of `search`. The text input updates
  // `search` synchronously (responsive typing), but the API calls
  // and Kanban refetches read `debouncedSearch`, throttling actual
  // network traffic to one request per 250 ms of typing pause.
  const [debouncedSearch, setDebouncedSearch] = useState<string>('');
  useEffect(() => {
    const id = window.setTimeout(() => setDebouncedSearch(search), 250);
    return () => window.clearTimeout(id);
  }, [search]);
  // P3-03 — advanced filters. Empty string means "any" (mapped to
  // `undefined` on the wire so the API treats them as not-passed).
  const [filterSource, setFilterSource] = useState<LeadSource | ''>('');
  const [filterSla, setFilterSla] = useState<SlaStatus | ''>('');
  const [filterAssignee, setFilterAssignee] = useState<string>(''); // userId or '__unassigned__'
  const [filterCreatedFrom, setFilterCreatedFrom] = useState<string>(''); // yyyy-mm-dd
  const [filterCreatedTo, setFilterCreatedTo] = useState<string>('');
  const [filterOverdue, setFilterOverdue] = useState<boolean>(false);
  const [advancedOpen, setAdvancedOpen] = useState<boolean>(false);

  const [creating, setCreating] = useState<boolean>(false);
  const [form, setForm] = useState<CreateForm>(EMPTY_CREATE_FORM);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [formError, setFormError] = useState<string | null>(null);

  // P3-05 — bulk-action state.
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [bulkAssignOpen, setBulkAssignOpen] = useState<boolean>(false);
  const [bulkStageOpen, setBulkStageOpen] = useState<boolean>(false);
  const [bulkAssignTarget, setBulkAssignTarget] = useState<string>(''); // userId or '__unassign__'
  const [bulkStageTarget, setBulkStageTarget] = useState<LeadStageCode | ''>('');
  const [bulkSubmitting, setBulkSubmitting] = useState<boolean>(false);

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      // P3-03 — assignee picker drives BOTH the explicit `assignedToId`
      // path and the `unassigned` path. The sentinel `__unassigned__`
      // means "leads with no owner".
      const assignedToId =
        filterAssignee && filterAssignee !== '__unassigned__' ? filterAssignee : undefined;
      const unassigned = filterAssignee === '__unassigned__' ? true : undefined;
      // Convert the date pickers (`yyyy-mm-dd`) to ISO timestamps. The
      // `from` bound starts at 00:00 UTC of that day; the `to` bound
      // ends at 23:59:59.999 UTC so the picker's "to" day is inclusive.
      const createdFrom = filterCreatedFrom
        ? new Date(`${filterCreatedFrom}T00:00:00.000Z`).toISOString()
        : undefined;
      const createdTo = filterCreatedTo
        ? new Date(`${filterCreatedTo}T23:59:59.999Z`).toISOString()
        : undefined;

      const [page, st, usrs, cs, cos] = await Promise.all([
        leadsApi.list({
          // Q2 — narrow the list to the active pipeline so the picker
          // actually means something here. Was a no-op before — the
          // list returned every pipeline's leads regardless of which
          // pipeline the user thought they were looking at.
          pipelineId: activePipelineId ?? undefined,
          stageCode: filterStage || undefined,
          // Q3 — `debouncedSearch` is `search` lagged by 250 ms.
          q: debouncedSearch.trim() || undefined,
          source: filterSource || undefined,
          slaStatus: filterSla || undefined,
          assignedToId,
          unassigned,
          createdFrom,
          createdTo,
          hasOverdueFollowup: filterOverdue || undefined,
          limit: 100,
        }),
        // Q2 — load stages from the ACTIVE pipeline, not the tenant
        // default. Without this, the stage filter dropdown showed
        // stages from a different pipeline whenever the picker was
        // on a custom pipeline (and selecting one of those stage
        // codes filtered against the wrong pipeline's stage UUID).
        activePipelineId
          ? pipelinesApi.stagesOf(activePipelineId).catch(() => [] as PipelineStage[])
          : pipelineApi.listStages().catch(() => [] as PipelineStage[]),
        usersApi
          .list({ status: 'active', limit: 200 })
          .catch(() => ({ items: [] as AdminUser[], total: 0, limit: 200, offset: 0 })),
        companiesApi.list().catch(() => [] as Company[]),
        countriesApi.list().catch(() => [] as Country[]),
      ]);
      setRows(page.items);
      setStages(st);
      setUsers(usrs.items);
      setCompanies(cs);
      setCountries(cos);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [
    activePipelineId,
    filterStage,
    debouncedSearch,
    filterSource,
    filterSla,
    filterAssignee,
    filterCreatedFrom,
    filterCreatedTo,
    filterOverdue,
  ]);

  // Phase 1 — load pipelines once on mount; pick the active one
  // from localStorage (must still exist + be active), else the
  // tenant default. The result drives the lens row's pipeline
  // picker and the future Kanban view.
  useEffect(() => {
    void (async () => {
      const list = await pipelinesApi.list().catch(() => [] as Pipeline[]);
      setPipelines(list);
      const stored = readActivePipelineId();
      const storedStillValid = stored ? list.find((p) => p.id === stored && p.isActive) : null;
      const fallback =
        list.find((p) => p.isDefault && p.isActive) ?? list.find((p) => p.isActive) ?? null;
      const chosen = storedStillValid ?? fallback;
      if (chosen) {
        setActivePipelineId(chosen.id);
        setViewMode(readViewMode(chosen.id));
      }
    })();
  }, []);

  // Phase 1 — when the active pipeline changes, persist it and
  // refresh the per-pipeline view-mode preference.
  //
  // Q2 — also reset the stage filter on pipeline change. Stage codes
  // are scoped to a pipeline; an old code (e.g. 'contacted' from
  // pipeline A) does not generally exist in pipeline B and would
  // either return zero leads silently or hit a 404 from the
  // server-side resolver. Clearing on switch keeps the user out of
  // that confusing state.
  useEffect(() => {
    if (!activePipelineId) return;
    writeActivePipelineId(activePipelineId);
    setViewMode(readViewMode(activePipelineId));
    setFilterStage('');
  }, [activePipelineId]);

  function changeViewMode(mode: ViewMode): void {
    setViewMode(mode);
    if (activePipelineId) writeViewMode(activePipelineId, mode);
  }

  /** P3-03 — true when ANY filter is non-empty. Drives the empty-state copy. */
  const anyFilterActive: boolean =
    Boolean(filterStage) ||
    Boolean(search) ||
    Boolean(filterSource) ||
    Boolean(filterSla) ||
    Boolean(filterAssignee) ||
    Boolean(filterCreatedFrom) ||
    Boolean(filterCreatedTo) ||
    filterOverdue;

  /**
   * Phase 1 — Kanban filter shape. Mirrors the list view's filters
   * minus the stage selector (the board is grouped BY stage so a
   * stage filter makes no sense on it). Recomputed on every render
   * but the KanbanBoard memos its fetcher on the same shape, so
   * unchanged filters don't trigger a re-fetch.
   */
  const kanbanFilters: KanbanFilters | null = useMemo(
    () =>
      activePipelineId
        ? {
            pipelineId: activePipelineId,
            // Q3 — debounced source so the Kanban refetch doesn't
            // fire on every keystroke.
            ...(debouncedSearch.trim() && { q: debouncedSearch.trim() }),
            ...(filterSource && { source: filterSource }),
            ...(filterSla && { slaStatus: filterSla }),
            ...(filterAssignee &&
              filterAssignee !== '__unassigned__' && { assignedToId: filterAssignee }),
            ...(filterAssignee === '__unassigned__' && { unassigned: true }),
            ...(filterCreatedFrom && {
              createdFrom: new Date(`${filterCreatedFrom}T00:00:00.000Z`).toISOString(),
            }),
            ...(filterCreatedTo && {
              createdTo: new Date(`${filterCreatedTo}T23:59:59.999Z`).toISOString(),
            }),
            ...(filterOverdue && { hasOverdueFollowup: true }),
          }
        : null,
    [
      activePipelineId,
      debouncedSearch,
      filterSource,
      filterSla,
      filterAssignee,
      filterCreatedFrom,
      filterCreatedTo,
      filterOverdue,
    ],
  );

  function clearFilters(): void {
    setFilterStage('');
    setSearch('');
    setFilterSource('');
    setFilterSla('');
    setFilterAssignee('');
    setFilterCreatedFrom('');
    setFilterCreatedTo('');
    setFilterOverdue(false);
  }

  // P3-05 — when the row set shrinks (filter change, deletion), prune
  // ids that are no longer visible from the selection so the action
  // bar count never lies. This is cheap; the visible set is bounded
  // by the page limit.
  useEffect(() => {
    const visible = new Set(rows.map((r) => r.id));
    setSelectedIds((prev) => {
      let drift = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (visible.has(id)) next.add(id);
        else drift = true;
      }
      return drift ? next : prev;
    });
  }, [rows]);

  // P3-06 — bulk results render via the global toaster instead of an
  // inline Notice the operator has to scroll back up to see. Partial
  // outcomes carry the first 3 failure messages in the toast body.
  function reportBulk(res: { updated: string[]; failed: { id: string; message: string }[] }): void {
    if (res.failed.length === 0) {
      toast({ tone: 'success', title: t('bulk.successAll', { n: res.updated.length }) });
    } else {
      toast({
        tone: 'warning',
        title: t('bulk.successPartial', { ok: res.updated.length, failed: res.failed.length }),
        body: res.failed
          .slice(0, 3)
          .map((f) => f.message)
          .join(' · '),
      });
    }
  }

  async function onBulkAssign(): Promise<void> {
    if (selectedIds.size === 0) return;
    setBulkSubmitting(true);
    try {
      const assignedToId = bulkAssignTarget === '__unassign__' ? null : bulkAssignTarget || null;
      const res = await leadsApi.bulkAssign({ leadIds: [...selectedIds], assignedToId });
      reportBulk(res);
      setBulkAssignOpen(false);
      setSelectedIds(new Set());
      await reload();
    } catch (err) {
      toast({ tone: 'error', title: err instanceof ApiError ? err.message : String(err) });
    } finally {
      setBulkSubmitting(false);
    }
  }

  async function onBulkStage(): Promise<void> {
    if (selectedIds.size === 0 || !bulkStageTarget) return;
    setBulkSubmitting(true);
    try {
      const res = await leadsApi.bulkStage({
        leadIds: [...selectedIds],
        stageCode: bulkStageTarget,
      });
      reportBulk(res);
      setBulkStageOpen(false);
      setSelectedIds(new Set());
      await reload();
    } catch (err) {
      toast({ tone: 'error', title: err instanceof ApiError ? err.message : String(err) });
    } finally {
      setBulkSubmitting(false);
    }
  }

  async function onBulkDelete(): Promise<void> {
    if (selectedIds.size === 0) return;
    if (!window.confirm(t('bulk.confirmDelete', { n: selectedIds.size }))) return;
    setBulkSubmitting(true);
    try {
      const res = await leadsApi.bulkDelete({ leadIds: [...selectedIds] });
      reportBulk(res);
      setSelectedIds(new Set());
      await reload();
    } catch (err) {
      toast({ tone: 'error', title: err instanceof ApiError ? err.message : String(err) });
    } finally {
      setBulkSubmitting(false);
    }
  }

  useEffect(() => {
    void reload();
  }, [reload]);

  const userById = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);

  function openNew(): void {
    setForm(EMPTY_CREATE_FORM);
    setFormError(null);
    setCreating(true);
  }

  function closeForm(): void {
    setCreating(false);
  }

  async function onCreate(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setSubmitting(true);
    setFormError(null);
    try {
      await leadsApi.create({
        name: form.name,
        phone: form.phone,
        email: form.email || undefined,
        source: form.source,
        // Phase 1B — pass company/country so the server resolves the
        // right pipeline; pass stageCode (resolved per-pipeline) when
        // the operator picked one explicitly.
        companyId: form.companyId || undefined,
        countryId: form.countryId || undefined,
        stageCode: form.stageCode || undefined,
        assignedToId: form.assignedToId || undefined,
      });
      setNotice(tCommon('created'));
      closeForm();
      await reload();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function onDelete(row: Lead): Promise<void> {
    const ok = window.confirm(tCommon('confirmDelete', { entity: 'lead' }));
    if (!ok) return;
    try {
      await leadsApi.remove(row.id);
      setNotice(tCommon('saved'));
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  // P2-06 — CSV import dialog state.
  const [importing, setImporting] = useState<boolean>(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importCsvText, setImportCsvText] = useState<string>('');
  const [importHeaders, setImportHeaders] = useState<string[]>([]);
  const [importMap, setImportMap] = useState<{ name: string; phone: string; email: string }>({
    name: '',
    phone: '',
    email: '',
  });
  const [importSource, setImportSource] = useState<LeadSource>('import');
  const [importAutoAssign, setImportAutoAssign] = useState<boolean>(true);
  const [importLoading, setImportLoading] = useState<boolean>(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<{
    total: number;
    created: number;
    duplicates: number;
    errors: { row: number; reason: string }[];
  } | null>(null);
  const tImport = useTranslations('admin.leads.import');

  function openImport(): void {
    setImportFile(null);
    setImportCsvText('');
    setImportHeaders([]);
    setImportMap({ name: '', phone: '', email: '' });
    setImportSource('import');
    setImportAutoAssign(true);
    setImportError(null);
    setImportResult(null);
    setImporting(true);
  }

  function closeImport(): void {
    setImporting(false);
  }

  async function onPickCsvFile(file: File | null): Promise<void> {
    setImportError(null);
    setImportResult(null);
    setImportFile(file);
    setImportHeaders([]);
    setImportMap({ name: '', phone: '', email: '' });
    if (!file) {
      setImportCsvText('');
      return;
    }
    try {
      const text = await file.text();
      setImportCsvText(text);
      // Read just the first non-blank line for header preview. We don't
      // re-parse the body here — that's the server's job at submit time.
      const firstLine = text.split(/\r\n|\n|\r/).find((l) => l.trim().length > 0) ?? '';
      const headers = parseHeaderLine(firstLine);
      setImportHeaders(headers);
      // Best-effort auto-mapping by lowercase header containment.
      const lower = (h: string): string => h.toLowerCase();
      const findHeader = (...needles: string[]): string =>
        headers.find((h) => needles.some((n) => lower(h).includes(n))) ?? '';
      setImportMap({
        name: findHeader('name', 'الاسم'),
        phone: findHeader('phone', 'mobile', 'رقم', 'هاتف'),
        email: findHeader('email', 'بريد'),
      });
    } catch (err) {
      setImportError(String(err));
    }
  }

  async function onSubmitImport(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setImportError(null);
    setImportResult(null);
    if (importCsvText.length === 0) {
      setImportError(tImport('needFile'));
      return;
    }
    if (importHeaders.length === 0 || !importMap.name || !importMap.phone) {
      setImportError(tImport('needHeaders'));
      return;
    }
    setImportLoading(true);
    try {
      const result = await leadsApi.importCsv({
        csv: importCsvText,
        mapping: {
          name: importMap.name,
          phone: importMap.phone,
          ...(importMap.email && { email: importMap.email }),
        },
        defaultSource: importSource,
        autoAssign: importAutoAssign,
      });
      setImportResult(result);
      await reload();
    } catch (err) {
      setImportError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setImportLoading(false);
    }
  }

  // C39 — round-robin auto-assign for one lead.
  const [autoAssigning, setAutoAssigning] = useState<Set<string>>(new Set());
  async function onAutoAssign(row: Lead): Promise<void> {
    if (autoAssigning.has(row.id)) return;
    setAutoAssigning((s) => new Set(s).add(row.id));
    setError(null);
    try {
      const result = await leadsApi.autoAssign(row.id);
      if (result === null) {
        setError(t('autoAssignNoEligible'));
      } else {
        setNotice(t('autoAssigned'));
      }
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setAutoAssigning((s) => {
        const next = new Set(s);
        next.delete(row.id);
        return next;
      });
    }
  }

  const columns: ReadonlyArray<Column<Lead>> = [
    {
      key: 'name',
      header: t('name'),
      render: (r) => <span className="font-medium">{r.name}</span>,
    },
    {
      key: 'phone',
      header: t('phone'),
      render: (r) => <code className="font-mono text-xs">{r.phone}</code>,
    },
    {
      key: 'stage',
      header: t('stage'),
      render: (r) => <Badge tone={r.stage.isTerminal ? 'inactive' : 'info'}>{r.stage.name}</Badge>,
    },
    {
      key: 'assignee',
      header: t('assignee'),
      render: (r) =>
        r.assignedToId ? (
          <span className="text-ink-secondary">
            {userById.get(r.assignedToId)?.name ?? r.assignedToId.slice(0, 8)}
          </span>
        ) : (
          <span className="text-ink-tertiary">{t('unassigned')}</span>
        ),
    },
    {
      key: 'sla',
      header: t('sla'),
      render: (r) => <Badge tone={slaTone(r.slaStatus)}>{r.slaStatus}</Badge>,
    },
    {
      key: 'source',
      header: t('source'),
      render: (r) => <span className="text-xs text-ink-secondary">{r.source}</span>,
    },
    {
      key: 'actions',
      header: tCommon('actions'),
      render: (r) =>
        r.stage.isTerminal ? (
          <span className="text-xs text-ink-tertiary">—</span>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void onAutoAssign(r)}
            loading={autoAssigning.has(r.id)}
            disabled={autoAssigning.has(r.id)}
          >
            <UserPlus className="h-3.5 w-3.5" aria-hidden="true" />
            {t('autoAssign')}
          </Button>
        ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={openImport}>
              <Upload className="h-4 w-4" />
              {t('importButton')}
            </Button>
            <Button onClick={openNew}>
              <Plus className="h-4 w-4" />
              {t('newButton')}
            </Button>
          </div>
        }
      />

      {/*
       * Phase 1 — Lens row. Pipeline picker on the left, view-mode
       * toggle on the right. Both persist per-user via localStorage.
       * When only one pipeline exists the picker is shown but
       * disabled (still informative — the user knows what they're
       * looking at).
       */}
      {pipelines.length > 0 ? (
        <div className="flex flex-wrap items-end justify-between gap-3 rounded-lg border border-surface-border bg-surface-card px-3 py-2 shadow-card">
          <div className="flex items-end gap-3">
            <Field label={t('lens.pipeline')}>
              <Select
                value={activePipelineId ?? ''}
                onChange={(e) => setActivePipelineId(e.target.value)}
                disabled={pipelines.length <= 1}
                className="min-w-[220px]"
              >
                {pipelines.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.isDefault ? ` · ${t('lens.default')}` : ''}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div
            className="inline-flex h-9 items-center rounded-md border border-surface-border bg-surface p-0.5"
            role="tablist"
            aria-label={t('lens.viewMode')}
          >
            {(['list', 'kanban'] as const).map((m) => {
              const Icon = m === 'list' ? List : Columns;
              return (
                <button
                  key={m}
                  type="button"
                  role="tab"
                  aria-selected={viewMode === m}
                  onClick={() => changeViewMode(m)}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded px-3 py-1 text-sm font-medium transition-colors',
                    viewMode === m
                      ? 'bg-surface-card text-brand-700 shadow-sm'
                      : 'text-ink-secondary hover:text-ink-primary',
                  )}
                >
                  <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                  {t(`lens.${m}`)}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {/*
       * Phase 1 — Kanban view. Renders a board grouped by the active
       * pipeline's stages, sharing the same filter set as the list
       * view. Drag-and-drop arrives in K1.4; quick actions / SLA /
       * detail drawer arrive in Phase 2.
       */}
      {/* K1.5 — when the user has Kanban selected but the screen
          dropped below 768px, surface the auto-switch with an opt-in
          to force Kanban anyway. Avoids silently swapping the body. */}
      {isMobile && viewMode === 'kanban' && !forceKanbanOnMobile ? (
        <Notice tone="info">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <span>{t('lens.mobileFallback')}</span>
            <Button variant="ghost" size="sm" onClick={() => setForceKanbanOnMobile(true)}>
              {t('lens.useKanbanAnyway')}
            </Button>
          </div>
        </Notice>
      ) : null}

      {/*
       * Q1 — primary filter row + advanced panel are SHARED state and
       * apply to both views. Lifted out of the list-only conditional
       * so Kanban users can also filter, search, and clear.
       *
       * The stage filter (`filterStage`) is List-specific because the
       * Kanban view groups BY stage — narrowing to one stage there
       * would just hide the other columns. Hidden in Kanban.
       */}
      <div className="flex flex-wrap items-end gap-3">
        {effectiveViewMode === 'list' ? (
          <div className="w-full max-w-xs">
            <Field label={t('filterByStage')}>
              <Select
                value={filterStage}
                onChange={(e) => setFilterStage(e.target.value as LeadStageCode | '')}
              >
                <option value="">{tCommon('all')}</option>
                {stages.map((s) => (
                  <option key={s.code} value={s.code}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        ) : null}
        <div className="w-full max-w-sm">
          <Field label={t('search')}>
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="…" />
          </Field>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setAdvancedOpen((v) => !v)}
          aria-expanded={advancedOpen}
        >
          {advancedOpen ? t('advanced.hide') : t('advanced.show')}
        </Button>
        {anyFilterActive ? (
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            {tCommon('clearFilters')}
          </Button>
        ) : null}
      </div>

      {advancedOpen ? (
        <div className="grid grid-cols-1 gap-3 rounded-lg border border-surface-border bg-surface-card p-3 shadow-card sm:grid-cols-2 lg:grid-cols-3">
          <Field label={t('advanced.source')}>
            <Select
              value={filterSource}
              onChange={(e) => setFilterSource(e.target.value as LeadSource | '')}
            >
              <option value="">{tCommon('all')}</option>
              <option value="manual">{t('advanced.sources.manual')}</option>
              <option value="meta">{t('advanced.sources.meta')}</option>
              <option value="tiktok">{t('advanced.sources.tiktok')}</option>
              <option value="whatsapp">{t('advanced.sources.whatsapp')}</option>
              <option value="import">{t('advanced.sources.import')}</option>
            </Select>
          </Field>
          <Field label={t('advanced.sla')}>
            <Select
              value={filterSla}
              onChange={(e) => setFilterSla(e.target.value as SlaStatus | '')}
            >
              <option value="">{tCommon('all')}</option>
              <option value="active">{t('advanced.slaActive')}</option>
              <option value="breached">{t('advanced.slaBreached')}</option>
              <option value="paused">{t('advanced.slaPaused')}</option>
            </Select>
          </Field>
          <Field label={t('advanced.assignee')}>
            <Select value={filterAssignee} onChange={(e) => setFilterAssignee(e.target.value)}>
              <option value="">{tCommon('all')}</option>
              <option value="__unassigned__">{t('advanced.unassigned')}</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('advanced.createdFrom')}>
            <Input
              type="date"
              value={filterCreatedFrom}
              onChange={(e) => setFilterCreatedFrom(e.target.value)}
              max={filterCreatedTo || undefined}
            />
          </Field>
          <Field label={t('advanced.createdTo')}>
            <Input
              type="date"
              value={filterCreatedTo}
              onChange={(e) => setFilterCreatedTo(e.target.value)}
              min={filterCreatedFrom || undefined}
            />
          </Field>
          <label className="flex items-center gap-2 self-end pb-2 text-sm text-ink-primary">
            <input
              type="checkbox"
              checked={filterOverdue}
              onChange={(e) => setFilterOverdue(e.target.checked)}
            />
            {t('advanced.overdueOnly')}
          </label>
        </div>
      ) : null}

      {effectiveViewMode === 'kanban' && kanbanFilters ? (
        <KanbanBoard filters={kanbanFilters} users={users} onCreate={openNew} />
      ) : null}

      {effectiveViewMode === 'list' ? (
        <>
          {/*
           * Q1 — the filter row above is now shared. The list view
           * keeps its own load-error / notice / empty-state /
           * DataTable / bulk-action bar below.
           */}

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

          {!loading && !error && rows.length === 0 ? (
            <EmptyState
              title={anyFilterActive ? t('emptyFiltered') : t('empty')}
              body={anyFilterActive ? t('emptyFilteredHint') : t('emptyHint')}
              action={
                anyFilterActive ? (
                  <Button variant="secondary" size="sm" onClick={clearFilters}>
                    {tCommon('clearFilters')}
                  </Button>
                ) : (
                  <Button variant="primary" size="sm" onClick={openNew}>
                    {t('newButton')}
                  </Button>
                )
              }
            />
          ) : (
            <>
              {/* P3-05 — bulk action bar (only shown when 1+ rows are selected). */}
              {selectedIds.size > 0 ? (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 text-sm">
                  <span className="font-medium text-brand-800">
                    {t('bulk.selected', { n: selectedIds.size })}
                  </span>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        setBulkAssignTarget('');
                        setBulkAssignOpen(true);
                      }}
                      disabled={bulkSubmitting}
                    >
                      {t('bulk.assign')}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        setBulkStageTarget('');
                        setBulkStageOpen(true);
                      }}
                      disabled={bulkSubmitting}
                    >
                      {t('bulk.stage')}
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => void onBulkDelete()}
                      disabled={bulkSubmitting}
                    >
                      {t('bulk.delete')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setSelectedIds(new Set())}
                      disabled={bulkSubmitting}
                    >
                      {t('bulk.clear')}
                    </Button>
                  </div>
                </div>
              ) : null}

              <DataTable
                columns={columns}
                rows={rows}
                keyOf={(r) => r.id}
                loading={loading}
                skeletonRows={6}
                selection={{
                  selectedIds,
                  onChange: setSelectedIds,
                  ariaLabel: t('bulk.selectRow'),
                }}
                rowActions={(row) => (
                  <>
                    <Link
                      href={`/admin/leads/${row.id}`}
                      className="inline-flex h-8 items-center justify-center rounded-md border border-surface-border bg-surface-card px-3 text-xs font-medium text-ink-primary hover:bg-brand-50 hover:border-brand-200"
                    >
                      {t('openDetail')}
                    </Link>
                    <Button variant="ghost" size="sm" onClick={() => void onDelete(row)}>
                      {tCommon('delete')}
                    </Button>
                  </>
                )}
              />
            </>
          )}
        </>
      ) : null}

      {/* P3-05 — bulk assign modal */}
      <Modal
        open={bulkAssignOpen}
        title={t('bulk.assignModalTitle', { n: selectedIds.size })}
        onClose={() => setBulkAssignOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setBulkAssignOpen(false)}>
              {tCommon('cancel')}
            </Button>
            <Button onClick={() => void onBulkAssign()} loading={bulkSubmitting}>
              {tCommon('save')}
            </Button>
          </>
        }
      >
        <Field label={t('bulk.assignee')} required>
          <Select
            value={bulkAssignTarget}
            onChange={(e) => setBulkAssignTarget(e.target.value)}
            required
          >
            <option value="">{t('bulk.pickAssignee')}</option>
            <option value="__unassign__">{t('bulk.unassignAll')}</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </Select>
        </Field>
      </Modal>

      {/* P3-05 — bulk stage move modal */}
      <Modal
        open={bulkStageOpen}
        title={t('bulk.stageModalTitle', { n: selectedIds.size })}
        onClose={() => setBulkStageOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setBulkStageOpen(false)}>
              {tCommon('cancel')}
            </Button>
            <Button onClick={() => void onBulkStage()} loading={bulkSubmitting}>
              {tCommon('save')}
            </Button>
          </>
        }
      >
        <Field label={t('bulk.stageTarget')} required>
          <Select
            value={bulkStageTarget}
            onChange={(e) => setBulkStageTarget(e.target.value as LeadStageCode | '')}
            required
          >
            <option value="">{t('bulk.pickStage')}</option>
            {stages.map((s) => (
              <option key={s.code} value={s.code}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
      </Modal>

      <Modal
        open={importing}
        title={tImport('title')}
        onClose={closeImport}
        footer={
          <>
            <Button variant="ghost" onClick={closeImport}>
              {tCommon('cancel')}
            </Button>
            <Button
              type="submit"
              form="leadImportForm"
              loading={importLoading}
              disabled={importLoading || importCsvText.length === 0}
            >
              {tImport('submit')}
            </Button>
          </>
        }
      >
        <form id="leadImportForm" className="flex flex-col gap-3" onSubmit={onSubmitImport}>
          {importError ? <Notice tone="error">{importError}</Notice> : null}
          {importResult ? (
            <Notice tone={importResult.errors.length > 0 ? 'info' : 'success'}>
              {tImport('result', {
                created: importResult.created,
                total: importResult.total,
                duplicates: importResult.duplicates,
                errors: importResult.errors.length,
              })}
              {importResult.errors.length > 0 ? (
                <ul className="mt-2 list-disc ps-5 text-xs text-ink-secondary">
                  {importResult.errors.slice(0, 20).map((e) => (
                    <li key={`${e.row}-${e.reason}`}>
                      {tImport('errorRow', { row: e.row, reason: e.reason })}
                    </li>
                  ))}
                </ul>
              ) : null}
            </Notice>
          ) : null}
          <Field label={tImport('fileLabel')} hint={tImport('fileHint')} required>
            <Input
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => void onPickCsvFile(e.target.files?.[0] ?? null)}
            />
          </Field>
          {importFile && importHeaders.length === 0 ? (
            <p className="text-xs text-ink-tertiary">{tImport('loadingHeaders')}</p>
          ) : null}
          {importHeaders.length > 0 ? (
            <>
              <Field label={tImport('mapName')} required>
                <Select
                  value={importMap.name}
                  onChange={(e) => setImportMap((m) => ({ ...m, name: e.target.value }))}
                  required
                >
                  <option value="">—</option>
                  {importHeaders.map((h) => (
                    <option key={h} value={h}>
                      {h}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={tImport('mapPhone')} required>
                <Select
                  value={importMap.phone}
                  onChange={(e) => setImportMap((m) => ({ ...m, phone: e.target.value }))}
                  required
                >
                  <option value="">—</option>
                  {importHeaders.map((h) => (
                    <option key={h} value={h}>
                      {h}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={tImport('mapEmail')}>
                <Select
                  value={importMap.email}
                  onChange={(e) => setImportMap((m) => ({ ...m, email: e.target.value }))}
                >
                  <option value="">—</option>
                  {importHeaders.map((h) => (
                    <option key={h} value={h}>
                      {h}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={tImport('defaultSource')}>
                <Select
                  value={importSource}
                  onChange={(e) => setImportSource(e.target.value as LeadSource)}
                >
                  {SOURCES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </Select>
              </Field>
              <label className="flex items-center gap-2 text-sm text-ink-primary">
                <input
                  type="checkbox"
                  checked={importAutoAssign}
                  onChange={(e) => setImportAutoAssign(e.target.checked)}
                />
                {tImport('autoAssign')}
              </label>
            </>
          ) : null}
        </form>
      </Modal>

      <Modal
        open={creating}
        title={t('newTitle')}
        onClose={closeForm}
        footer={
          <>
            <Button variant="ghost" onClick={closeForm}>
              {tCommon('cancel')}
            </Button>
            <Button type="submit" form="leadCreateForm" loading={submitting}>
              {tCommon('save')}
            </Button>
          </>
        }
      >
        <form id="leadCreateForm" className="flex flex-col gap-3" onSubmit={onCreate}>
          {formError ? <Notice tone="error">{formError}</Notice> : null}
          <Field label={t('name')} required>
            <Input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              required
              maxLength={120}
            />
          </Field>
          <Field label={t('phone')} required hint="E.164 format (e.g. +201001112222)">
            <Input
              value={form.phone}
              onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
              required
              minLength={6}
              maxLength={32}
            />
          </Field>
          <Field label={t('email')}>
            <Input
              type="email"
              value={form.email}
              onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
              maxLength={254}
            />
          </Field>
          <Field label={t('source')}>
            <Select
              value={form.source}
              onChange={(e) => setForm((f) => ({ ...f, source: e.target.value as LeadSource }))}
            >
              {SOURCES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </Field>
          {/* Phase 1B — explicit (company × country). Both optional;
              empty values let the server fall back to the tenant default
              pipeline. The country dropdown is filtered by the chosen
              company so admins can't pick an invalid (company, country)
              tuple. */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={t('company') ?? 'Company'}>
              <Select
                value={form.companyId}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    companyId: e.target.value,
                    // Drop the country if it no longer matches the new company.
                    countryId: '',
                  }))
                }
              >
                <option value="">— ({tCommon('all')})</option>
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('country') ?? 'Country'}>
              <Select
                value={form.countryId}
                onChange={(e) => setForm((f) => ({ ...f, countryId: e.target.value }))}
              >
                <option value="">— ({tCommon('all')})</option>
                {(form.companyId
                  ? countries.filter((c) => c.companyId === form.companyId)
                  : countries
                ).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label={t('stage')}>
            <Select
              value={form.stageCode}
              onChange={(e) =>
                setForm((f) => ({ ...f, stageCode: e.target.value as LeadStageCode | '' }))
              }
            >
              <option value="">— (default: new)</option>
              {stages.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('assignee')}>
            <Select
              value={form.assignedToId}
              onChange={(e) => setForm((f) => ({ ...f, assignedToId: e.target.value }))}
            >
              <option value="">{t('unassigned')}</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} ({u.email})
                </option>
              ))}
            </Select>
          </Field>
        </form>
      </Modal>
    </div>
  );
}
