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

import { API_VERSION_PREFIX, getApiBaseUrl } from './api-base';
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
  SendConversationMessageResult,
  WhatsAppAccount,
  Team,
  UserStatus,
  WhatsAppConversation,
  WhatsAppMessage,
  BonusRule,
  BonusAccrual,
  BonusAccrualStatus,
  BonusType,
  Competition,
  CompetitionMetric,
  CompetitionStatus,
  LeadFollowUp,
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
  const url = new URL(`${getApiBaseUrl()}${API_VERSION_PREFIX}${path}`);
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
  const tenantCode = opts.tenantCode === undefined ? getTenantCode() : opts.tenantCode;
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

import type {
  LeadDocument,
  LeadStatusFull,
  PipelineStageWithStatuses,
  AdvancedFilterRequest,
  DocumentStatus,
  FollowUpMethod,
} from './api-types';

export const pipelineApi = {
  listStages: (): Promise<PipelineStage[]> => apiFetch<PipelineStage[]>('/pipeline/stages'),
  listStagesWithStatuses: (): Promise<PipelineStageWithStatuses[]> =>
    apiFetch<PipelineStageWithStatuses[]>('/pipeline/stages-with-statuses'),
};

// ───────────────────────────────────────────────────────────────────────
// CRM — lead statuses (C30)
// ───────────────────────────────────────────────────────────────────────

export const leadStatusesApi = {
  list: (stageId?: string): Promise<LeadStatusFull[]> =>
    apiFetch<LeadStatusFull[]>('/crm/lead-statuses', { query: { stageId } }),
  create: (input: {
    stageId: string;
    code: string;
    name: string;
    color?: string;
    order?: number;
    isDefault?: boolean;
  }): Promise<LeadStatusFull> =>
    apiFetch<LeadStatusFull>('/crm/lead-statuses', { method: 'POST', body: input }),
  update: (
    id: string,
    input: { name?: string; color?: string; order?: number; isDefault?: boolean },
  ): Promise<LeadStatusFull> =>
    apiFetch<LeadStatusFull>(`/crm/lead-statuses/${id}`, { method: 'PATCH', body: input }),
  remove: (id: string): Promise<void> =>
    apiFetch<void>(`/crm/lead-statuses/${id}`, { method: 'DELETE' }),
  /** Change a lead's status within its current stage. */
  changeLeadStatus: (leadId: string, statusId: string): Promise<Lead> =>
    apiFetch<Lead>(`/crm/leads/${leadId}/status`, { method: 'PATCH', body: { statusId } }),
};

// ───────────────────────────────────────────────────────────────────────
// CRM — lead documents (C30)
// ───────────────────────────────────────────────────────────────────────

export const leadDocumentsApi = {
  list: (leadId: string): Promise<LeadDocument[]> =>
    apiFetch<LeadDocument[]>(`/crm/leads/${leadId}/documents`),
  create: (
    leadId: string,
    input: { type: string; label: string; notes?: string },
  ): Promise<LeadDocument> =>
    apiFetch<LeadDocument>(`/crm/leads/${leadId}/documents`, { method: 'POST', body: input }),
  updateStatus: (
    leadId: string,
    docId: string,
    input: { status: DocumentStatus; notes?: string; fileUrl?: string },
  ): Promise<LeadDocument> =>
    apiFetch<LeadDocument>(`/crm/leads/${leadId}/documents/${docId}`, {
      method: 'PATCH',
      body: input,
    }),
};

// ───────────────────────────────────────────────────────────────────────
// CRM — advanced search / query builder (C30)
// ───────────────────────────────────────────────────────────────────────

export const leadSearchApi = {
  search: (filters: AdvancedFilterRequest): Promise<PaginatedResult<Lead>> =>
    apiFetch<PaginatedResult<Lead>>('/crm/leads/search', { method: 'POST', body: filters }),
};

// ───────────────────────────────────────────────────────────────────────
// CRM — WhatsApp conversation lookup by lead (C30)
// ───────────────────────────────────────────────────────────────────────

export const leadConversationsApi = {
  findByLead: (leadId: string): Promise<WhatsAppConversation[]> =>
    apiFetch<WhatsAppConversation[]>(`/crm/leads/${leadId}/conversations`),
};

