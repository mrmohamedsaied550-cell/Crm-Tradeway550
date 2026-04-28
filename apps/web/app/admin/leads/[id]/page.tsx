'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, useCallback, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowLeft } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Select, Textarea } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { ApiError, leadsApi, pipelineApi, usersApi } from '@/lib/api';
import type {
  AdminUser,
  Lead,
  LeadActivity,
  LeadActivityType,
  LeadStageCode,
  PipelineStage,
  SlaStatus,
} from '@/lib/api-types';

function slaTone(s: SlaStatus): 'healthy' | 'warning' | 'breach' | 'inactive' {
  if (s === 'breached') return 'breach';
  if (s === 'paused') return 'inactive';
  return 'healthy';
}

function activityTone(t: LeadActivityType): 'info' | 'warning' | 'breach' | 'neutral' {
  if (t === 'sla_breach') return 'breach';
  if (t === 'auto_assignment' || t === 'assignment') return 'info';
  if (t === 'stage_change') return 'warning';
  return 'neutral';
}

export default function LeadDetailPage(): JSX.Element {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const router = useRouter();
  const t = useTranslations('admin.leads');
  const tCommon = useTranslations('admin.common');

  const [lead, setLead] = useState<Lead | null>(null);
  const [activities, setActivities] = useState<LeadActivity[]>([]);
  const [stages, setStages] = useState<PipelineStage[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Inline action state
  const [assigneeId, setAssigneeId] = useState<string>('');
  const [stageCode, setStageCode] = useState<LeadStageCode | ''>('');
  const [activityType, setActivityType] = useState<'note' | 'call'>('note');
  const [activityBody, setActivityBody] = useState<string>('');
  const [actionPending, setActionPending] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const [l, acts, st, usrs] = await Promise.all([
        leadsApi.get(id),
        leadsApi.listActivities(id),
        pipelineApi.listStages(),
        usersApi
          .list({ status: 'active', limit: 200 })
          .catch(() => ({ items: [] as AdminUser[], total: 0, limit: 200, offset: 0 })),
      ]);
      setLead(l);
      setActivities(acts);
      setStages(st);
      setUsers(usrs.items);
      setAssigneeId(l.assignedToId ?? '');
      setStageCode(l.stage.code);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const userById = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);

  async function onAssign(): Promise<void> {
    if (!lead) return;
    setActionPending('assign');
    setError(null);
    try {
      await leadsApi.assign(lead.id, assigneeId || null);
      setNotice(tCommon('saved'));
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setActionPending(null);
    }
  }

  async function onMoveStage(): Promise<void> {
    if (!lead || !stageCode) return;
    setActionPending('stage');
    setError(null);
    try {
      await leadsApi.moveStage(lead.id, stageCode);
      setNotice(tCommon('saved'));
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setActionPending(null);
    }
  }

  async function onAddActivity(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (!lead || !activityBody.trim()) return;
    setActionPending('activity');
    setError(null);
    try {
      await leadsApi.addActivity(lead.id, { type: activityType, body: activityBody.trim() });
      setActivityBody('');
      setNotice(tCommon('saved'));
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setActionPending(null);
    }
  }

  async function onConvert(): Promise<void> {
    if (!lead) return;
    if (!window.confirm(t('convertHint'))) return;
    setActionPending('convert');
    setError(null);
    try {
      await leadsApi.convert(lead.id);
      setNotice(tCommon('saved'));
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setActionPending(null);
    }
  }

  if (loading && !lead) {
    return <p className="text-sm text-ink-secondary">{tCommon('loading')}</p>;
  }
  if (error && !lead) {
    return <Notice tone="error">{error}</Notice>;
  }
  if (!lead) return <p className="text-sm text-ink-secondary">{tCommon('loading')}</p>;

  const isConverted = Boolean(lead.captain) || lead.stage.code === 'converted';

  return (
    <div className="flex flex-col gap-4">
      <Link
        href="/admin/leads"
        className="inline-flex items-center gap-1 text-xs font-medium text-ink-secondary hover:text-brand-700"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> {t('title')}
      </Link>

      <PageHeader
        title={lead.name}
        subtitle={`${lead.phone}${lead.email ? ` · ${lead.email}` : ''}`}
        actions={
          <div className="flex items-center gap-2">
            <Badge tone={lead.stage.isTerminal ? 'inactive' : 'info'}>{lead.stage.name}</Badge>
            <Badge tone={slaTone(lead.slaStatus)}>{lead.slaStatus}</Badge>
          </div>
        }
      />

      {error ? <Notice tone="error">{error}</Notice> : null}
      {notice ? <Notice tone="success">{notice}</Notice> : null}

      {/* ───── Actions ───── */}
      <section className="rounded-lg border border-surface-border bg-surface-card p-5 shadow-card">
        <h2 className="mb-4 text-sm font-semibold text-ink-primary">{t('actionsTitle')}</h2>

        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {/* Assign */}
          <div className="flex flex-col gap-2">
            <Field label={t('assignAction')}>
              <Select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
                <option value="">{t('unassigned')}</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name} ({u.email})
                  </option>
                ))}
              </Select>
            </Field>
            <Button onClick={() => void onAssign()} loading={actionPending === 'assign'}>
              {tCommon('save')}
            </Button>
          </div>

          {/* Move stage */}
          <div className="flex flex-col gap-2">
            <Field label={t('moveStageAction')}>
              <Select
                value={stageCode}
                onChange={(e) => setStageCode(e.target.value as LeadStageCode)}
              >
                {stages.map((s) => (
                  <option key={s.code} value={s.code}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Button
              onClick={() => void onMoveStage()}
              loading={actionPending === 'stage'}
              disabled={stageCode === lead.stage.code}
            >
              {tCommon('save')}
            </Button>
          </div>

          {/* Convert */}
          <div className="flex flex-col gap-2">
            <Field label={t('convertAction')} hint={t('convertHint')}>
              <span className="text-xs text-ink-tertiary">
                {isConverted ? t('convertedAlready') : '—'}
              </span>
            </Field>
            <Button
              variant="primary"
              onClick={() => void onConvert()}
              loading={actionPending === 'convert'}
              disabled={isConverted}
            >
              {t('convertAction')}
            </Button>
          </div>
        </div>
      </section>

      {/* ───── Add activity ───── */}
      <section className="rounded-lg border border-surface-border bg-surface-card p-5 shadow-card">
        <h2 className="mb-4 text-sm font-semibold text-ink-primary">
          {t('addNote')} / {t('addCall')}
        </h2>
        <form onSubmit={onAddActivity} className="flex flex-col gap-3">
          <div className="grid gap-3 md:grid-cols-[160px_1fr]">
            <Field label={t('addActivityType')}>
              <Select
                value={activityType}
                onChange={(e) => setActivityType(e.target.value as 'note' | 'call')}
              >
                <option value="note">{t('addNote')}</option>
                <option value="call">{t('addCall')}</option>
              </Select>
            </Field>
            <Field label={t('addActivityBody')}>
              <Textarea
                value={activityBody}
                onChange={(e) => setActivityBody(e.target.value)}
                maxLength={4000}
                placeholder="…"
              />
            </Field>
          </div>
          <div className="flex items-center justify-end">
            <Button
              type="submit"
              loading={actionPending === 'activity'}
              disabled={!activityBody.trim()}
            >
              {tCommon('save')}
            </Button>
          </div>
        </form>
      </section>

      {/* ───── Activity timeline ───── */}
      <section className="rounded-lg border border-surface-border bg-surface-card p-5 shadow-card">
        <h2 className="mb-4 text-sm font-semibold text-ink-primary">{t('activitiesTitle')}</h2>

        {activities.length === 0 ? (
          <p className="text-sm text-ink-tertiary">—</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {activities.map((a) => (
              <li
                key={a.id}
                className="rounded-md border border-surface-border bg-surface px-3 py-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <Badge tone={activityTone(a.type)}>{a.type}</Badge>
                  <span className="text-xs text-ink-tertiary">
                    {new Date(a.createdAt).toLocaleString()}
                    {a.createdById
                      ? ` · ${userById.get(a.createdById)?.name ?? a.createdById.slice(0, 8)}`
                      : ''}
                  </span>
                </div>
                {a.body ? <p className="mt-1.5 text-sm text-ink-primary">{a.body}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Footer back link kept simple — also lives at the top via the breadcrumb. */}
      <div className="text-end">
        <Button variant="ghost" onClick={() => router.push('/admin/leads')}>
          {t('title')}
        </Button>
      </div>
    </div>
  );
}
