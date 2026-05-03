'use client';

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input, Select } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { ApiError, companiesApi, countriesApi, pipelinesApi } from '@/lib/api';
import type { Company, Country, Pipeline, PipelineStageRow } from '@/lib/api-types';
import { cn } from '@/lib/utils';

/**
 * P2-07 — Pipeline Builder.
 *
 * Two-pane layout:
 *   - left: list of pipelines for the active tenant. The default
 *     pipeline is pinned to the top with a "Default" badge.
 *   - right: stage editor for the selected pipeline. Add / rename /
 *     toggle terminal / reorder / delete stages. Reorder uses a
 *     pair of arrow buttons to move a stage up or down; on save we
 *     POST the full id list to /pipelines/:id/stages/reorder.
 */
export default function PipelineBuilderPage(): JSX.Element {
  const t = useTranslations('admin.pipelineBuilder');
  const tCommon = useTranslations('admin.common');

  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [countries, setCountries] = useState<Country[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Pipeline | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Create-pipeline dialog state.
  const [createOpen, setCreateOpen] = useState<boolean>(false);
  const [createForm, setCreateForm] = useState<{
    name: string;
    companyId: string;
    countryId: string;
  }>({ name: '', companyId: '', countryId: '' });
  const [createErr, setCreateErr] = useState<string | null>(null);
  const [creating, setCreating] = useState<boolean>(false);

  // Add-stage dialog state.
  const [stageDialog, setStageDialog] = useState<boolean>(false);
  const [stageForm, setStageForm] = useState<{
    code: string;
    name: string;
    isTerminal: boolean;
    /**
     * Phase A — A6: terminalKind ∈ { 'won', 'lost', null }. Server
     * rejects non-null when isTerminal=false; the UI mirrors the
     * invariant by clearing the field whenever isTerminal flips off.
     */
    terminalKind: '' | 'won' | 'lost';
  }>({ code: '', name: '', isTerminal: false, terminalKind: '' });
  const [stageErr, setStageErr] = useState<string | null>(null);
  const [savingStage, setSavingStage] = useState<boolean>(false);

  // Inline-edit state for an existing stage.
  const [editingStageId, setEditingStageId] = useState<string | null>(null);
  const [editStageForm, setEditStageForm] = useState<{
    name: string;
    isTerminal: boolean;
    terminalKind: '' | 'won' | 'lost';
  }>({
    name: '',
    isTerminal: false,
    terminalKind: '',
  });

  // Inline-edit state for the pipeline name itself.
  const [renamingPipeline, setRenamingPipeline] = useState<boolean>(false);
  const [renameValue, setRenameValue] = useState<string>('');

  const reloadList = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const [list, comps, ctries] = await Promise.all([
        pipelinesApi.list(),
        companiesApi.list().catch(() => [] as Company[]),
        countriesApi.list().catch(() => [] as Country[]),
      ]);
      setPipelines(list);
      setCompanies(comps);
      setCountries(ctries);
      // Auto-pick the default pipeline on first load.
      if (selectedId === null && list.length > 0) {
        setSelectedId(list.find((p) => p.isDefault)?.id ?? list[0]!.id);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [selectedId]);

  const reloadDetail = useCallback(async (): Promise<void> => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    try {
      const d = await pipelinesApi.get(selectedId);
      setDetail(d);
      setRenameValue(d.name);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, [selectedId]);

  useEffect(() => {
    void reloadList();
  }, [reloadList]);
  useEffect(() => {
    void reloadDetail();
  }, [reloadDetail]);

  const countriesForCompany = useMemo(() => {
    if (!createForm.companyId) return countries;
    return countries.filter((c) => c.companyId === createForm.companyId);
  }, [countries, createForm.companyId]);

  // ─────── pipeline create ───────

  function openCreate(): void {
    setCreateForm({ name: '', companyId: '', countryId: '' });
    setCreateErr(null);
    setCreateOpen(true);
  }

  async function onCreatePipeline(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setCreating(true);
    setCreateErr(null);
    try {
      const created = await pipelinesApi.create({
        name: createForm.name,
        companyId: createForm.companyId || null,
        countryId: createForm.countryId || null,
        isActive: true,
      });
      setCreateOpen(false);
      setSelectedId(created.id);
      setNotice(tCommon('created'));
      await reloadList();
    } catch (err) {
      setCreateErr(err instanceof ApiError ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  // ─────── pipeline rename / activate / delete ───────

  async function onRenamePipeline(): Promise<void> {
    if (!detail) return;
    if (renameValue.trim().length === 0 || renameValue === detail.name) {
      setRenamingPipeline(false);
      return;
    }
    try {
      await pipelinesApi.update(detail.id, { name: renameValue.trim() });
      setRenamingPipeline(false);
      setNotice(tCommon('saved'));
      await Promise.all([reloadList(), reloadDetail()]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  async function togglePipelineActive(): Promise<void> {
    if (!detail) return;
    try {
      await pipelinesApi.update(detail.id, { isActive: !detail.isActive });
      setNotice(tCommon('saved'));
      await Promise.all([reloadList(), reloadDetail()]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  async function onDeletePipeline(): Promise<void> {
    if (!detail) return;
    if (!window.confirm(t('deleteConfirm'))) return;
    try {
      await pipelinesApi.remove(detail.id);
      setSelectedId(null);
      setNotice(tCommon('saved'));
      await reloadList();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  // ─────── stage CRUD ───────

  function openAddStage(): void {
    setStageForm({ code: '', name: '', isTerminal: false, terminalKind: '' });
    setStageErr(null);
    setStageDialog(true);
  }

  async function onAddStage(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (!detail) return;
    setSavingStage(true);
    setStageErr(null);
    try {
      await pipelinesApi.addStage(detail.id, {
        code: stageForm.code.trim(),
        name: stageForm.name.trim(),
        isTerminal: stageForm.isTerminal,
        // Phase A — A6: only forward terminalKind on terminal stages.
        // Sending a non-null value for a non-terminal stage would be
        // rejected server-side; the form already clears the field
        // when the checkbox flips off, but the guard is cheap.
        ...(stageForm.isTerminal && stageForm.terminalKind
          ? { terminalKind: stageForm.terminalKind }
          : {}),
      });
      setStageDialog(false);
      setNotice(tCommon('created'));
      await reloadDetail();
    } catch (err) {
      setStageErr(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSavingStage(false);
    }
  }

  function openEditStage(stage: PipelineStageRow): void {
    setEditingStageId(stage.id);
    setEditStageForm({
      name: stage.name,
      isTerminal: stage.isTerminal,
      terminalKind: stage.terminalKind ?? '',
    });
  }

  async function onSaveStage(stageId: string): Promise<void> {
    if (!detail) return;
    try {
      await pipelinesApi.updateStage(detail.id, stageId, {
        name: editStageForm.name.trim(),
        isTerminal: editStageForm.isTerminal,
        // Phase A — A6: explicit terminalKind write-through.
        // When isTerminal flips off in the patch, send `null` to
        // clear any existing classifier so the server invariant
        // (non-terminal ⇒ terminalKind null) holds.
        terminalKind: editStageForm.isTerminal ? editStageForm.terminalKind || null : null,
      });
      setEditingStageId(null);
      setNotice(tCommon('saved'));
      await reloadDetail();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  async function onDeleteStage(stage: PipelineStageRow): Promise<void> {
    if (!detail) return;
    if (!window.confirm(t('deleteStageConfirm'))) return;
    try {
      await pipelinesApi.removeStage(detail.id, stage.id);
      setNotice(tCommon('saved'));
      await reloadDetail();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  async function moveStage(stageId: string, direction: -1 | 1): Promise<void> {
    if (!detail || !detail.stages) return;
    const ordered = [...detail.stages].sort((a, b) => a.order - b.order);
    const idx = ordered.findIndex((s) => s.id === stageId);
    if (idx < 0) return;
    const targetIdx = idx + direction;
    if (targetIdx < 0 || targetIdx >= ordered.length) return;
    const swapped = [...ordered];
    [swapped[idx], swapped[targetIdx]] = [swapped[targetIdx]!, swapped[idx]!];
    try {
      await pipelinesApi.reorderStages(
        detail.id,
        swapped.map((s) => s.id),
      );
      await reloadDetail();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  // ─────── render ───────

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          <Button onClick={openCreate}>
            <Plus className="h-4 w-4" />
            {t('newButton')}
          </Button>
        }
      />

      {error ? (
        <Notice tone="error">
          <div className="flex items-start justify-between gap-3">
            <span>{error}</span>
            <Button variant="ghost" size="sm" onClick={() => void reloadList()}>
              {tCommon('retry')}
            </Button>
          </div>
        </Notice>
      ) : null}
      {notice ? <Notice tone="success">{notice}</Notice> : null}

      <div className="grid gap-4 md:grid-cols-[280px_1fr]">
        {/* Left: pipelines list */}
        <aside className="rounded-lg border border-surface-border bg-surface-card shadow-card">
          {loading ? (
            <p className="p-4 text-sm text-ink-secondary">{tCommon('loading')}</p>
          ) : pipelines.length === 0 ? (
            <EmptyState title={t('noPipelines')} />
          ) : (
            <ul className="flex flex-col">
              {pipelines.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(p.id)}
                    className={cn(
                      'flex w-full flex-col gap-1 border-b border-surface-border px-3 py-2.5 text-left text-sm hover:bg-brand-50/40',
                      p.id === selectedId && 'bg-brand-50',
                    )}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="font-medium text-ink-primary">{p.name}</span>
                      {p.isDefault ? (
                        <Badge tone="info">{t('default')}</Badge>
                      ) : !p.isActive ? (
                        <Badge tone="inactive">{tCommon('inactive')}</Badge>
                      ) : null}
                    </span>
                    <span className="text-xs text-ink-tertiary">
                      {p.company ? p.company.name : t('tenantWide')}
                      {p.country ? ` · ${p.country.name}` : ''}
                    </span>
                    <span className="text-xs text-ink-tertiary">
                      {t('stagesCount')}: {p._count?.stages ?? 0}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        {/* Right: stage editor */}
        <section className="rounded-lg border border-surface-border bg-surface-card p-4 shadow-card">
          {!detail ? (
            <p className="text-sm text-ink-secondary">{t('selectPipelineHint')}</p>
          ) : (
            <div className="flex flex-col gap-4">
              <header className="flex flex-wrap items-center justify-between gap-3 border-b border-surface-border pb-3">
                <div className="flex flex-col gap-1">
                  {renamingPipeline ? (
                    <div className="flex items-center gap-2">
                      <Input
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        autoFocus
                      />
                      <Button size="sm" onClick={() => void onRenamePipeline()}>
                        {t('save')}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setRenamingPipeline(false);
                          setRenameValue(detail.name);
                        }}
                      >
                        {t('cancel')}
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <h2 className="text-lg font-semibold text-ink-primary">{detail.name}</h2>
                      {detail.isDefault ? <Badge tone="info">{t('default')}</Badge> : null}
                      {!detail.isActive ? (
                        <Badge tone="inactive">{tCommon('inactive')}</Badge>
                      ) : null}
                    </div>
                  )}
                  <p className="text-xs text-ink-tertiary">
                    {detail.company ? detail.company.name : t('tenantWide')}
                    {detail.country ? ` · ${detail.country.name}` : ''}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {!renamingPipeline ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setRenameValue(detail.name);
                        setRenamingPipeline(true);
                      }}
                    >
                      {t('rename')}
                    </Button>
                  ) : null}
                  {!detail.isDefault ? (
                    <>
                      <Button size="sm" variant="ghost" onClick={() => void togglePipelineActive()}>
                        {detail.isActive ? t('deactivate') : t('activate')}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void onDeletePipeline()}>
                        <Trash2 className="h-3.5 w-3.5" />
                        {tCommon('delete')}
                      </Button>
                    </>
                  ) : null}
                </div>
              </header>

              <section className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-ink-primary">{t('stagesTitle')}</h3>
                  <Button size="sm" onClick={openAddStage}>
                    <Plus className="h-3.5 w-3.5" />
                    {t('addStage')}
                  </Button>
                </div>
                <ul className="flex flex-col rounded-md border border-surface-border bg-surface">
                  {(detail.stages ?? [])
                    .slice()
                    .sort((a, b) => a.order - b.order)
                    .map((stage, idx, all) => {
                      const isEditing = editingStageId === stage.id;
                      return (
                        <li
                          key={stage.id}
                          className="flex flex-wrap items-center gap-2 border-b border-surface-border px-3 py-2 text-sm last:border-b-0"
                        >
                          <span className="w-10 text-xs text-ink-tertiary">#{stage.order}</span>
                          {isEditing ? (
                            <div className="flex flex-1 flex-wrap items-center gap-2">
                              <Input
                                value={editStageForm.name}
                                onChange={(e) =>
                                  setEditStageForm((f) => ({ ...f, name: e.target.value }))
                                }
                                className="max-w-xs"
                              />
                              <label className="flex items-center gap-2 text-xs text-ink-secondary">
                                <input
                                  type="checkbox"
                                  checked={editStageForm.isTerminal}
                                  onChange={(e) =>
                                    setEditStageForm((f) => ({
                                      ...f,
                                      isTerminal: e.target.checked,
                                      // Reset terminalKind when the
                                      // stage stops being terminal so
                                      // we don't send a stale value.
                                      terminalKind: e.target.checked ? f.terminalKind : '',
                                    }))
                                  }
                                />
                                {t('stageTerminal')}
                              </label>
                              {/* Phase A — A6: terminalKind picker.
                                  Only meaningful on terminal stages,
                                  so it's hidden when the checkbox is
                                  off. None / won / lost are the
                                  three values the server accepts. */}
                              {editStageForm.isTerminal ? (
                                <select
                                  value={editStageForm.terminalKind}
                                  onChange={(e) =>
                                    setEditStageForm((f) => ({
                                      ...f,
                                      terminalKind: e.target.value as '' | 'won' | 'lost',
                                    }))
                                  }
                                  className="h-8 rounded-md border border-surface-border bg-surface-card px-2 text-xs text-ink-primary"
                                  aria-label={t('stageTerminalKind')}
                                >
                                  <option value="">— {t('stageTerminalKindNone')}</option>
                                  <option value="won">{t('stageTerminalKindWon')}</option>
                                  <option value="lost">{t('stageTerminalKindLost')}</option>
                                </select>
                              ) : null}
                              <Button size="sm" onClick={() => void onSaveStage(stage.id)}>
                                {t('save')}
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => setEditingStageId(null)}
                              >
                                {t('cancel')}
                              </Button>
                            </div>
                          ) : (
                            <>
                              <span className="flex-1 font-medium text-ink-primary">
                                {stage.name}
                                <span className="ms-2 text-xs text-ink-tertiary">
                                  ({stage.code})
                                </span>
                              </span>
                              {stage.isTerminal ? (
                                <Badge tone="inactive">{t('stageTerminal')}</Badge>
                              ) : null}
                              {/* Phase A — A6: surface the lifecycle
                                  classifier so admins can see at a
                                  glance which terminal stage means
                                  what. 'won' / 'lost' / nothing. */}
                              {stage.terminalKind === 'won' ? (
                                <Badge tone="healthy">{t('stageTerminalKindWon')}</Badge>
                              ) : stage.terminalKind === 'lost' ? (
                                <Badge tone="breach">{t('stageTerminalKindLost')}</Badge>
                              ) : null}
                              <Button
                                size="sm"
                                variant="ghost"
                                title={t('moveUp')}
                                disabled={idx === 0}
                                onClick={() => void moveStage(stage.id, -1)}
                              >
                                <ArrowUp className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                title={t('moveDown')}
                                disabled={idx === all.length - 1}
                                onClick={() => void moveStage(stage.id, 1)}
                              >
                                <ArrowDown className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => openEditStage(stage)}
                              >
                                {t('edit')}
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => void onDeleteStage(stage)}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </>
                          )}
                        </li>
                      );
                    })}
                  {(detail.stages ?? []).length === 0 ? (
                    <li className="px-3 py-3 text-xs text-ink-tertiary">—</li>
                  ) : null}
                </ul>
              </section>
            </div>
          )}
        </section>
      </div>

      {/* Create-pipeline modal */}
      <Modal
        open={createOpen}
        title={t('newTitle')}
        onClose={() => setCreateOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              {t('cancel')}
            </Button>
            <Button type="submit" form="pipelineCreateForm" loading={creating}>
              {t('save')}
            </Button>
          </>
        }
      >
        <form id="pipelineCreateForm" className="flex flex-col gap-3" onSubmit={onCreatePipeline}>
          {createErr ? <Notice tone="error">{createErr}</Notice> : null}
          <Field label={t('name')} required>
            <Input
              required
              value={createForm.name}
              onChange={(e) => setCreateForm((f) => ({ ...f, name: e.target.value }))}
              maxLength={120}
            />
          </Field>
          <Field label={t('company')}>
            <Select
              value={createForm.companyId}
              onChange={(e) =>
                setCreateForm((f) => ({ ...f, companyId: e.target.value, countryId: '' }))
              }
            >
              <option value="">{t('anyCompany')}</option>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('country')}>
            <Select
              value={createForm.countryId}
              onChange={(e) => setCreateForm((f) => ({ ...f, countryId: e.target.value }))}
              disabled={createForm.companyId === '' && countriesForCompany.length === 0}
            >
              <option value="">{t('anyCountry')}</option>
              {countriesForCompany.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
        </form>
      </Modal>

      {/* Add-stage modal */}
      <Modal
        open={stageDialog}
        title={t('addStageTitle')}
        onClose={() => setStageDialog(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setStageDialog(false)}>
              {t('cancel')}
            </Button>
            <Button type="submit" form="stageCreateForm" loading={savingStage}>
              {t('save')}
            </Button>
          </>
        }
      >
        <form id="stageCreateForm" className="flex flex-col gap-3" onSubmit={onAddStage}>
          {stageErr ? <Notice tone="error">{stageErr}</Notice> : null}
          <Field label={t('stageCode')} required hint="snake_case">
            <Input
              required
              value={stageForm.code}
              onChange={(e) => setStageForm((f) => ({ ...f, code: e.target.value }))}
              pattern="[a-z][a-z0-9_]*"
              maxLength={40}
            />
          </Field>
          <Field label={t('stageName')} required>
            <Input
              required
              value={stageForm.name}
              onChange={(e) => setStageForm((f) => ({ ...f, name: e.target.value }))}
              maxLength={120}
            />
          </Field>
          <label className="flex items-center gap-2 text-sm text-ink-primary">
            <input
              type="checkbox"
              checked={stageForm.isTerminal}
              onChange={(e) =>
                setStageForm((f) => ({
                  ...f,
                  isTerminal: e.target.checked,
                  // Clear terminalKind when the stage stops being
                  // terminal so the submit doesn't ship a stale
                  // value that the server would reject.
                  terminalKind: e.target.checked ? f.terminalKind : '',
                }))
              }
            />
            {t('stageTerminal')}
          </label>
          {/* Phase A — A6: terminalKind picker. Hidden until the
              stage is marked terminal. None = no lifecycle effect on
              move; won = lifecycle becomes 'won'; lost = lifecycle
              becomes 'lost' (and the lost-reason modal fires). */}
          {stageForm.isTerminal ? (
            <Field label={t('stageTerminalKind')} hint={t('stageTerminalKindHint')}>
              <select
                value={stageForm.terminalKind}
                onChange={(e) =>
                  setStageForm((f) => ({
                    ...f,
                    terminalKind: e.target.value as '' | 'won' | 'lost',
                  }))
                }
                className="block h-9 w-full rounded-md border border-surface-border bg-surface-card px-3 text-sm text-ink-primary"
              >
                <option value="">— {t('stageTerminalKindNone')}</option>
                <option value="won">{t('stageTerminalKindWon')}</option>
                <option value="lost">{t('stageTerminalKindLost')}</option>
              </select>
            </Field>
          ) : null}
        </form>
      </Modal>
    </div>
  );
}
