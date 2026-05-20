'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, useCallback, type FormEvent } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import {
  ArrowLeft,
  ArrowRightLeft,
  Calendar,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FileText,
  Mail,
  MessageCircle,
  Phone,
  PhoneCall,
  Plus,
  Send,
  Settings,
  StickyNote,
  TriangleAlert,
  Trophy,
  UserCog,
  UserPlus,
  Users,
  X,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Select, Textarea, Input } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import {
  ApiError,
  leadsApi,
  pipelineApi,
  teamsApi,
  usersApi,
  leadStatusesApi,
  leadDocumentsApi,
  followUpsApi,
  leadConversationsApi,
  conversationsApi,
} from '@/lib/api';
import type {
  AdminUser,
  Lead,
  LeadActivity,
  LeadActivityType,
  LeadDocument,
  LeadFollowUp,
  LeadStageCode,
  PipelineStage,
  PipelineStageWithStatuses,
  SlaStatus,
  Team,
  WhatsAppConversation,
  WhatsAppMessage,
  FollowUpMethod,
} from '@/lib/api-types';
import { cn } from '@/lib/utils';

// ───────────────────────────────────────────────────────────────────────
// Utility helpers
// ───────────────────────────────────────────────────────────────────────

function slaTone(s: SlaStatus): 'healthy' | 'warning' | 'breach' | 'inactive' {
  if (s === 'breached') return 'breach';
  if (s === 'paused') return 'inactive';
  return 'healthy';
}

function activityTone(
  type: LeadActivityType,
): 'info' | 'warning' | 'breach' | 'neutral' | 'healthy' {
  switch (type) {
    case 'sla_breach':
      return 'breach';
    case 'assignment':
    case 'auto_assignment':
      return 'info';
    case 'stage_change':
    case 'status_change':
      return 'warning';
    case 'note':
    case 'call':
      return 'healthy';
    default:
      return 'neutral';
  }
}

const ACTIVITY_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  note: StickyNote,
  call: Phone,
  stage_change: ArrowRightLeft,
  status_change: ArrowRightLeft,
  assignment: UserPlus,
  auto_assignment: Users,
  sla_breach: TriangleAlert,
  follow_up: Calendar,
  document: FileText,
  system: Settings,
};

function formatRelative(target: Date, now: Date, locale: string): string {
  const diffMs = target.getTime() - now.getTime();
  const abs = Math.abs(diffMs);
  const units: ReadonlyArray<[Intl.RelativeTimeFormatUnit, number]> = [
    ['day', 24 * 60 * 60 * 1000],
    ['hour', 60 * 60 * 1000],
    ['minute', 60 * 1000],
    ['second', 1000],
  ];
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  for (const [unit, ms] of units) {
    if (abs >= ms || unit === 'second') {
      return rtf.format(Math.round(diffMs / ms), unit);
    }
  }
  return '';
}

interface PayloadShape {
  event?: string;
  fromStageCode?: string;
  toStageCode?: string;
  fromUserId?: string | null;
  toUserId?: string | null;
  strategy?: string;
  captainId?: string;
  reason?: string;
  fromStatus?: string;
  toStatus?: string;
}

function readPayload(raw: Record<string, unknown> | null): PayloadShape {
  if (!raw) return {};
  const out: PayloadShape = {};
  if (typeof raw['event'] === 'string') out.event = raw['event'];
  if (typeof raw['fromStageCode'] === 'string') out.fromStageCode = raw['fromStageCode'];
  if (typeof raw['toStageCode'] === 'string') out.toStageCode = raw['toStageCode'];
  if (typeof raw['fromUserId'] === 'string' || raw['fromUserId'] === null)
    out.fromUserId = raw['fromUserId'] as string | null;
  if (typeof raw['toUserId'] === 'string' || raw['toUserId'] === null)
    out.toUserId = raw['toUserId'] as string | null;
  if (typeof raw['strategy'] === 'string') out.strategy = raw['strategy'];
  if (typeof raw['captainId'] === 'string') out.captainId = raw['captainId'];
  if (typeof raw['reason'] === 'string') out.reason = raw['reason'];
  if (typeof raw['fromStatus'] === 'string') out.fromStatus = raw['fromStatus'];
  if (typeof raw['toStatus'] === 'string') out.toStatus = raw['toStatus'];
  return out;
}

// ───────────────────────────────────────────────────────────────────────
// Main Page Component
// ───────────────────────────────────────────────────────────────────────