export const leadsApi = {
  list: (
    query: {
      stageCode?: LeadStageCode;
      statusCode?: string;
      assignedToId?: string;
      q?: string;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<PaginatedResult<Lead>> => apiFetch<PaginatedResult<Lead>>('/leads', { query }),
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
  /** Agent workspace — overdue follow-ups for the calling user by default. */
  overdue: (
    query: { assignedToId?: string; mine?: '0' | '1' } = {},
  ): Promise<Lead[]> => apiFetch<Lead[]>('/leads/overdue', { query }),
  /** Agent workspace — leads with a follow-up due today. */
  dueToday: (
    query: { assignedToId?: string; mine?: '0' | '1' } = {},
  ): Promise<Lead[]> => apiFetch<Lead[]>('/leads/due-today', { query }),
  /** Admin CSV import (P2-06). Body is JSON; CSV passed as a string. */
  importCsv: (input: {
    csv: string;
    mapping: { name: string; phone: string; email?: string };
    defaultSource?: LeadSource;
    autoAssign?: boolean;
  }): Promise<{
    total: number;
    created: number;
    duplicates: number;
    errors: Array<{ row: number; reason: string }>;
  }> =>
    apiFetch<{
      total: number;
      created: number;
      duplicates: number;
      errors: Array<{ row: number; reason: string }>;
    }>('/leads/import', { method: 'POST', body: input }),
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
  get: (id: string): Promise<WhatsAppConversation> =>
    apiFetch<WhatsAppConversation>(`/conversations/${id}`),
  listMessages: (id: string, query: { limit?: number } = {}): Promise<WhatsAppMessage[]> =>
    apiFetch<WhatsAppMessage[]>(`/conversations/${id}/messages`, { query }),
  sendText: (id: string, text: string): Promise<SendConversationMessageResult> =>
    apiFetch<SendConversationMessageResult>(`/conversations/${id}/messages`, {
      method: 'POST',
      body: { text },
    }),
  /** C35 — hand the conversation off to another agent. */
  handover: (
    id: string,
    input: {
      newAssigneeId: string;
      mode: 'full' | 'clean' | 'summary';
      summary?: string;
      notify?: boolean;
    },
  ): Promise<WhatsAppConversation> =>
    apiFetch<WhatsAppConversation>(`/conversations/${id}/handover`, {
      method: 'POST',
      body: input,
    }),
  /** Link a conversation to a CRM lead (idempotent). */
  linkLead: (id: string, leadId: string): Promise<WhatsAppConversation> =>
    apiFetch<WhatsAppConversation>(`/conversations/${id}/link-lead`, {
      method: 'POST',
      body: { leadId },
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
// Audit (C-AUDIT)
// ───────────────────────────────────────────────────────────────────────
/**
 * Mirror of the API's `AuditRow` (apps/api/src/audit/audit.service.ts).
 * `payload` is whatever JSON the writer stored, hence `unknown`. Date
 * fields come over the wire as ISO strings.
 */
export interface AuditRow {
  source: 'audit_event' | 'lead_activity';
  id: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  actorUserId: string | null;
  payload: unknown;
  createdAt: string;
}

export const auditApi = {
  list: (
    query: { limit?: number; before?: string; action?: string } = {},
  ): Promise<AuditRow[]> => apiFetch<AuditRow[]>('/audit', { query }),
};

// ───────────────────────────────────────────────────────────────────────
// Notifications (C-NOTIF)
// ───────────────────────────────────────────────────────────────────────
/**
 * Mirror of the API's Notification model (apps/api/prisma/schema.prisma).
 */
export interface NotificationRow {
  id: string;
  tenantId: string;
  recipientUserId: string;
  kind: string;
  title: string;
  body: string | null;
  payload: unknown;
  readAt: string | null;
  createdAt: string;
}

export const notificationsApi = {
  list: (query: { unread?: boolean; limit?: number } = {}): Promise<NotificationRow[]> =>
    apiFetch<NotificationRow[]>('/notifications', {
      query: {
        ...(query.unread !== undefined && { unread: query.unread ? '1' : '0' }),
        ...(query.limit !== undefined && { limit: query.limit }),
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
// Reports (C38)
// ───────────────────────────────────────────────────────────────────────
/**
 * Mirror of `ReportFiltersDto` (apps/api/src/reports/report.dto.ts) and
 * `SummaryReport` (apps/api/src/reports/reports.service.ts).
 */
export interface ReportFilters {
  companyId?: string;
  countryId?: string;
  teamId?: string;
  /** ISO date or datetime, inclusive. */
  from?: string;
  /** ISO date or datetime, inclusive. */
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
  /** Percentage 0..100 (rounded to one decimal). null when totalLeads === 0. */
  conversionRate: number | null;
}

export const reportsApi = {
  summary: (filters: ReportFilters = {}): Promise<SummaryReport> =>
    apiFetch<SummaryReport>('/reports/summary', {
      query: filters as Record<string, string | undefined>,
    }),
};

// ───────────────────────────────────────────────────────────────────────
// Follow-ups (C36)
// ───────────────────────────────────────────────────────────────────────

export const followUpsApi = {
  mine: (
    query: { status?: 'pending' | 'done' | 'all'; limit?: number } = {},
  ): Promise<LeadFollowUp[]> => apiFetch<LeadFollowUp[]>('/crm/follow-ups/mine', { query }),
  listForLead: (leadId: string): Promise<LeadFollowUp[]> =>
    apiFetch<LeadFollowUp[]>(`/crm/leads/${leadId}/follow-ups`),
  /** Schedule a follow-up against a lead. The agent workspace calls this. */
  create: (leadId: string, input: { scheduledAt: string; method: FollowUpMethod; note?: string | null }): Promise<LeadFollowUp> =>
    apiFetch<LeadFollowUp>(`/crm/leads/${leadId}/follow-ups`, { method: 'POST', body: input }),
  createForLead: (leadId: string, input: { scheduledAt: string; method: FollowUpMethod; note?: string | null }): Promise<LeadFollowUp> =>
    apiFetch<LeadFollowUp>(`/crm/leads/${leadId}/follow-ups`, { method: 'POST', body: input }),
  complete: (leadId: string, followUpId: string): Promise<LeadFollowUp> =>
    apiFetch<LeadFollowUp>(`/crm/leads/${leadId}/follow-ups/${followUpId}/complete`, { method: 'PATCH' }),
  remove: (id: string): Promise<void> =>
    apiFetch<void>(`/crm/follow-ups/${id}`, { method: 'DELETE' }),
};

// ───────────────────────────────────────────────────────────────────────
// Bonuses (C32) + bonus accruals (P2-03)
// ───────────────────────────────────────────────────────────────────────
export interface CreateBonusRuleInput {
  companyId: string;
  countryId: string;
  teamId?: string | null;
  roleId?: string | null;
  bonusType: BonusType;
  trigger: string;
  /** Decimal as number or string; the API normalises both. */
  amount: number | string;
  isActive?: boolean;
}
export type UpdateBonusRuleInput = Partial<CreateBonusRuleInput>;

export const bonusesApi = {
  list: (): Promise<BonusRule[]> => apiFetch<BonusRule[]>('/bonuses'),
  get: (id: string): Promise<BonusRule> => apiFetch<BonusRule>(`/bonuses/${id}`),
  create: (input: CreateBonusRuleInput): Promise<BonusRule> =>
    apiFetch<BonusRule>('/bonuses', { method: 'POST', body: input }),
  update: (id: string, input: UpdateBonusRuleInput): Promise<BonusRule> =>
    apiFetch<BonusRule>(`/bonuses/${id}`, { method: 'PATCH', body: input }),
  enable: (id: string): Promise<BonusRule> =>
    apiFetch<BonusRule>(`/bonuses/${id}/enable`, { method: 'POST' }),
  disable: (id: string): Promise<BonusRule> =>
    apiFetch<BonusRule>(`/bonuses/${id}/disable`, { method: 'POST' }),
  remove: (id: string): Promise<void> =>
    apiFetch<void>(`/bonuses/${id}`, { method: 'DELETE' }),
};

export const bonusAccrualsApi = {
  mine: (
    query: { status?: BonusAccrualStatus; limit?: number } = {},
  ): Promise<BonusAccrual[]> => apiFetch<BonusAccrual[]>('/bonus-accruals/mine', { query }),
  list: (
    query: { status?: BonusAccrualStatus; recipientUserId?: string; limit?: number } = {},
  ): Promise<BonusAccrual[]> => apiFetch<BonusAccrual[]>('/bonus-accruals', { query }),
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
export type UpdateCompetitionInput = Partial<CreateCompetitionInput>;
/** Mirror of `LeaderboardEntry` (apps/api/src/competitions/competitions.service.ts). */
export interface LeaderboardEntry {
  userId: string | null;
  name: string;
  email: string | null;
  score: number;
}

export const competitionsApi = {
  list: (): Promise<Competition[]> => apiFetch<Competition[]>('/competitions'),
  get: (id: string): Promise<Competition> => apiFetch<Competition>(`/competitions/${id}`),
  create: (input: CreateCompetitionInput): Promise<Competition> =>
    apiFetch<Competition>('/competitions', { method: 'POST', body: input }),
  update: (id: string, input: UpdateCompetitionInput): Promise<Competition> =>
    apiFetch<Competition>(`/competitions/${id}`, { method: 'PATCH', body: input }),
  setStatus: (id: string, status: CompetitionStatus): Promise<Competition> =>
    apiFetch<Competition>(`/competitions/${id}/status`, {
      method: 'POST',
      body: { status },
    }),
  leaderboard: (id: string): Promise<LeaderboardEntry[]> =>
    apiFetch<LeaderboardEntry[]>(`/competitions/${id}/leaderboard`),
  remove: (id: string): Promise<void> =>
    apiFetch<void>(`/competitions/${id}`, { method: 'DELETE' }),
};
