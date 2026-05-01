'use client';

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ClipboardList, Loader2, MessageSquare, Phone, Plus } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataTable, type Column } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Select, Textarea } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Notice } from '@/components/ui/notice';
import { ApiError, leadsApi, pipelineApi } from '@/lib/api';
import type { Lead, LeadStageCode, PipelineStage, SlaStatus } from '@/lib/api-types';
import { getCachedMe } from '@/lib/auth';

/**
 * /agent/workspace (C31) — sales-agent "My Day" worklist.
 *
 * MVP columns: name / phone / stage / SLA. Agents can add a note or
 * move the stage inline without leaving the page. Reuses
 * `leadsApi.list({ assignedToId })`, `leadsApi.addActivity`, and
 * `leadsApi.moveStage` — no new backend.
 */

function slaTone(s: SlaStatus): 'healthy' | 'warning' | 'breach' | 'inactive' {
  if (s === 'breached') return 'breach';
  if (s === 'paused') return 'inactive';
  return 'healthy';
}

interface NoteFormState {
  body: string;
  submitting: boolean;
  error: string | null;
}

interface StageFormState {
  stageCode: LeadStageCode | '';
  submitting: boolean;
  error: string | null;
}

const EMPTY_NOTE: NoteFormState = { body: '', submitting: false, error: null };
const EMPTY_STAGE: StageFormState = { stageCode: '', submitting: false, error: null };