export default function LeadDetailPage(): JSX.Element {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const router = useRouter();
  const locale = useLocale();
  const t = useTranslations('admin.leads');
  const tCommon = useTranslations('admin.common');
  const tDetail = useTranslations('admin.leads.detail');

  // Core state
  const [lead, setLead] = useState<Lead | null>(null);
  const [activities, setActivities] = useState<LeadActivity[]>([]);
  const [stages, setStages] = useState<PipelineStage[]>([]);
  const [stagesWithStatuses, setStagesWithStatuses] = useState<PipelineStageWithStatuses[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [documents, setDocuments] = useState<LeadDocument[]>([]);
  const [followUps, setFollowUps] = useState<LeadFollowUp[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // UI state
  const [assigneeId, setAssigneeId] = useState<string>('');
  const [stageCode, setStageCode] = useState<LeadStageCode | ''>('');
  const [activityType, setActivityType] = useState<'note' | 'call'>('note');
  const [activityBody, setActivityBody] = useState<string>('');
  const [actionPending, setActionPending] = useState<string | null>(null);
  const [stageMenuOpen, setStageMenuOpen] = useState<boolean>(false);
  const [addActionOpen, setAddActionOpen] = useState<boolean>(false);
  const [addActionCategory, setAddActionCategory] = useState<string | null>(null);
  const [whatsappOpen, setWhatsappOpen] = useState<boolean>(false);
  const [followUpModalOpen, setFollowUpModalOpen] = useState<boolean>(false);
  const [statusChangeOpen, setStatusChangeOpen] = useState<boolean>(false);

  // WhatsApp state
  const [conversations, setConversations] = useState<WhatsAppConversation[]>([]);
  const [messages, setMessages] = useState<WhatsAppMessage[]>([]);
  const [waMessage, setWaMessage] = useState<string>('');
  const [waLoading, setWaLoading] = useState<boolean>(false);

  // Follow-up form state
  const [fuMethod, setFuMethod] = useState<FollowUpMethod>('call');
  const [fuDate, setFuDate] = useState<string>('');
  const [fuNote, setFuNote] = useState<string>('');

  // Refs
  const composerSectionRef = useRef<HTMLElement | null>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  // ─────── Data loading ───────

  const reload = useCallback(async (): Promise<void> => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const [l, acts, st, stWithStatuses, usrs, tms, docs, fups] = await Promise.all([
        leadsApi.get(id),
        leadsApi.listActivities(id),
        pipelineApi.listStages(),
        pipelineApi.listStagesWithStatuses().catch(() => [] as PipelineStageWithStatuses[]),
        usersApi
          .list({ limit: 200 })
          .catch(() => ({ items: [] as AdminUser[], total: 0, limit: 200, offset: 0 })),
        teamsApi.list().catch(() => [] as Team[]),
        leadDocumentsApi.list(id).catch(() => [] as LeadDocument[]),
        followUpsApi.listForLead(id).catch(() => [] as LeadFollowUp[]),
      ]);
      setLead(l);
      setActivities(acts);
      setStages(st);
      setStagesWithStatuses(stWithStatuses);
      setUsers(usrs.items);
      setTeams(tms);
      setDocuments(docs);
      setFollowUps(fups);
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

  // Derived lookup maps
  const userById = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);
  const teamById = useMemo(() => new Map(teams.map((tm) => [tm.id, tm])), [teams]);
  const stageByCode = useMemo(() => new Map(stages.map((s) => [s.code, s])), [stages]);
  const activeUsers = useMemo(() => users.filter((u) => u.status === 'active'), [users]);

  // Current stage's available statuses
  const currentStageStatuses = useMemo(() => {
    if (!lead) return [];
    const found = stagesWithStatuses.find((s) => s.code === lead.stage.code);
    return found?.statuses ?? [];
  }, [lead, stagesWithStatuses]);

  const stageLabel = useCallback(
    (code: string | undefined): string => {
      if (!code) return '—';
      return stageByCode.get(code)?.name ?? code;
    },
    [stageByCode],
  );

  const userLabel = useCallback(
    (uid: string | null | undefined): string => {
      if (!uid) return tDetail('unassigned');
      return userById.get(uid)?.name ?? uid.slice(0, 8);
    },
    [userById, tDetail],
  );

  // ─────── Mutations ───────

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

  async function _onMoveStage(): Promise<void> {
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

  async function quickMoveToStage(code: LeadStageCode): Promise<void> {
    if (!lead || code === lead.stage.code) return;
    setStageMenuOpen(false);
    setStageCode(code);
    setActionPending('stage');
    setError(null);
    try {
      await leadsApi.moveStage(lead.id, code);
      setNotice(tCommon('saved'));
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setActionPending(null);
    }
  }

  async function onChangeStatus(statusId: string): Promise<void> {
    if (!lead) return;
    setActionPending('status');
    setError(null);
    try {
      await leadStatusesApi.changeLeadStatus(lead.id, statusId);
      setNotice(tCommon('saved'));
      setStatusChangeOpen(false);
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setActionPending(null);
    }
  }

  function focusComposer(type: 'note' | 'call'): void {
    setActivityType(type);
    requestAnimationFrame(() => {
      composerSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      composerTextareaRef.current?.focus();
    });
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

  // Follow-up creation
  async function onCreateFollowUp(): Promise<void> {
    if (!lead || !fuDate) return;
    setActionPending('followup');
    try {
      await followUpsApi.create(lead.id, {
        method: fuMethod as FollowUpMethod,
        scheduledAt: new Date(fuDate).toISOString(),
        note: fuNote || null,
      });
      setFollowUpModalOpen(false);
      setFuDate('');
      setFuNote('');
      setNotice(tCommon('saved'));
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setActionPending(null);
    }
  }

  // WhatsApp
  async function openWhatsApp(): Promise<void> {
    if (!lead) return;
    setWhatsappOpen(true);
    setWaLoading(true);
    try {
      const convos = await leadConversationsApi.findByLead(lead.id);
      setConversations(convos);
      if (convos.length > 0) {
        const msgs = await conversationsApi.listMessages(convos[0].id, { limit: 50 });
        setMessages(msgs);
      }
    } catch {
      // If no conversation found, show empty state
      setConversations([]);
      setMessages([]);
    } finally {
      setWaLoading(false);
    }
  }

  async function sendWhatsAppMessage(): Promise<void> {
    if (!waMessage.trim() || conversations.length === 0) return;
    setWaLoading(true);
    try {
      await conversationsApi.sendText(conversations[0].id, waMessage.trim());
      setWaMessage('');
      // Reload messages
      const msgs = await conversationsApi.listMessages(conversations[0].id, { limit: 50 });
      setMessages(msgs);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setWaLoading(false);
    }
  }

  // ─────── Loading / error / not found ───────

  if (loading && !lead) {
    return (
      <p className="rounded-lg border border-surface-border bg-surface-card px-4 py-10 text-center text-sm text-ink-secondary shadow-card">
        {tCommon('loading')}
      </p>
    );
  }
  if (error && !lead) {
    return (
      <div className="flex flex-col gap-3">
        <Notice tone="error">
          <div className="flex items-start justify-between gap-3">
            <span>{error}</span>
            <Button variant="ghost" size="sm" onClick={() => void reload()}>
              {tCommon('retry')}
            </Button>
          </div>
        </Notice>
      </div>
    );
  }
  if (!lead) {
    return (
      <EmptyState
        title={tCommon('errorTitle')}
        action={
          <Button variant="secondary" size="sm" onClick={() => router.push('/admin/leads')}>
            {t('title')}
          </Button>
        }
      />
    );
  }

  // ─────── Derived display values ───────

  const isConverted = Boolean(lead.captain) || lead.stage.code === 'converted';
  const isLost = lead.stage.code === 'lost';
  const assignee = lead.assignedToId ? (userById.get(lead.assignedToId) ?? null) : null;
  const assigneeTeam = assignee?.teamId ? (teamById.get(assignee.teamId) ?? null) : null;

  const now = new Date();
  const slaDueRelative = lead.slaDueAt
    ? formatRelative(new Date(lead.slaDueAt), now, locale)
    : null;
  const createdAtRelative = formatRelative(new Date(lead.createdAt), now, locale);

  // SLA grouping for timeline
  const slaActivities = activities.filter((a) => a.type === 'sla_breach');
  const nonSlaActivities = activities.filter((a) => a.type !== 'sla_breach');
  const showSlaGroup = slaActivities.length > 3;

  // ─────── Render ───────

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
        actions={
          <div className="flex items-center gap-2">
            <Badge tone={lead.stage.isTerminal ? 'inactive' : 'info'}>{lead.stage.name}</Badge>
            {lead.status ? (
              <Badge tone="warning">{lead.status.name}</Badge>
            ) : null}
            <Badge tone={slaTone(lead.slaStatus)}>{lead.slaStatus}</Badge>
            {isConverted ? (
              <Badge tone="healthy">
                <Trophy className="me-1 inline h-3 w-3" aria-hidden="true" />
                {tDetail('captainBadge')}
              </Badge>
            ) : null}
          </div>
        }
      />

      {/* ───── Stage + Status Section (C30) ───── */}
      <section className="rounded-lg border border-surface-border bg-surface-card p-4 shadow-card">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="flex flex-col">
              <span className="text-[11px] font-medium uppercase tracking-wide text-ink-tertiary">
                Stage
              </span>
              <span className="text-sm font-semibold text-ink-primary">{lead.stage.name}</span>
            </div>
            <ChevronRight className="h-4 w-4 text-ink-tertiary" />
            <div className="flex flex-col">
              <span className="text-[11px] font-medium uppercase tracking-wide text-ink-tertiary">
                Status
              </span>
              <div className="flex items-center gap-2">
                <span
                  className="text-sm font-semibold"
                  style={{ color: lead.status?.color ?? 'inherit' }}
                >
                  {lead.status?.name ?? 'No status set'}
                </span>
                <button
                  onClick={() => setStatusChangeOpen(!statusChangeOpen)}
                  className="inline-flex items-center gap-1 rounded-md border border-surface-border px-2 py-0.5 text-xs text-ink-secondary hover:bg-surface transition-colors"
                >
                  Change <ChevronDown className="h-3 w-3" />
                </button>
              </div>
            </div>
          </div>
          {/* Pipeline progress dots */}
          <div className="hidden sm:flex items-center gap-1">
            {stages.map((s) => (
              <div
                key={s.code}
                className={cn(
                  'h-2.5 w-2.5 rounded-full transition-colors',
                  s.code === lead.stage.code
                    ? 'bg-brand-600 ring-2 ring-brand-200'
                    : s.order < (stageByCode.get(lead.stage.code)?.order ?? 0)
                      ? 'bg-brand-400'
                      : 'bg-surface-border',
                )}
                title={s.name}
              />
            ))}
          </div>
        </div>

        {/* Status change dropdown */}
        {statusChangeOpen && currentStageStatuses.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-2 border-t border-surface-border pt-3">
            {currentStageStatuses.map((st) => (
              <button
                key={st.id}
                onClick={() => void onChangeStatus(st.id)}
                disabled={actionPending === 'status' || lead.statusId === st.id}
                className={cn(
                  'rounded-full px-3 py-1 text-xs font-medium transition-colors border',
                  lead.statusId === st.id
                    ? 'bg-brand-50 border-brand-300 text-brand-700'
                    : 'border-surface-border text-ink-secondary hover:bg-surface hover:border-brand-300',
                )}
              >
                {st.name}
              </button>
            ))}
          </div>
        ) : statusChangeOpen && currentStageStatuses.length === 0 ? (
          <div className="mt-3 border-t border-surface-border pt-3">
            <p className="text-xs text-ink-tertiary">
              No statuses configured for this stage. Configure them in Pipeline Settings.
            </p>
          </div>
        ) : null}
      </section>

      {/* ───── Quick Actions Bar ───── */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-surface-border bg-surface-card p-3 shadow-card">
        {/* + Add Action */}
        <Button
          variant="primary"
          size="md"
          onClick={() => { setAddActionOpen(true); setAddActionCategory(null); }}
          disabled={isConverted}
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          Add Action
        </Button>

        {/* Call */}
        <a
          href={`tel:${lead.phone}`}
          onClick={() => focusComposer('call')}
          className="inline-flex h-9 items-center gap-1.5 rounded-md bg-brand-600 px-4 text-sm font-medium text-white transition-colors hover:bg-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-1"
        >
          <PhoneCall className="h-4 w-4" aria-hidden="true" />
          {tDetail('quickActions.call')}
        </a>

        {/* WhatsApp */}
        <Button variant="secondary" size="md" onClick={() => void openWhatsApp()}>
          <MessageCircle className="h-4 w-4 text-green-600" aria-hidden="true" />
          WhatsApp
        </Button>

        {/* Follow-up */}
        <Button
          variant="secondary"
          size="md"
          onClick={() => setFollowUpModalOpen(true)}
          disabled={isConverted}
        >
          <Calendar className="h-4 w-4" aria-hidden="true" />
          Follow-up
        </Button>

        {/* Move Stage */}
        <div className="relative">
          <Button
            variant="secondary"
            size="md"
            onClick={() => setStageMenuOpen(!stageMenuOpen)}
            disabled={isConverted || actionPending === 'stage'}
            loading={actionPending === 'stage'}
          >
            <ArrowRightLeft className="h-4 w-4" aria-hidden="true" />
            {tDetail('quickActions.moveStage')}
            <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
          {stageMenuOpen ? (
            <ul
              role="menu"
              className="absolute end-0 z-10 mt-1 min-w-[180px] overflow-hidden rounded-md border border-surface-border bg-surface-card py-1 text-sm shadow-card"
            >
              {stages.map((s) => {
                const isCurrent = s.code === lead.stage.code;
                return (
                  <li key={s.code}>
                    <button
                      role="menuitem"
                      type="button"
                      disabled={isCurrent}
                      onClick={() => void quickMoveToStage(s.code as LeadStageCode)}
                      className={cn(
                        'flex w-full items-center justify-between gap-3 px-3 py-1.5 text-start',
                        isCurrent
                          ? 'cursor-not-allowed text-ink-tertiary'
                          : 'text-ink-primary hover:bg-brand-50',
                      )}
                    >
                      <span>{s.name}</span>
                      {isCurrent ? (
                        <span className="text-[11px] uppercase text-ink-tertiary">current</span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>

        {isConverted ? (
          <span className="text-xs text-ink-tertiary">{tDetail('quickActions.terminalHint')}</span>
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

      {/* ───── Profile card ───── */}
      <section className="grid gap-3 rounded-lg border border-surface-border bg-surface-card p-5 shadow-card sm:grid-cols-2 lg:grid-cols-4">
        <ProfileField label={tDetail('phoneLabel')}>
          <a
            href={`tel:${lead.phone}`}
            className="inline-flex items-center gap-1 font-mono text-sm text-brand-700 hover:underline"
          >
            <Phone className="h-3.5 w-3.5" aria-hidden="true" />
            {lead.phone}
          </a>
        </ProfileField>

        <ProfileField label={tDetail('emailLabel')}>
          {lead.email ? (
            <a
              href={`mailto:${lead.email}`}
              className="inline-flex items-center gap-1 text-sm text-brand-700 hover:underline"
            >
              <Mail className="h-3.5 w-3.5" aria-hidden="true" />
              {lead.email}
            </a>
          ) : (
            <span className="text-sm text-ink-tertiary">—</span>
          )}
        </ProfileField>

        <ProfileField label={tDetail('assigneeLabel')}>
          {assignee ? (
            <div className="flex flex-col leading-tight">
              <span className="text-sm font-medium text-ink-primary">{assignee.name}</span>
              <span className="text-xs text-ink-secondary">
                {assignee.email}
                {assigneeTeam ? <> · {assigneeTeam.name}</> : null}
              </span>
            </div>
          ) : (
            <span className="text-sm text-ink-tertiary">{tDetail('unassigned')}</span>
          )}
        </ProfileField>

        <ProfileField label={tDetail('slaLabel')}>
          <div className="flex flex-col leading-tight">
            <Badge tone={slaTone(lead.slaStatus)}>{lead.slaStatus}</Badge>
            {slaDueRelative ? (
              <span className="mt-0.5 text-xs text-ink-tertiary">
                {tDetail('slaDue')} {slaDueRelative}
              </span>
            ) : null}
          </div>
        </ProfileField>

        <ProfileField label={tDetail('createdLabel')}>
          <span className="text-sm text-ink-secondary">{createdAtRelative}</span>
        </ProfileField>

        <ProfileField label={tDetail('lastResponseLabel')}>
          <span className="text-sm text-ink-secondary">
            {lead.lastResponseAt ? formatRelative(new Date(lead.lastResponseAt), now, locale) : '—'}
          </span>
        </ProfileField>

        <ProfileField label={tDetail('stageLabel')}>
          <div className="flex flex-col leading-tight">
            <span className="text-sm font-medium text-ink-primary">{lead.stage.name}</span>
            <span className="text-xs text-ink-tertiary">
              {tDetail('source')}: {lead.source}
            </span>
          </div>
        </ProfileField>

        <ProfileField label={tDetail('captainLabel')}>
          {isConverted ? (
            <div className="flex flex-col leading-tight">
              <span className="text-sm font-medium text-status-healthy">
                {lead.captain?.onboardingStatus
                  ? tDetail('captainOnboarding', { status: lead.captain.onboardingStatus })
                  : tDetail('captainBadge')}
              </span>
              <Link
                href="/admin/captains"
                className="mt-0.5 inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline"
              >
                {tDetail('viewCaptain')}
              </Link>
            </div>
          ) : isLost ? (
            <span className="text-sm text-ink-tertiary">{tDetail('captainLost')}</span>
          ) : (
            <span className="text-sm text-ink-tertiary">{tDetail('captainNotYet')}</span>
          )}
        </ProfileField>
      </section>

      {/* ───── Two-column body: timeline + sidebar ───── */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        {/* Left: activity timeline + add-activity composer */}
        <div className="flex flex-col gap-4">
          {/* Add activity composer */}
          <section
            ref={composerSectionRef}
            id="lead-activity-composer"
            className="rounded-lg border border-surface-border bg-surface-card p-5 shadow-card"
          >
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-ink-primary">
              <StickyNote className="h-4 w-4 text-brand-700" aria-hidden="true" />
              {tDetail('logActivity')}
            </h2>
            <form onSubmit={onAddActivity} className="flex flex-col gap-3">
              <div className="grid gap-3 sm:grid-cols-[160px_1fr]">
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
                    ref={composerTextareaRef}
                    value={activityBody}
                    onChange={(e) => setActivityBody(e.target.value)}
                    maxLength={4000}
                    placeholder={
                      activityType === 'call'
                        ? tDetail('callPlaceholder')
                        : tDetail('notePlaceholder')
                    }
                    rows={3}
                  />
                </Field>
              </div>
              <div className="flex items-center justify-end gap-2">
                <span className="text-xs text-ink-tertiary">{activityBody.length}/4000</span>
                <Button
                  type="submit"
                  loading={actionPending === 'activity'}
                  disabled={!activityBody.trim()}
                >
                  {tDetail('postActivity')}
                </Button>
              </div>
            </form>
          </section>

          {/* Activity timeline (scrollable) */}
          <section className="rounded-lg border border-surface-border bg-surface-card p-5 shadow-card">
            <h2 className="mb-4 text-sm font-semibold text-ink-primary">
              {t('activitiesTitle')}
              <span className="ms-2 text-xs font-normal text-ink-tertiary">
                ({activities.length})
              </span>
            </h2>

            {activities.length === 0 ? (
              <EmptyState title={tDetail('noActivities')} body={tDetail('noActivitiesHint')} />
            ) : (
              <div className="max-h-[520px] overflow-y-auto pr-1" style={{ scrollbarWidth: 'thin' }}>
                {/* SLA Grouped Alerts */}
                {showSlaGroup ? (
                  <SlaGroupedAlerts
                    alerts={slaActivities}
                    locale={locale}
                    now={now}
                    _stageLabel={stageLabel}
                    _userLabel={userLabel}
                    _tDetail={tDetail}
                  />
                ) : null}

                <ol className="relative flex flex-col gap-3 ps-4">
                  <span
                    className="absolute inset-y-0 start-1.5 w-px bg-surface-border"
                    aria-hidden="true"
                  />
                  {(showSlaGroup ? nonSlaActivities : activities).map((a) => (
                    <ActivityItem
                      key={a.id}
                      activity={a}
                      locale={locale}
                      now={now}
                      stageLabel={stageLabel}
                      userLabel={userLabel}
                      tDetail={tDetail}
                    />
                  ))}
                </ol>
              </div>
            )}
          </section>
        </div>

        {/* Right: sidebar */}
        <aside className="flex flex-col gap-4">
          {/* Quick actions sidebar */}
          <section className="rounded-lg border border-surface-border bg-surface-card p-5 shadow-card">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-ink-primary">
              <UserCog className="h-4 w-4 text-brand-700" aria-hidden="true" />
              {tDetail('quickActionsTitle')}
            </h2>

            {/* Assign / reassign */}
            <div className="flex flex-col gap-2">
              <Field label={t('assignAction')}>
                <Select
                  value={assigneeId}
                  onChange={(e) => setAssigneeId(e.target.value)}
                  disabled={isConverted}
                >
                  <option value="">{tDetail('unassigned')}</option>
                  {activeUsers.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name} ({u.email})
                    </option>
                  ))}
                </Select>
              </Field>
              <Button
                onClick={() => void onAssign()}
                loading={actionPending === 'assign'}
                disabled={isConverted || (assigneeId || '') === (lead.assignedToId ?? '')}
                size="sm"
              >
                {tDetail('saveAssignee')}
              </Button>
            </div>

            <hr className="my-4 border-surface-border" />

            {/* Convert */}
            <div className="flex flex-col gap-2">
              <span className="text-xs text-ink-secondary">{t('convertHint')}</span>
              <Button
                variant="primary"
                onClick={() => void onConvert()}
                loading={actionPending === 'convert'}
                disabled={isConverted || isLost}
                size="sm"
              >
                <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                {isConverted ? t('convertedAlready') : t('convertAction')}
              </Button>
              {isLost ? (
                <p className="text-xs text-ink-tertiary">{tDetail('cantConvertLost')}</p>
              ) : null}
            </div>
          </section>

          {/* Documents section */}
          <section className="rounded-lg border border-surface-border bg-surface-card p-5 shadow-card">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-ink-primary">
              <FileText className="h-4 w-4 text-brand-700" aria-hidden="true" />
              Documents
              <span className="text-xs font-normal text-ink-tertiary">
                ({documents.filter((d) => d.status === 'approved').length}/{documents.length})
              </span>
            </h2>
            {documents.length === 0 ? (
              <p className="text-xs text-ink-tertiary">No documents required yet.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {documents.map((doc) => (
                  <li
                    key={doc.id}
                    className="flex items-center justify-between rounded-md border border-surface-border px-3 py-2"
                  >
                    <div className="flex flex-col">
                      <span className="text-xs font-medium text-ink-primary">{doc.label}</span>
                      <span className="text-[11px] text-ink-tertiary">{doc.type}</span>
                    </div>
                    <Badge
                      tone={
                        doc.status === 'approved'
                          ? 'healthy'
                          : doc.status === 'rejected'
                            ? 'breach'
                            : doc.status === 'uploaded'
                              ? 'info'
                              : 'inactive'
                      }
                    >
                      {doc.status}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Follow-ups section */}
          <section className="rounded-lg border border-surface-border bg-surface-card p-5 shadow-card">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-ink-primary">
              <Calendar className="h-4 w-4 text-brand-700" aria-hidden="true" />
              Follow-ups
              <span className="text-xs font-normal text-ink-tertiary">
                ({followUps.filter((f) => f.status === 'pending').length} pending)
              </span>
            </h2>
            {followUps.length === 0 ? (
              <p className="text-xs text-ink-tertiary">No follow-ups scheduled.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {followUps.slice(0, 5).map((fu) => (
                  <li
                    key={fu.id}
                    className="flex items-center justify-between rounded-md border border-surface-border px-3 py-2"
                  >
                    <div className="flex flex-col">
                      <span className="text-xs font-medium text-ink-primary">
                        {fu.method} · {new Date(fu.scheduledAt).toLocaleDateString(locale)}
                      </span>
                      {fu.note ? (
                        <span className="text-[11px] text-ink-tertiary">{fu.note}</span>
                      ) : null}
                    </div>
                    <Badge tone={fu.status === 'completed' ? 'healthy' : 'warning'}>
                      {fu.status}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>
      </div>

      {/* ═══════════════════════════════════════════════════════════════════
          MODALS
      ═══════════════════════════════════════════════════════════════════ */}

      {/* Add Action Modal */}
      {addActionOpen ? (
        <ModalOverlay onClose={() => setAddActionOpen(false)}>
          <div className="w-full max-w-lg rounded-xl bg-surface-card p-6 shadow-xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-ink-primary">
                {addActionCategory ? (
                  <button
                    onClick={() => setAddActionCategory(null)}
                    className="inline-flex items-center gap-1 text-brand-700 hover:underline"
                  >
                    <ArrowLeft className="h-4 w-4" /> Back
                  </button>
                ) : (
                  'Add Action'
                )}
              </h3>
              <button onClick={() => setAddActionOpen(false)} className="text-ink-tertiary hover:text-ink-primary">
                <X className="h-5 w-5" />
              </button>
            </div>

            {!addActionCategory ? (
              <div className="grid grid-cols-2 gap-3">
                {[
                  { key: 'lifecycle', icon: ArrowRightLeft, label: 'Lifecycle', desc: 'Change stage or status' },
                  { key: 'profile', icon: UserCog, label: 'Profile', desc: 'Update lead info' },
                  { key: 'documents', icon: FileText, label: 'Documents', desc: 'Manage documents' },
                  { key: 'communication', icon: MessageCircle, label: 'Communication', desc: 'Call, WhatsApp, Note' },
                  { key: 'scheduling', icon: Calendar, label: 'Scheduling', desc: 'Follow-ups & reminders' },
                ].map((cat) => (
                  <button
                    key={cat.key}
                    onClick={() => setAddActionCategory(cat.key)}
                    className="flex flex-col items-center gap-2 rounded-lg border border-surface-border p-4 text-center transition-colors hover:bg-brand-50 hover:border-brand-300"
                  >
                    <cat.icon className="h-6 w-6 text-brand-600" />
                    <span className="text-sm font-medium text-ink-primary">{cat.label}</span>
                    <span className="text-[11px] text-ink-tertiary">{cat.desc}</span>
                  </button>
                ))}
              </div>
            ) : addActionCategory === 'lifecycle' ? (
              <div className="flex flex-col gap-4">
                <div>
                  <h4 className="text-sm font-medium text-ink-primary mb-2">Move Stage</h4>
                  <div className="flex flex-wrap gap-2">
                    {stages.map((s) => (
                      <button
                        key={s.code}
                        onClick={() => { void quickMoveToStage(s.code as LeadStageCode); setAddActionOpen(false); }}
                        disabled={s.code === lead.stage.code}
                        className={cn(
                          'rounded-full px-3 py-1 text-xs font-medium border transition-colors',
                          s.code === lead.stage.code
                            ? 'bg-brand-50 border-brand-300 text-brand-700 cursor-not-allowed'
                            : 'border-surface-border text-ink-secondary hover:bg-brand-50 hover:border-brand-300',
                        )}
                      >
                        {s.name}
                      </button>
                    ))}
                  </div>
                </div>
                <hr className="border-surface-border" />
                <div>
                  <h4 className="text-sm font-medium text-ink-primary mb-2">Change Status</h4>
                  {currentStageStatuses.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      {currentStageStatuses.map((st) => (
                        <button
                          key={st.id}
                          onClick={() => { void onChangeStatus(st.id); setAddActionOpen(false); }}
                          disabled={lead.statusId === st.id}
                          className={cn(
                            'rounded-full px-3 py-1 text-xs font-medium border transition-colors',
                            lead.statusId === st.id
                              ? 'bg-brand-50 border-brand-300 text-brand-700 cursor-not-allowed'
                              : 'border-surface-border text-ink-secondary hover:bg-brand-50 hover:border-brand-300',
                          )}
                        >
                          {st.name}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-ink-tertiary">No statuses configured for this stage.</p>
                  )}
                </div>
              </div>
            ) : addActionCategory === 'communication' ? (
              <div className="flex flex-col gap-3">
                <button
                  onClick={() => { focusComposer('call'); setAddActionOpen(false); }}
                  className="flex items-center gap-3 rounded-lg border border-surface-border p-3 hover:bg-brand-50 transition-colors"
                >
                  <PhoneCall className="h-5 w-5 text-brand-600" />
                  <div className="text-start">
                    <span className="text-sm font-medium text-ink-primary">Log Call</span>
                    <p className="text-[11px] text-ink-tertiary">Record a phone call outcome</p>
                  </div>
                </button>
                <button
                  onClick={() => { void openWhatsApp(); setAddActionOpen(false); }}
                  className="flex items-center gap-3 rounded-lg border border-surface-border p-3 hover:bg-brand-50 transition-colors"
                >
                  <MessageCircle className="h-5 w-5 text-green-600" />
                  <div className="text-start">
                    <span className="text-sm font-medium text-ink-primary">WhatsApp</span>
                    <p className="text-[11px] text-ink-tertiary">Open WhatsApp conversation</p>
                  </div>
                </button>
                <button
                  onClick={() => { focusComposer('note'); setAddActionOpen(false); }}
                  className="flex items-center gap-3 rounded-lg border border-surface-border p-3 hover:bg-brand-50 transition-colors"
                >
                  <StickyNote className="h-5 w-5 text-amber-600" />
                  <div className="text-start">
                    <span className="text-sm font-medium text-ink-primary">Add Note</span>
                    <p className="text-[11px] text-ink-tertiary">Write an internal note</p>
                  </div>
                </button>
              </div>
            ) : addActionCategory === 'scheduling' ? (
              <div className="flex flex-col gap-3">
                <Field label="Method">
                  <Select value={fuMethod} onChange={(e) => setFuMethod(e.target.value as FollowUpMethod)}>
                    <option value="call">Call</option>
                    <option value="whatsapp">WhatsApp</option>
                    <option value="email">Email</option>
                    <option value="visit">Visit</option>
                    <option value="other">Other</option>
                  </Select>
                </Field>
                <Field label="Scheduled Date & Time">
                  <Input type="datetime-local" value={fuDate} onChange={(e) => setFuDate(e.target.value)} />
                </Field>
                <Field label="Note (optional)">
                  <Textarea value={fuNote} onChange={(e) => setFuNote(e.target.value)} rows={2} />
                </Field>
                <Button
                  onClick={() => { void onCreateFollowUp(); setAddActionOpen(false); }}
                  disabled={!fuDate}
                >
                  Schedule Follow-up
                </Button>
              </div>
            ) : addActionCategory === 'documents' ? (
              <div className="flex flex-col gap-3">
                {documents.length === 0 ? (
                  <p className="text-sm text-ink-tertiary">No documents configured for this lead yet.</p>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {documents.map((doc) => (
                      <li key={doc.id} className="flex items-center justify-between rounded-md border border-surface-border px-3 py-2">
                        <div>
                          <span className="text-sm font-medium text-ink-primary">{doc.label}</span>
                          <p className="text-[11px] text-ink-tertiary">{doc.type}</p>
                        </div>
                        <Badge tone={doc.status === 'approved' ? 'healthy' : doc.status === 'rejected' ? 'breach' : 'inactive'}>
                          {doc.status}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : addActionCategory === 'profile' ? (
              <div className="flex flex-col gap-3">
                <p className="text-sm text-ink-secondary">
                  Edit lead profile fields. Changes are saved immediately.
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <ProfileField label="Name">
                    <span className="text-sm text-ink-primary">{lead.name}</span>
                  </ProfileField>
                  <ProfileField label="Phone">
                    <span className="text-sm font-mono text-ink-primary">{lead.phone}</span>
                  </ProfileField>
                  <ProfileField label="Email">
                    <span className="text-sm text-ink-primary">{lead.email ?? '—'}</span>
                  </ProfileField>
                  <ProfileField label="Source">
                    <span className="text-sm text-ink-primary">{lead.source}</span>
                  </ProfileField>
                </div>
              </div>
            ) : null}
          </div>
        </ModalOverlay>
      ) : null}

      {/* Follow-up Modal */}
      {followUpModalOpen ? (
        <ModalOverlay onClose={() => setFollowUpModalOpen(false)}>
          <div className="w-full max-w-md rounded-xl bg-surface-card p-6 shadow-xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-ink-primary">Schedule Follow-up</h3>
              <button onClick={() => setFollowUpModalOpen(false)} className="text-ink-tertiary hover:text-ink-primary">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="flex flex-col gap-3">
              <Field label="Method">
                <Select value={fuMethod} onChange={(e) => setFuMethod(e.target.value as FollowUpMethod)}>
                  <option value="call">Call</option>
                  <option value="whatsapp">WhatsApp</option>
                  <option value="email">Email</option>
                  <option value="visit">Visit</option>
                  <option value="other">Other</option>
                </Select>
              </Field>
              <Field label="Scheduled Date & Time">
                <Input type="datetime-local" value={fuDate} onChange={(e) => setFuDate(e.target.value)} />
              </Field>
              <Field label="Reminder Note (optional)">
                <Textarea value={fuNote} onChange={(e) => setFuNote(e.target.value)} rows={2} placeholder="What to discuss..." />
              </Field>
              <Button
                onClick={() => void onCreateFollowUp()}
                loading={actionPending === 'followup'}
                disabled={!fuDate}
              >
                Schedule
              </Button>
            </div>
          </div>
        </ModalOverlay>
      ) : null}

      {/* WhatsApp Popup (side panel) */}
      {whatsappOpen ? (
        <div
          className={cn(
            'fixed top-0 z-50 h-full w-[380px] bg-surface-card border-surface-border shadow-xl flex flex-col transition-transform duration-300',
            locale === 'ar' ? 'start-0 border-e' : 'end-0 border-s',
          )}
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-surface-border bg-green-50 px-4 py-3">
            <div className="flex items-center gap-2">
              <MessageCircle className="h-5 w-5 text-green-600" />
              <div>
                <p className="text-sm font-semibold text-ink-primary">{lead.name}</p>
                <p className="text-[11px] text-ink-tertiary">{lead.phone}</p>
              </div>
            </div>
            <button onClick={() => setWhatsappOpen(false)} className="text-ink-tertiary hover:text-ink-primary">
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3" style={{ scrollbarWidth: 'thin' }}>
            {waLoading ? (
              <p className="text-center text-sm text-ink-tertiary py-8">Loading conversation...</p>
            ) : messages.length === 0 ? (
              <div className="text-center py-8">
                <MessageCircle className="mx-auto h-8 w-8 text-ink-tertiary mb-2" />
                <p className="text-sm text-ink-tertiary">No messages yet.</p>
                <p className="text-[11px] text-ink-tertiary mt-1">Send a message to start the conversation.</p>
              </div>
            ) : (
              messages.map((msg) => (
                <div
                  key={msg.id}
                  className={cn(
                    'max-w-[80%] rounded-lg px-3 py-2 text-sm',
                    msg.direction === 'outbound'
                      ? 'ms-auto bg-green-100 text-green-900'
                      : 'bg-surface border border-surface-border text-ink-primary',
                  )}
                >
                  <p>{msg.text}</p>
                  <span className="block text-[10px] text-ink-tertiary mt-1">
                    {new Date(msg.createdAt).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
              ))
            )}
          </div>

          {/* Input */}
          <div className="border-t border-surface-border p-3">
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={waMessage}
                onChange={(e) => setWaMessage(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void sendWhatsAppMessage(); } }}
                placeholder="Type a message..."
                className="flex-1 rounded-full border border-surface-border bg-surface px-4 py-2 text-sm outline-none focus:border-green-400"
              />
              <button
                onClick={() => void sendWhatsAppMessage()}
                disabled={!waMessage.trim() || waLoading}
                className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-green-600 text-white hover:bg-green-700 disabled:opacity-50"
              >
                <Send className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────
// Subcomponents
// ───────────────────────────────────────────────────────────────────────

function ModalOverlay({
  children,
  onClose,
}: {
  children: React.ReactNode;
  onClose: () => void;
}): JSX.Element {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative z-10">{children}</div>
    </div>
  );
}

function ProfileField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] font-medium uppercase tracking-wide text-ink-tertiary">
        {label}
      </span>
      {children}
    </div>
  );
}

// SLA Grouped Alerts
function SlaGroupedAlerts({
  alerts,
  locale,
  now,
  _stageLabel,
  _userLabel,
  _tDetail,
}: {
  alerts: LeadActivity[];
  locale: string;
  now: Date;
  _stageLabel: (code: string | undefined) => string;
  _userLabel: (uid: string | null | undefined) => string;
  _tDetail: ReturnType<typeof useTranslations>;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="mb-3 rounded-lg border border-red-200 bg-red-50 p-3">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between"
      >
        <div className="flex items-center gap-2">
          <TriangleAlert className="h-4 w-4 text-red-500" />
          <span className="text-sm font-medium text-red-700">
            SLA Alerts ({alerts.length})
          </span>
        </div>
        <ChevronDown
          className={cn('h-4 w-4 text-red-500 transition-transform', expanded && 'rotate-180')}
        />
      </button>
      {!expanded ? (
        <p className="mt-1 text-xs text-red-600">
          Latest: {alerts[0]?.body ?? 'SLA breach detected'} ·{' '}
          {alerts[0] ? formatRelative(new Date(alerts[0].createdAt), now, locale) : ''}
        </p>
      ) : (
        <ol className="mt-3 flex flex-col gap-2">
          {alerts.map((a) => (
            <li key={a.id} className="rounded-md border border-red-200 bg-white px-3 py-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-red-700">{a.body ?? 'SLA Breach'}</span>
                <span className="text-[11px] text-red-500">
                  {formatRelative(new Date(a.createdAt), now, locale)}
                </span>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

// Activity item
interface ActivityItemProps {
  activity: LeadActivity;
  locale: string;
  now: Date;
  stageLabel: (code: string | undefined) => string;
  userLabel: (uid: string | null | undefined) => string;
  tDetail: ReturnType<typeof useTranslations>;
}

function ActivityItem({
  activity,
  locale,
  now,
  stageLabel,
  userLabel,
  tDetail,
}: ActivityItemProps): JSX.Element {
  const Icon = ACTIVITY_ICON[activity.type] ?? Settings;
  const tone = activityTone(activity.type);
  const dotTone: Record<typeof tone, string> = {
    healthy: 'bg-status-healthy',
    info: 'bg-status-info',
    warning: 'bg-status-warning',
    breach: 'bg-status-breach',
    neutral: 'bg-ink-tertiary',
  };

  const payload = readPayload(activity.payload);
  const summary = formatActivitySummary(activity, payload, stageLabel, userLabel, tDetail);
  const author =
    activity.createdById !== null ? userLabel(activity.createdById) : tDetail('systemAuthor');
  const when = formatRelative(new Date(activity.createdAt), now, locale);

  return (
    <li className="relative">
      <span
        className={cn(
          'absolute -start-[18px] top-1 inline-flex h-3 w-3 items-center justify-center rounded-full ring-2 ring-surface-card',
          dotTone[tone],
        )}
        aria-hidden="true"
      />
      <div className="rounded-md border border-surface-border bg-surface px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <Icon className="h-3.5 w-3.5 text-ink-secondary" aria-hidden="true" />
            <Badge tone={tone}>{tDetail(`activity.type.${activity.type}`)}</Badge>
          </div>
          <span
            className="text-xs text-ink-tertiary"
            title={new Date(activity.createdAt).toLocaleString()}
          >
            {when}
          </span>
        </div>

        {summary ? <p className="mt-1.5 text-sm text-ink-primary">{summary}</p> : null}
        {activity.body && activity.type !== 'note' && activity.type !== 'call' ? (
          <p className="mt-1 text-xs text-ink-secondary">{activity.body}</p>
        ) : null}
        {activity.body && (activity.type === 'note' || activity.type === 'call') ? (
          <p className="mt-1.5 text-sm text-ink-primary">{activity.body}</p>
        ) : null}

        <p className="mt-1.5 text-[11px] text-ink-tertiary">
          {tDetail('activityAuthorBy')} {author}
        </p>
      </div>
    </li>
  );
}

function formatActivitySummary(
  activity: LeadActivity,
  payload: PayloadShape,
  stageLabel: (code: string | undefined) => string,
  userLabel: (uid: string | null | undefined) => string,
  tDetail: ReturnType<typeof useTranslations>,
): string | null {
  switch (activity.type) {
    case 'stage_change':
      return tDetail('activity.summary.stageChange', {
        from: stageLabel(payload.fromStageCode),
        to: stageLabel(payload.toStageCode),
      });
    case 'status_change':
      return `Status changed: ${payload.fromStatus ?? '—'} → ${payload.toStatus ?? '—'}`;
    case 'assignment':
      if (payload.toUserId === null) {
        return tDetail('activity.summary.unassigned');
      }
      if (payload.fromUserId === null || payload.fromUserId === undefined) {
        return tDetail('activity.summary.assigned', { user: userLabel(payload.toUserId) });
      }
      return tDetail('activity.summary.reassigned', {
        from: userLabel(payload.fromUserId),
        to: userLabel(payload.toUserId),
      });
    case 'auto_assignment':
      return tDetail('activity.summary.autoAssignment', {
        strategy: payload.strategy ?? 'round_robin',
      });
    case 'sla_breach':
      return activity.body ?? tDetail('activity.summary.slaBreach');
    case 'follow_up':
      return activity.body ?? 'Follow-up scheduled';
    case 'document':
      return activity.body ?? 'Document updated';
    case 'system':
      if (payload.event === 'converted') {
        return tDetail('activity.summary.converted');
      }
      if (payload.event === 'created') {
        return tDetail('activity.summary.created', {
          stage: stageLabel(
            payload.fromStageCode ??
              (activity.payload?.['stageCode'] as string | undefined) ??
              undefined,
          ),
        });
      }
      if (payload.event === 'updated') {
        return tDetail('activity.summary.updated');
      }
      return null;
    case 'note':
    case 'call':
      return null;
    default:
      return null;
  }
}
