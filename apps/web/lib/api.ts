/**
 * Typed fetch client for the Trade Way CRM API.
 *
 * Reads the access token from `localStorage` (set at login) and attaches it
 * as a Bearer header. The tenant code is sent as `X-Tenant` for endpoints
 * that need a tenant scope before the JWT claim is available — for the
 * authenticated admin surface in C13 the JWT's `tid` claim drives the
 * tenant context, so the header is only used at the login boundary.
 *
 * Errors are normalised to a single `ApiError` shape carrying the HTTP
 * status, the backend's stable error code (when present), and a
 * human-readable message — admin screens display the message and branch
 * on the code.
 */

import { API_BASE_URL, API_VERSION_PREFIX } from './api-base';
import { getAccessToken, getTenantCode } from './auth';
import type {
  AdminUser,
  Captain,
  CaptainStatus,
  Company,
  ConversationStatus,
  Country,
  Lead,
  LeadActivity,
  LeadActivityType,
  LeadSource,
  LeadStageCode,
  LoginResponse,
  MeUser,
  PaginatedResult,
  PipelineStage,
  RoleSummary,
  BonusAccrual,
  BonusAccrualStatus,
  BonusRule,
  BonusType,
  Competition,
  CompetitionMetric,
  CompetitionStatus,
  FollowUpActionType,
  LeadFollowUp,
  MetaLeadSource,
  Pipeline,
  PipelineStageRow,
  SendConversationMessageResult,
  TenantSettingsRow,
  WhatsAppAccount,
  Team,
  UserStatus,
  WhatsAppConversation,
  WhatsAppMessage,
} from './api-types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
    readonly raw?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface ApiFetchOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  /** Override the Bearer token (used by the login flow itself). */
  bearerToken?: string | null;
  /** Send the tenant code as `X-Tenant`. Defaults to whatever auth.ts has. */
  tenantCode?: string | null;
}