export default function AgentWorkspacePage(): JSX.Element {
  const t = useTranslations('agent.workspace');
  const tCommon = useTranslations('admin.common');

  const [meId, setMeId] = useState<string | null>(null);
  const [rows, setRows] = useState<Lead[]>([]);
  const [stages, setStages] = useState<PipelineStage[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Inline action state — keyed by lead id we're acting on.
  const [openNoteFor, setOpenNoteFor] = useState<Lead | null>(null);
  const [noteForm, setNoteForm] = useState<NoteFormState>(EMPTY_NOTE);
  const [openStageFor, setOpenStageFor] = useState<Lead | null>(null);
  const [stageForm, setStageForm] = useState<StageFormState>(EMPTY_STAGE);

  useEffect(() => {
    const me = getCachedMe();
    setMeId(me?.userId ?? null);
  }, []);

  const reload = useCallback(async (): Promise<void> => {
    if (!meId) return;
    setLoading(true);
    setError(null);
    try {
      const [page, st] = await Promise.all([
        leadsApi.list({ assignedToId: meId, limit: 200 }),
        pipelineApi.listStages(),
      ]);
      setRows(page.items);
      setStages(st);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [meId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const stageOptions = useMemo(
    () => stages.filter((s) => !s.isTerminal || s.code === 'converted' || s.code === 'lost'),
    [stages],
  );

  async function onSubmitNote(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (!openNoteFor || !noteForm.body.trim()) return;
    setNoteForm({ ...noteForm, submitting: true, error: null });
    try {
      await leadsApi.addActivity(openNoteFor.id, { type: 'note', body: noteForm.body.trim() });
      setNotice(t('noteAdded'));
      setOpenNoteFor(null);
      setNoteForm(EMPTY_NOTE);
      await reload();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : String(err);
      setNoteForm({ ...noteForm, submitting: false, error: message });
    }
  }

  async function onSubmitStage(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (!openStageFor || !stageForm.stageCode) return;
    setStageForm({ ...stageForm, submitting: true, error: null });
    try {
      await leadsApi.moveStage(openStageFor.id, stageForm.stageCode as LeadStageCode);
      setNotice(t('stageMoved'));
      setOpenStageFor(null);
      setStageForm(EMPTY_STAGE);
      await reload();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : String(err);
      setStageForm({ ...stageForm, submitting: false, error: message });
    }
  }

  const columns: ReadonlyArray<Column<Lead>> = [
    {
      key: 'name',
      header: t('cols.name'),
      render: (l) => (
        <div className="flex flex-col leading-tight">
          <span className="font-medium text-ink-primary">{l.name}</span>
          <span className="flex items-center gap-1 text-xs text-ink-tertiary">
            <Phone className="h-3 w-3" aria-hidden="true" />
            <code className="font-mono">{l.phone}</code>
          </span>
        </div>
      ),
    },
    {
      key: 'source',
      header: t('cols.source'),
      render: (l) => <span className="text-xs uppercase tracking-wide">{l.source}</span>,
    },
    {
      key: 'stage',
      header: t('cols.stage'),
      render: (l) => (
        <span className="inline-flex items-center gap-1 rounded-full border border-surface-border bg-surface px-2 py-0.5 text-xs">
          {l.stage.name}
        </span>
      ),
    },
    {
      key: 'sla',
      header: t('cols.sla'),
      render: (l) => <Badge tone={slaTone(l.slaStatus)}>{l.slaStatus}</Badge>,
    },
    {
      key: 'actions',
      header: t('cols.actions'),
      render: (l) => (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setOpenNoteFor(l);
              setNoteForm(EMPTY_NOTE);
            }}
          >
            <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
            {t('actions.addNote')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setOpenStageFor(l);
              setStageForm({ stageCode: l.stage.code, submitting: false, error: null });
            }}
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            {t('actions.moveStage')}
          </Button>
          <Link
            href={`/admin/leads/${l.id}`}
            className="text-xs font-medium text-brand-700 hover:text-brand-800"
          >
            {t('actions.openDetail')} →
          </Link>
        </div>
      ),
    },
  ];

  if (!meId) {
    return (
      <div className="flex flex-col gap-3">
        <header>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-ink-primary">
            <ClipboardList className="h-5 w-5 text-brand-700" aria-hidden="true" />
            {t('title')}
          </h1>
          <p className="mt-1 text-sm text-ink-secondary">{t('subtitle')}</p>
        </header>
        <Notice tone="info">{t('noUser')}</Notice>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="flex items-center gap-2 text-xl font-semibold text-ink-primary">
          <ClipboardList className="h-5 w-5 text-brand-700" aria-hidden="true" />
          {t('title')}
        </h1>
        <p className="mt-1 text-sm text-ink-secondary">{t('subtitle')}</p>
      </header>

      {notice ? <Notice tone="success">{notice}</Notice> : null}
      {error ? (
        <Notice tone="error">
          <div className="flex items-start justify-between gap-2">
            <span>{error}</span>
            <Button variant="ghost" size="sm" onClick={() => void reload()}>
              {tCommon('retry')}
            </Button>
          </div>
        </Notice>
      ) : null}

      {loading ? (
        <div className="flex items-center justify-center gap-2 rounded-lg border border-surface-border bg-surface-card p-8 text-sm text-ink-secondary">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          {tCommon('loading')}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<ClipboardList className="h-7 w-7" aria-hidden="true" />}
          title={t('emptyTitle')}
          body={t('emptyBody')}
        />
      ) : (
        <DataTable<Lead> rows={rows} columns={columns} keyOf={(l) => l.id} />
      )}

      <Modal
        open={openNoteFor !== null}
        title={t('noteModalTitle')}
        onClose={() => setOpenNoteFor(null)}
      >
        <form onSubmit={onSubmitNote} className="flex flex-col gap-3">
          {noteForm.error ? <Notice tone="error">{noteForm.error}</Notice> : null}
          <Field label={t('noteLabel')} required>
            <Textarea
              value={noteForm.body}
              onChange={(e) => setNoteForm({ ...noteForm, body: e.target.value })}
              rows={4}
              required
            />
          </Field>
          <div className="flex items-center justify-end gap-2">
            <Button variant="secondary" onClick={() => setOpenNoteFor(null)} type="button">
              {tCommon('cancel')}
            </Button>
            <Button type="submit" loading={noteForm.submitting} disabled={!noteForm.body.trim()}>
              {tCommon('save')}
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        open={openStageFor !== null}
        title={t('stageModalTitle')}
        onClose={() => setOpenStageFor(null)}
      >
        <form onSubmit={onSubmitStage} className="flex flex-col gap-3">
          {stageForm.error ? <Notice tone="error">{stageForm.error}</Notice> : null}
          <Field label={t('stageLabel')} required>
            <Select
              value={stageForm.stageCode}
              onChange={(e) =>
                setStageForm({ ...stageForm, stageCode: e.target.value as LeadStageCode })
              }
              required
            >
              <option value="" disabled>
                {t('stagePickerPlaceholder')}
              </option>
              {stageOptions.map((s) => (
                <option key={s.id} value={s.code}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex items-center justify-end gap-2">
            <Button variant="secondary" onClick={() => setOpenStageFor(null)} type="button">
              {tCommon('cancel')}
            </Button>
            <Button
              type="submit"
              loading={stageForm.submitting}
              disabled={!stageForm.stageCode || stageForm.stageCode === openStageFor?.stage.code}
            >
              {tCommon('save')}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