function buildUrl(path: string, query: ApiFetchOptions['query']): string {
  const url = new URL(`${API_BASE_URL}${API_VERSION_PREFIX}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

async function apiFetch<T>(path: string, opts: ApiFetchOptions = {}): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  const token = opts.bearerToken === undefined ? getAccessToken() : opts.bearerToken;
  if (token) headers['Authorization'] = `Bearer ${token}`;
  // X-Tenant is the dev fallback for unauthenticated paths. The server's
  // tenant context middleware (C27) prefers the JWT `tid` claim and only
  // honours the header in non-production. Sending it on authenticated
  // calls accomplishes nothing except triggering a CORS preflight that
  // fails unless the operator has explicitly added X-Tenant to the
  // server's allowedHeaders list — so we omit it whenever a Bearer
  // token is already present. Callers can still pass `tenantCode`
  // explicitly (e.g. login passes `null`); only the implicit
  // localStorage-driven path is gated.
  const explicitTenant = opts.tenantCode !== undefined;
  const tenantCode = explicitTenant ? opts.tenantCode : token ? null : getTenantCode();
  if (tenantCode) headers['X-Tenant'] = tenantCode;

  let body: BodyInit | undefined;
  if (opts.body !== undefined && opts.body !== null) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }

  const res = await fetch(buildUrl(path, opts.query), {
    method: opts.method ?? 'GET',
    headers,
    body,
    credentials: 'omit',
    cache: 'no-store',
  });

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!res.ok) {
    const obj = parsed as Record<string, unknown> | null;
    // Nest's exception filter typically wraps error payloads as
    // { statusCode, message: <inner>, error }. The inner message we attach
    // in our services is { code, message }.
    const inner = (obj && (obj['message'] as Record<string, unknown> | string)) ??
      obj ?? { message: text };
    let code: string | null = null;
    let message: string = res.statusText;
    if (typeof inner === 'string') {
      message = inner;
    } else if (inner && typeof inner === 'object') {
      const i = inner as Record<string, unknown>;
      if (typeof i['code'] === 'string') code = i['code'] as string;
      if (typeof i['message'] === 'string') message = i['message'] as string;
      else if (Array.isArray(i['message']) && i['message'].length > 0) {
        message = String(i['message'][0]);
      }
    }
    throw new ApiError(res.status, code, message, parsed);
  }

  return parsed as T;
}

// ───────────────────────────────────────────────────────────────────────
// Auth
// ───────────────────────────────────────────────────────────────────────

export const authApi = {
  login(input: { email: string; password: string; tenantCode: string }): Promise<LoginResponse> {
    return apiFetch<LoginResponse>('/auth/login', {
      method: 'POST',
      body: input,
      bearerToken: null,
      tenantCode: null,
    });
  },
  me(): Promise<MeUser> {
    return apiFetch<MeUser>('/auth/me');
  },
};

// ───────────────────────────────────────────────────────────────────────
// Org — companies / countries / teams / users (admin)
// ───────────────────────────────────────────────────────────────────────

export const companiesApi = {
  list: (): Promise<Company[]> => apiFetch<Company[]>('/companies'),
  get: (id: string): Promise<Company> => apiFetch<Company>(`/companies/${id}`),
  create: (input: { code: string; name: string; isActive?: boolean }): Promise<Company> =>
    apiFetch<Company>('/companies', { method: 'POST', body: input }),
  update: (
    id: string,
    input: { code?: string; name?: string; isActive?: boolean },
  ): Promise<Company> => apiFetch<Company>(`/companies/${id}`, { method: 'PATCH', body: input }),
  remove: (id: string): Promise<void> => apiFetch<void>(`/companies/${id}`, { method: 'DELETE' }),
};

export const countriesApi = {
  list: (companyId?: string): Promise<Country[]> =>
    apiFetch<Country[]>('/countries', { query: { companyId } }),
  get: (id: string): Promise<Country> => apiFetch<Country>(`/countries/${id}`),
  create: (input: {
    companyId: string;
    code: string;
    name: string;
    isActive?: boolean;
  }): Promise<Country> => apiFetch<Country>('/countries', { method: 'POST', body: input }),
  update: (
    id: string,
    input: { code?: string; name?: string; isActive?: boolean },
  ): Promise<Country> => apiFetch<Country>(`/countries/${id}`, { method: 'PATCH', body: input }),
  remove: (id: string): Promise<void> => apiFetch<void>(`/countries/${id}`, { method: 'DELETE' }),
};

export const teamsApi = {
  list: (countryId?: string): Promise<Team[]> =>
    apiFetch<Team[]>('/teams', { query: { countryId } }),
  get: (id: string): Promise<Team> => apiFetch<Team>(`/teams/${id}`),
  create: (input: { countryId: string; name: string; isActive?: boolean }): Promise<Team> =>
    apiFetch<Team>('/teams', { method: 'POST', body: input }),
  update: (id: string, input: { name?: string; isActive?: boolean }): Promise<Team> =>
    apiFetch<Team>(`/teams/${id}`, { method: 'PATCH', body: input }),
  remove: (id: string): Promise<void> => apiFetch<void>(`/teams/${id}`, { method: 'DELETE' }),
};

export const usersApi = {
  list: (
    query: {
      teamId?: string;
      roleId?: string;
      status?: UserStatus;
      q?: string;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<PaginatedResult<AdminUser>> =>
    apiFetch<PaginatedResult<AdminUser>>('/users', { query }),
  get: (id: string): Promise<AdminUser> => apiFetch<AdminUser>(`/users/${id}`),
  create: (input: {
    email: string;
    name: string;
    password: string;
    roleId: string;
    teamId?: string | null;
    phone?: string;
    language?: 'ar' | 'en';
    status?: UserStatus;
  }): Promise<AdminUser> => apiFetch<AdminUser>('/users', { method: 'POST', body: input }),
  update: (
    id: string,
    input: {
      name?: string;
      roleId?: string;
      teamId?: string | null;
      phone?: string | null;
      language?: 'ar' | 'en';
      status?: UserStatus;
    },
  ): Promise<AdminUser> => apiFetch<AdminUser>(`/users/${id}`, { method: 'PATCH', body: input }),
  enable: (id: string): Promise<AdminUser> =>
    apiFetch<AdminUser>(`/users/${id}/enable`, { method: 'POST' }),
  disable: (id: string): Promise<AdminUser> =>
    apiFetch<AdminUser>(`/users/${id}/disable`, { method: 'POST' }),
  setRole: (id: string, roleId: string): Promise<AdminUser> =>
    apiFetch<AdminUser>(`/users/${id}/role`, { method: 'PATCH', body: { roleId } }),
  setTeam: (id: string, teamId: string | null): Promise<AdminUser> =>
    apiFetch<AdminUser>(`/users/${id}/team`, { method: 'PATCH', body: { teamId } }),
  setStatus: (id: string, status: UserStatus): Promise<AdminUser> =>
    apiFetch<AdminUser>(`/users/${id}/status`, { method: 'PATCH', body: { status } }),
  remove: (id: string): Promise<void> => apiFetch<void>(`/users/${id}`, { method: 'DELETE' }),
};

// ───────────────────────────────────────────────────────────────────────
// RBAC — read-only roles list (C14)
// ───────────────────────────────────────────────────────────────────────

export const rolesApi = {
  list: (): Promise<RoleSummary[]> => apiFetch<RoleSummary[]>('/rbac/roles'),
};

// ───────────────────────────────────────────────────────────────────────
// CRM — pipeline stages + leads + activities
// ───────────────────────────────────────────────────────────────────────

export const pipelineApi = {
  listStages: (): Promise<PipelineStage[]> => apiFetch<PipelineStage[]>('/pipeline/stages'),
};

// ───────────────────────────────────────────────────────────────────────
// Pipeline Builder (P2-07) — admin CRUD over pipelines + their stages.
// ───────────────────────────────────────────────────────────────────────

export interface CreatePipelineInput {
  name: string;
  companyId?: string | null;
  countryId?: string | null;
  isActive?: boolean;
}
export interface CreatePipelineStageInput {
  code: string;
  name: string;
  order?: number;
  isTerminal?: boolean;
}

export const pipelinesApi = {
  list: (): Promise<Pipeline[]> => apiFetch<Pipeline[]>('/pipelines'),
  get: (id: string): Promise<Pipeline> => apiFetch<Pipeline>(`/pipelines/${id}`),
  create: (input: CreatePipelineInput): Promise<Pipeline> =>
    apiFetch<Pipeline>('/pipelines', { method: 'POST', body: input }),
  update: (id: string, input: { name?: string; isActive?: boolean }): Promise<Pipeline> =>
    apiFetch<Pipeline>(`/pipelines/${id}`, { method: 'PATCH', body: input }),
  remove: (id: string): Promise<void> => apiFetch<void>(`/pipelines/${id}`, { method: 'DELETE' }),

  addStage: (id: string, input: CreatePipelineStageInput): Promise<PipelineStageRow> =>
    apiFetch<PipelineStageRow>(`/pipelines/${id}/stages`, { method: 'POST', body: input }),
  updateStage: (
    id: string,
    stageId: string,
    input: { name?: string; isTerminal?: boolean },
  ): Promise<PipelineStageRow> =>
    apiFetch<PipelineStageRow>(`/pipelines/${id}/stages/${stageId}`, {
      method: 'PATCH',
      body: input,
    }),
  removeStage: (id: string, stageId: string): Promise<void> =>
    apiFetch<void>(`/pipelines/${id}/stages/${stageId}`, { method: 'DELETE' }),
  reorderStages: (id: string, stageIds: string[]): Promise<PipelineStageRow[]> =>
    apiFetch<PipelineStageRow[]>(`/pipelines/${id}/stages/reorder`, {
      method: 'POST',
      body: { stageIds },
    }),
};

export const leadsApi = {
  list: (
    query: {
      stageCode?: LeadStageCode;
      assignedToId?: string;
      q?: string;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<PaginatedResult<Lead>> => apiFetch<PaginatedResult<Lead>>('/leads', { query }),
  /** C37 — leads whose pending follow-up is past its dueAt. Defaults
   *  to the calling user; pass `mine: '0'` to broaden to all. */
  overdue: (query: { assignedToId?: string; mine?: '0' } = {}): Promise<Lead[]> =>
    apiFetch<Lead[]>('/leads/overdue', { query }),
  /** C37 — leads with a pending follow-up due today. */
  dueToday: (query: { assignedToId?: string; mine?: '0' } = {}): Promise<Lead[]> =>
    apiFetch<Lead[]>('/leads/due-today', { query }),
  get: (id: string): Promise<Lead> => apiFetch<Lead>(`/leads/${id}`),
  create: (input: {
    name: string;
    phone: string;
    email?: string;
    source?: LeadSource;
    stageCode?: LeadStageCode;
    assignedToId?: string;
  }): Promise<Lead> => apiFetch<Lead>('/leads', { method: 'POST', body: input }),
  update: (
    id: string,
    input: { name?: string; phone?: string; email?: string | null; source?: LeadSource },
  ): Promise<Lead> => apiFetch<Lead>(`/leads/${id}`, { method: 'PATCH', body: input }),
  remove: (id: string): Promise<void> => apiFetch<void>(`/leads/${id}`, { method: 'DELETE' }),
  assign: (id: string, assignedToId: string | null): Promise<Lead> =>
    apiFetch<Lead>(`/leads/${id}/assign`, { method: 'POST', body: { assignedToId } }),
  autoAssign: (id: string): Promise<Lead | null> =>
    apiFetch<Lead | null>(`/leads/${id}/auto-assign`, { method: 'POST' }),
  moveStage: (id: string, stageCode: LeadStageCode): Promise<Lead> =>
    apiFetch<Lead>(`/leads/${id}/stage`, { method: 'POST', body: { stageCode } }),
  listActivities: (id: string): Promise<LeadActivity[]> =>
    apiFetch<LeadActivity[]>(`/leads/${id}/activities`),
  addActivity: (
    id: string,
    input: { type: Extract<LeadActivityType, 'note' | 'call'>; body: string },
  ): Promise<LeadActivity> =>
    apiFetch<LeadActivity>(`/leads/${id}/activities`, { method: 'POST', body: input }),
  convert: (
    id: string,
    input: {
      hasIdCard?: boolean;
      hasLicense?: boolean;
      hasVehicleRegistration?: boolean;
      teamId?: string | null;
    } = {},
  ): Promise<Captain> =>
    apiFetch<Captain>(`/leads/${id}/convert`, {
      method: 'POST',
      body: input,
    }),
  /** P2-06 — bulk CSV import. `csv` is the full file as text. */
  importCsv: (input: {
    csv: string;
    mapping: { name: string; phone: string; email?: string };
    defaultSource?: LeadSource;
    autoAssign?: boolean;
  }): Promise<{
    total: number;
    created: number;
    duplicates: number;
    errors: { row: number; reason: string }[];
  }> =>
    apiFetch('/leads/import', {
      method: 'POST',
      body: input,
    }),
};

// ───────────────────────────────────────────────────────────────────────
// CRM — captains (read-only) (C18)
// ───────────────────────────────────────────────────────────────────────

export const captainsApi = {
  list: (
    query: {
      teamId?: string;
      status?: CaptainStatus;
      q?: string;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<PaginatedResult<Captain>> =>
    apiFetch<PaginatedResult<Captain>>('/captains', { query }),
  get: (id: string): Promise<Captain> => apiFetch<Captain>(`/captains/${id}`),
};

// ───────────────────────────────────────────────────────────────────────
// WhatsApp — conversations + messages (C22 / C23)
// ───────────────────────────────────────────────────────────────────────

export const conversationsApi = {
  list: (
    query: {
      accountId?: string;
      status?: ConversationStatus;
      phone?: string;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<PaginatedResult<WhatsAppConversation>> =>
    apiFetch<PaginatedResult<WhatsAppConversation>>('/conversations', { query }),
  linkLead: (id: string, leadId: string): Promise<{ id: string; leadId: string | null }> =>
    apiFetch<{ id: string; leadId: string | null }>(`/conversations/${id}/link-lead`, {
      method: 'POST',
      body: { leadId },
    }),
  handover: (
    id: string,
    input: {
      newAssigneeId: string;
      mode: 'full' | 'clean' | 'summary';
      summary?: string;
      notify?: boolean;
    },
  ): Promise<{
    conversationId: string;
    leadId: string;
    fromUserId: string | null;
    toUserId: string;
    mode: 'full' | 'clean' | 'summary';
  }> =>
    apiFetch<{
      conversationId: string;
      leadId: string;
      fromUserId: string | null;
      toUserId: string;
      mode: 'full' | 'clean' | 'summary';
    }>(`/conversations/${id}/handover`, { method: 'POST', body: input }),
  get: (id: string): Promise<WhatsAppConversation> =>
    apiFetch<WhatsAppConversation>(`/conversations/${id}`),
  listMessages: (id: string, query: { limit?: number } = {}): Promise<WhatsAppMessage[]> =>
    apiFetch<WhatsAppMessage[]>(`/conversations/${id}/messages`, { query }),
  sendText: (id: string, text: string): Promise<SendConversationMessageResult> =>
    apiFetch<SendConversationMessageResult>(`/conversations/${id}/messages`, {
      method: 'POST',
      body: { text },
    }),
};

// ───────────────────────────────────────────────────────────────────────
// WhatsApp accounts — read-only list for the inbox account filter (C24)
// ───────────────────────────────────────────────────────────────────────

/**
 * The full accounts CRUD ships in the admin module (C24A). The agent
 * inbox only needs the list, so this is a thin read-only surface that
 * intentionally does not re-export create/update/enable/disable/test —
 * those belong on the admin client.
 */
export const whatsappAccountsApi = {
  list: (): Promise<WhatsAppAccount[]> => apiFetch<WhatsAppAccount[]>('/whatsapp/accounts'),
};

// ───────────────────────────────────────────────────────────────────────
// Bonuses (C32)
// ───────────────────────────────────────────────────────────────────────

export interface CreateBonusRuleInput {
  companyId: string;
  countryId: string;
  teamId?: string | null;
  roleId?: string | null;
  bonusType: BonusType;
  trigger: string;
  amount: string;
  isActive?: boolean;
}

export const bonusesApi = {
  list: (): Promise<BonusRule[]> => apiFetch<BonusRule[]>('/bonuses'),
  get: (id: string): Promise<BonusRule> => apiFetch<BonusRule>(`/bonuses/${id}`),
  create: (input: CreateBonusRuleInput): Promise<BonusRule> =>
    apiFetch<BonusRule>('/bonuses', { method: 'POST', body: input }),
  update: (id: string, input: Partial<CreateBonusRuleInput>): Promise<BonusRule> =>
    apiFetch<BonusRule>(`/bonuses/${id}`, { method: 'PATCH', body: input }),
  enable: (id: string): Promise<BonusRule> =>
    apiFetch<BonusRule>(`/bonuses/${id}/enable`, { method: 'POST' }),
  disable: (id: string): Promise<BonusRule> =>
    apiFetch<BonusRule>(`/bonuses/${id}/disable`, { method: 'POST' }),
  remove: (id: string): Promise<void> => apiFetch<void>(`/bonuses/${id}`, { method: 'DELETE' }),
};

// ───────────────────────────────────────────────────────────────────────
// Bonus accruals (P2-03) — read + status transitions
// ───────────────────────────────────────────────────────────────────────

export const bonusAccrualsApi = {
  /** Calling user's accruals (newest first). */
  mine: (query: { status?: BonusAccrualStatus } = {}): Promise<BonusAccrual[]> =>
    apiFetch<BonusAccrual[]>('/bonus-accruals/mine', {
      query: query.status ? { status: query.status } : undefined,
    }),
  /** Tenant-wide list (admin). */
  list: (
    query: { status?: BonusAccrualStatus; recipientUserId?: string } = {},
  ): Promise<BonusAccrual[]> =>
    apiFetch<BonusAccrual[]>('/bonus-accruals', {
      query: {
        ...(query.status ? { status: query.status } : {}),
        ...(query.recipientUserId ? { recipientUserId: query.recipientUserId } : {}),
      },
    }),
  setStatus: (id: string, status: BonusAccrualStatus): Promise<BonusAccrual> =>
    apiFetch<BonusAccrual>(`/bonus-accruals/${id}/status`, {
      method: 'POST',
      body: { status },
    }),
};

// ───────────────────────────────────────────────────────────────────────
// Competitions (C33)
// ───────────────────────────────────────────────────────────────────────

export interface CreateCompetitionInput {
  name: string;
  companyId?: string | null;
  countryId?: string | null;
  teamId?: string | null;
  startDate: string;
  endDate: string;
  metric: CompetitionMetric;
  reward: string;
  status?: CompetitionStatus;
}

export interface LeaderboardEntry {
  userId: string | null;
  name: string;
  email: string | null;
  score: number;
}

// ───────────────────────────────────────────────────────────────────────
// Notifications (P2-02)
// ───────────────────────────────────────────────────────────────────────

export interface NotificationRow {
  id: string;
  tenantId: string;
  recipientUserId: string;
  kind: string;
  title: string;
  body: string | null;
  payload: Record<string, unknown> | null;
  readAt: string | null;
  createdAt: string;
}

export const notificationsApi = {
  list: (query: { unread?: boolean; limit?: number } = {}): Promise<NotificationRow[]> =>
    apiFetch<NotificationRow[]>('/notifications', {
      query: {
        ...(query.unread ? { unread: '1' } : {}),
        ...(query.limit ? { limit: String(query.limit) } : {}),
      },
    }),
  unreadCount: (): Promise<{ count: number }> =>
    apiFetch<{ count: number }>('/notifications/unread-count'),
  markRead: (id: string): Promise<NotificationRow> =>
    apiFetch<NotificationRow>(`/notifications/${id}/read`, { method: 'POST' }),
  markAllRead: (): Promise<{ count: number }> =>
    apiFetch<{ count: number }>('/notifications/read-all', { method: 'POST' }),
};

// ───────────────────────────────────────────────────────────────────────
// Audit (C40)
// ───────────────────────────────────────────────────────────────────────

export interface AuditRow {
  source: 'audit_event' | 'lead_activity';
  id: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  actorUserId: string | null;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

export const auditApi = {
  list: (query: { limit?: number; before?: string } = {}): Promise<AuditRow[]> =>
    apiFetch<AuditRow[]>('/audit', { query }),
};

// ───────────────────────────────────────────────────────────────────────
// Reports (C38)
// ───────────────────────────────────────────────────────────────────────

export interface ReportFilters {
  companyId?: string;
  countryId?: string;
  teamId?: string;
  from?: string;
  to?: string;
}

export interface SummaryReport {
  totalLeads: number;
  leadsByStage: Array<{ stageCode: string; stageName: string; count: number }>;
  overdueCount: number;
  dueTodayCount: number;
  followUpsPending: number;
  followUpsDone: number;
  activations: number;
  conversionRate: number | null;
}

export const reportsApi = {
  summary: (filters: ReportFilters = {}): Promise<SummaryReport> =>
    apiFetch<SummaryReport>('/reports/summary', {
      query: { ...filters } as Record<string, string | undefined>,
    }),
};

// ───────────────────────────────────────────────────────────────────────
// Follow-ups (C36)
// ───────────────────────────────────────────────────────────────────────

export interface CreateFollowUpInput {
  actionType: FollowUpActionType;
  dueAt: string;
  note?: string;
  assignedToId?: string | null;
}

export const followUpsApi = {
  mine: (
    query: { status?: 'pending' | 'overdue' | 'done' | 'all'; limit?: number } = {},
  ): Promise<LeadFollowUp[]> => apiFetch<LeadFollowUp[]>('/follow-ups/mine', { query }),
  listForLead: (leadId: string): Promise<LeadFollowUp[]> =>
    apiFetch<LeadFollowUp[]>(`/leads/${leadId}/follow-ups`),
  create: (leadId: string, input: CreateFollowUpInput): Promise<LeadFollowUp> =>
    apiFetch<LeadFollowUp>(`/leads/${leadId}/follow-ups`, { method: 'POST', body: input }),
  complete: (id: string): Promise<LeadFollowUp> =>
    apiFetch<LeadFollowUp>(`/follow-ups/${id}/complete`, { method: 'POST' }),
  remove: (id: string): Promise<void> => apiFetch<void>(`/follow-ups/${id}`, { method: 'DELETE' }),
};

export const competitionsApi = {
  list: (): Promise<Competition[]> => apiFetch<Competition[]>('/competitions'),
  get: (id: string): Promise<Competition> => apiFetch<Competition>(`/competitions/${id}`),
  create: (input: CreateCompetitionInput): Promise<Competition> =>
    apiFetch<Competition>('/competitions', { method: 'POST', body: input }),
  update: (id: string, input: Partial<CreateCompetitionInput>): Promise<Competition> =>
    apiFetch<Competition>(`/competitions/${id}`, { method: 'PATCH', body: input }),
  setStatus: (id: string, status: CompetitionStatus): Promise<Competition> =>
    apiFetch<Competition>(`/competitions/${id}/status`, { method: 'POST', body: { status } }),
  remove: (id: string): Promise<void> =>
    apiFetch<void>(`/competitions/${id}`, { method: 'DELETE' }),
  leaderboard: (id: string): Promise<LeaderboardEntry[]> =>
    apiFetch<LeaderboardEntry[]>(`/competitions/${id}/leaderboard`),
};

// ───────────────────────────────────────────────────────────────────────
// Meta lead-ad sources (P2-06) — admin CRUD for the Meta lead-gen
// webhook routing rows. The webhook itself is public + tenant-less, so
// this admin surface only manages the configuration entries.
// ───────────────────────────────────────────────────────────────────────

export interface CreateMetaLeadSourceInput {
  displayName: string;
  pageId: string;
  formId?: string | null;
  verifyToken: string;
  appSecret?: string | null;
  defaultSource?: LeadSource;
  fieldMapping: Record<string, string>;
  isActive?: boolean;
}

export const metaLeadSourcesApi = {
  list: (): Promise<MetaLeadSource[]> => apiFetch<MetaLeadSource[]>('/meta-lead-sources'),
  get: (id: string): Promise<MetaLeadSource> =>
    apiFetch<MetaLeadSource>(`/meta-lead-sources/${id}`),
  create: (input: CreateMetaLeadSourceInput): Promise<MetaLeadSource> =>
    apiFetch<MetaLeadSource>('/meta-lead-sources', { method: 'POST', body: input }),
  update: (id: string, input: Partial<CreateMetaLeadSourceInput>): Promise<MetaLeadSource> =>
    apiFetch<MetaLeadSource>(`/meta-lead-sources/${id}`, { method: 'PATCH', body: input }),
  remove: (id: string): Promise<void> =>
    apiFetch<void>(`/meta-lead-sources/${id}`, { method: 'DELETE' }),
};

// ───────────────────────────────────────────────────────────────────────
// Tenant settings (P2-08) — timezone / SLA window / default dial code.
// ───────────────────────────────────────────────────────────────────────

export interface UpdateTenantSettingsInput {
  timezone?: string;
  slaMinutes?: number;
  defaultDialCode?: string;
}

export const tenantSettingsApi = {
  get: (): Promise<TenantSettingsRow> => apiFetch<TenantSettingsRow>('/tenant/settings'),
  update: (input: UpdateTenantSettingsInput): Promise<TenantSettingsRow> =>
    apiFetch<TenantSettingsRow>('/tenant/settings', { method: 'PATCH', body: input }),
};
