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
import {
  clearAuth,
  getAccessToken,
  getRefreshToken,
  getTenantCode,
  setAccessToken,
  setRefreshToken,
} from './auth';
import type {
  AdminUser,
  AgentCapacityRow,
  Captain,
  CaptainDocument,
  CaptainStatus,
  CaptainTripRow,
  Company,
  ConversationStatus,
  Country,
  DistributionRuleRow,
  DistributionStrategyName,
  Lead,
  LeadActivity,
  LeadActivityType,
  LeadRoutingLogRow,
  LeadSource,
  LeadStageCode,
  LoginResponse,
  MeUser,
  PaginatedResult,
  PipelineStage,
  RecordTripResult,
  RefreshResponse,
  RoleSummary,
  SlaStatus,
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
  WhatsAppTemplateRow,
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
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  /** Override the Bearer token (used by the login flow itself). */
  bearerToken?: string | null;
  /** Send the tenant code as `X-Tenant`. Defaults to whatever auth.ts has. */
  tenantCode?: string | null;
  /**
   * P2-10 — internal flag. When `true`, the 401-refresh interceptor
   * skips its retry path and just throws so we don't recurse forever
   * (a refreshed token still hitting 401 means the underlying
   * authorisation is broken, not the token).
   */
  _isRetry?: boolean;
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

/**
 * P2-10 — single-flight refresh promise.
 *
 * Multiple in-flight 401s share the same refresh round-trip so we
 * don't run N parallel `/auth/refresh` calls and burn N refresh
 * tokens (the server's reuse-detection would then revoke the entire
 * session chain on the second call). Cleared once the refresh
 * settles, regardless of outcome.
 */
let inFlightRefresh: Promise<string | null> | null = null;

/**
 * Try once to rotate the refresh token. Returns the new access
 * token on success, or null on failure (in which case
 * `clearAuth()` has already been called by `apiFetch`'s caller).
 *
 * The fetch here is intentionally low-level (raw `fetch`, no
 * `apiFetch` recursion): a refresh-token call going through
 * apiFetch would pass through the same 401-retry logic and could
 * loop forever.
 */
async function refreshTokensOnce(): Promise<string | null> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return null;
  let res: Response;
  try {
    res = await fetch(buildUrl('/auth/refresh', undefined), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ refreshToken }),
      credentials: 'omit',
      cache: 'no-store',
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const parsed = (await res.json().catch(() => null)) as RefreshResponse | null;
  if (
    !parsed ||
    typeof parsed.accessToken !== 'string' ||
    typeof parsed.refreshToken !== 'string'
  ) {
    return null;
  }
  setAccessToken(parsed.accessToken);
  setRefreshToken(parsed.refreshToken);
  return parsed.accessToken;
}

/**
 * Coalesces concurrent refresh attempts to a single in-flight
 * promise. Every caller awaits the same outcome.
 */
function refreshTokensSingleFlight(): Promise<string | null> {
  if (inFlightRefresh) return inFlightRefresh;
  inFlightRefresh = refreshTokensOnce().finally(() => {
    inFlightRefresh = null;
  });
  return inFlightRefresh;
}

/**
 * P2-10 — when refresh fails (or there's no refresh token), wipe
 * the cached identity and bounce the operator to /login. We do
 * this from the API client so a stale tab automatically heals
 * itself instead of presenting cryptic 401 toasts.
 */
function forceLogout(): void {
  clearAuth();
  if (typeof window !== 'undefined') {
    const here = window.location.pathname + window.location.search;
    // Avoid bouncing infinitely if we're already on /login.
    if (!window.location.pathname.startsWith('/login')) {
      const next = encodeURIComponent(here);
      window.location.assign(`/login?next=${next}`);
    }
  }
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
    // P2-10 — auto-refresh on 401 for authenticated requests.
    //
    // Conditions that must ALL hold:
    //   - status is 401,
    //   - the original call carried a Bearer token (so it WAS
    //     authenticated; a 401 from a public endpoint isn't a
    //     token-expiry signal),
    //   - this isn't already a retry (`_isRetry` guard prevents
    //     infinite loops),
    //   - we're not calling /auth/login or /auth/refresh ourselves
    //     (those use bearerToken: null and bypass anyway, but
    //     belt-and-braces).
    //
    // On success: re-issue the request once with the fresh token.
    // On failure: clear local auth and redirect to /login so the
    // user can sign in again.
    const isAuthEndpoint = path.startsWith('/auth/refresh') || path.startsWith('/auth/login');
    if (res.status === 401 && token && !opts._isRetry && !isAuthEndpoint) {
      const newToken = await refreshTokensSingleFlight();
      if (newToken) {
        return apiFetch<T>(path, { ...opts, _isRetry: true });
      }
      forceLogout();
    }

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
  /**
   * P2-10 — explicit rotate-the-tokens endpoint. The transparent
   * 401-retry path inside `apiFetch` is what most callers rely on;
   * this is exposed for tests and for any future "refresh before
   * the access token expires" pre-emptive flow.
   */
  refresh(refreshToken: string): Promise<RefreshResponse> {
    return apiFetch<RefreshResponse>('/auth/refresh', {
      method: 'POST',
      body: { refreshToken },
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
  /**
   * Phase 1B — resolve the right pipeline for a (company, country)
   * scope and return its stages in one round-trip. Used by the
   * create-lead form, lead detail dropdown, and (later) Kanban.
   */
  resolve: (query: {
    companyId?: string;
    countryId?: string;
  }): Promise<{
    pipeline: {
      id: string;
      isDefault: boolean;
      companyId: string | null;
      countryId: string | null;
    };
    stages: PipelineStage[];
  }> =>
    apiFetch<{
      pipeline: {
        id: string;
        isDefault: boolean;
        companyId: string | null;
        countryId: string | null;
      };
      stages: PipelineStage[];
    }>('/pipelines/resolve', { query }),
  /**
   * Phase 1B — stages of a specific pipeline. For lead-detail
   * dropdowns + Kanban columns.
   */
  stagesOf: (id: string): Promise<PipelineStage[]> =>
    apiFetch<PipelineStage[]>(`/pipelines/${id}/stages`),
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
      /**
       * Phase 1B — three stage-filter inputs (mutually exclusive in
       * practice; the server validates only one is sent):
       *   • `pipelineStageId` — exact stage row (preferred for Kanban).
       *   • `pipelineId`      — every lead currently in this pipeline.
       *   • `stageCode`       — legacy code-based filter, resolved
       *                          against the tenant default pipeline.
       *                          Kept for backward compatibility with
       *                          existing callers; new code should
       *                          prefer pipelineStageId.
       */
      pipelineStageId?: string;
      pipelineId?: string;
      stageCode?: LeadStageCode;
      /** Phase 1B — narrow by (company, country). */
      companyId?: string;
      countryId?: string;
      assignedToId?: string;
      q?: string;
      /** P3-03 — narrow by source / SLA / date / unassigned / overdue. */
      source?: LeadSource;
      slaStatus?: SlaStatus;
      /** ISO-8601 timestamp; web sends day-precision (`yyyy-mm-ddT00:00:00Z`). */
      createdFrom?: string;
      createdTo?: string;
      unassigned?: boolean;
      hasOverdueFollowup?: boolean;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<PaginatedResult<Lead>> => apiFetch<PaginatedResult<Lead>>('/leads', { query }),
  /**
   * Phase 1 — Kanban grouped query. One round-trip returns one
   * bucket per stage of `pipelineId`, each bucket carrying its
   * `totalCount` and the first `perStage` cards.
   */
  listByStage: (query: {
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
    perStage?: number;
  }): Promise<{
    pipelineId: string;
    perStage: number;
    stages: {
      stage: { id: string; code: string; name: string; order: number; isTerminal: boolean };
      totalCount: number;
      leads: Lead[];
    }[];
  }> =>
    apiFetch<{
      pipelineId: string;
      perStage: number;
      stages: {
        stage: { id: string; code: string; name: string; order: number; isTerminal: boolean };
        totalCount: number;
        leads: Lead[];
      }[];
    }>('/leads/by-stage', { query }),
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
    /**
     * Phase 1B — initial-stage discriminator. Pass at most one:
     *   • `pipelineStageId` — explicit stage UUID (preferred).
     *   • `stageCode`       — resolved against the lead's pipeline.
     * Omitting both lets the server pick the entry-point stage of the
     * resolved pipeline.
     */
    stageCode?: LeadStageCode;
    pipelineStageId?: string;
    /**
     * Phase 1B — explicit (company × country) scope. Drives which
     * pipeline the new lead lands on.
     */
    companyId?: string;
    countryId?: string;
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
  /**
   * Phase 1B — accepts either a stage UUID (preferred) or a stage
   * code. The server resolves the code against THIS lead's pipeline,
   * so the same code in two pipelines never cross-pollinates.
   */
  moveStage: (
    id: string,
    target: { pipelineStageId: string } | { stageCode: LeadStageCode },
  ): Promise<Lead> => apiFetch<Lead>(`/leads/${id}/stage`, { method: 'POST', body: target }),
  listActivities: (id: string): Promise<LeadActivity[]> =>
    apiFetch<LeadActivity[]>(`/leads/${id}/activities`),
  /**
   * Phase 1A — A8: routing decisions recorded for this lead, newest
   * first. Gated on `lead.read` server-side, so anyone with access to
   * the lead detail can see why it was routed where it was.
   */
  routingLog: (id: string): Promise<LeadRoutingLogRow[]> =>
    apiFetch<LeadRoutingLogRow[]>(`/leads/${id}/routing-log`),
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
  /**
   * P3-05 — bulk actions. Each endpoint accepts up to 100 lead ids
   * per call and returns `{ updated, failed }`. The UI surfaces both
   * halves so a partial outcome (e.g. one lead deleted in another
   * tab during the batch) doesn't force a full retry.
   */
  bulkAssign: (input: {
    leadIds: readonly string[];
    assignedToId: string | null;
  }): Promise<{
    updated: string[];
    failed: { id: string; code: string; message: string }[];
  }> =>
    apiFetch('/leads/bulk-assign', {
      method: 'POST',
      body: { leadIds: input.leadIds, assignedToId: input.assignedToId },
    }),
  /**
   * Phase 1B — bulk move accepts either a stage UUID (resolved
   * across all leads in the batch — they must all be on the same
   * pipeline as the target stage) or a stage code (resolved
   * per-lead against each lead's pipeline; lets a single bulk move
   * land "contacted" on leads spread across pipelines that all
   * happen to define that code).
   */
  bulkStage: (
    input: { leadIds: readonly string[] } & (
      | { pipelineStageId: string; stageCode?: never }
      | { stageCode: LeadStageCode; pipelineStageId?: never }
    ),
  ): Promise<{
    updated: string[];
    failed: { id: string; code: string; message: string }[];
  }> =>
    apiFetch('/leads/bulk-stage', {
      method: 'POST',
      body:
        'pipelineStageId' in input
          ? { leadIds: input.leadIds, pipelineStageId: input.pipelineStageId }
          : { leadIds: input.leadIds, stageCode: input.stageCode },
    }),
  bulkDelete: (input: {
    leadIds: readonly string[];
  }): Promise<{
    updated: string[];
    failed: { id: string; code: string; message: string }[];
  }> => apiFetch('/leads/bulk-delete', { method: 'POST', body: { leadIds: input.leadIds } }),
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
// P3-07 — tenant backup / export. Sensitive fields (access tokens,
// password hashes) are stripped server-side; the response is still
// considered HIGHLY sensitive — never log it.
// ───────────────────────────────────────────────────────────────────────

export interface TenantBackupSummary {
  exportedAt: string;
  tenant: { id: string; code: string; name: string };
  schemaVersion: number;
  rowCap: number;
  counts: Record<string, number>;
}

export const backupApi = {
  /**
   * Returns the full export envelope. The web side sums `counts` for
   * the summary and offers the same payload as a Blob download.
   */
  exportTenant: (): Promise<TenantBackupSummary & { data: unknown }> =>
    apiFetch<TenantBackupSummary & { data: unknown }>('/admin/backup/export'),
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
// Captain documents + trip telemetry (P2-09)
// ───────────────────────────────────────────────────────────────────────

export interface UploadCaptainDocumentInput {
  kind: string;
  storageRef: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  expiresAt?: string | null;
}

export interface RecordTripInput {
  tripId: string;
  occurredAt: string;
  payload?: Record<string, unknown>;
}

export const captainDocumentsApi = {
  listForCaptain: (captainId: string, status?: string): Promise<CaptainDocument[]> =>
    apiFetch<CaptainDocument[]>(`/captains/${captainId}/documents`, {
      query: status ? { status } : undefined,
    }),
  upload: (captainId: string, input: UploadCaptainDocumentInput): Promise<CaptainDocument> =>
    apiFetch<CaptainDocument>(`/captains/${captainId}/documents`, {
      method: 'POST',
      body: input,
    }),
  review: (
    docId: string,
    input: { decision: 'approve' | 'reject'; notes?: string },
  ): Promise<CaptainDocument> =>
    apiFetch<CaptainDocument>(`/captain-documents/${docId}/review`, {
      method: 'POST',
      body: input,
    }),
  remove: (docId: string): Promise<void> =>
    apiFetch<void>(`/captain-documents/${docId}`, { method: 'DELETE' }),
};

export const captainTripsApi = {
  listForCaptain: (captainId: string): Promise<CaptainTripRow[]> =>
    apiFetch<CaptainTripRow[]>(`/captains/${captainId}/trips`),
  record: (captainId: string, input: RecordTripInput): Promise<RecordTripResult> =>
    apiFetch<RecordTripResult>(`/captains/${captainId}/trips`, {
      method: 'POST',
      body: input,
    }),
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
  /** P2-12 — send a Meta-approved template; allowed even outside the 24h window. */
  sendTemplate: (
    id: string,
    input: { templateName: string; language: string; variables: string[] },
  ): Promise<SendConversationMessageResult> =>
    apiFetch<SendConversationMessageResult>(`/conversations/${id}/messages/template`, {
      method: 'POST',
      body: input,
    }),
  /** P2-12 — send media (image / document); gated by the 24h window. */
  sendMedia: (
    id: string,
    input: {
      kind: 'image' | 'document';
      mediaUrl: string;
      mediaMimeType?: string;
      caption?: string;
    },
  ): Promise<SendConversationMessageResult> =>
    apiFetch<SendConversationMessageResult>(`/conversations/${id}/messages/media`, {
      method: 'POST',
      body: input,
    }),
};

/**
 * P2-12 — admin CRUD over the WhatsApp template picker.
 */
export interface CreateWhatsAppTemplateInput {
  accountId: string;
  name: string;
  language: string;
  category: 'marketing' | 'utility' | 'authentication';
  bodyText: string;
  status?: 'approved' | 'paused' | 'rejected';
}

export const whatsappTemplatesApi = {
  list: (
    query: { accountId?: string; status?: 'approved' | 'paused' | 'rejected' } = {},
  ): Promise<WhatsAppTemplateRow[]> =>
    apiFetch<WhatsAppTemplateRow[]>('/whatsapp/templates', { query }),
  get: (id: string): Promise<WhatsAppTemplateRow> =>
    apiFetch<WhatsAppTemplateRow>(`/whatsapp/templates/${id}`),
  create: (input: CreateWhatsAppTemplateInput): Promise<WhatsAppTemplateRow> =>
    apiFetch<WhatsAppTemplateRow>('/whatsapp/templates', { method: 'POST', body: input }),
  update: (
    id: string,
    input: {
      bodyText?: string;
      category?: 'marketing' | 'utility' | 'authentication';
      status?: 'approved' | 'paused' | 'rejected';
    },
  ): Promise<WhatsAppTemplateRow> =>
    apiFetch<WhatsAppTemplateRow>(`/whatsapp/templates/${id}`, {
      method: 'PATCH',
      body: input,
    }),
  remove: (id: string): Promise<void> =>
    apiFetch<void>(`/whatsapp/templates/${id}`, { method: 'DELETE' }),
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

export type TimeseriesMetric = 'leads_created' | 'activations' | 'first_trips';

export interface TimeseriesPoint {
  date: string;
  count: number;
}

export interface TimeseriesReport {
  metric: TimeseriesMetric;
  from: string;
  to: string;
  points: TimeseriesPoint[];
}

export const reportsApi = {
  summary: (filters: ReportFilters = {}): Promise<SummaryReport> =>
    apiFetch<SummaryReport>('/reports/summary', {
      query: { ...filters } as Record<string, string | undefined>,
    }),
  timeseries: (filters: ReportFilters & { metric: TimeseriesMetric }): Promise<TimeseriesReport> =>
    apiFetch<TimeseriesReport>('/reports/timeseries', {
      query: { ...filters } as Record<string, string | undefined>,
    }),
  /**
   * P2-11 — returns the URL for the CSV export, with the access
   * token embedded in the Authorization header via a fetch + blob
   * download. Browser-friendly: triggers a download by clicking
   * a synthesised <a> with `download="..."`.
   */
  exportCsvUrl: (filters: ReportFilters = {}): string => {
    const url = new URL(`${API_BASE_URL}${API_VERSION_PREFIX}/reports/export.csv`);
    for (const [k, v] of Object.entries(filters)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    return url.toString();
  },
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
  /**
   * P3-04 — calendar feed. `from` and `to` are ISO datetimes; `mine`
   * defaults to '1' (caller only). The web calendar passes the
   * month-grid bounds as the window.
   */
  calendar: (query: {
    from: string;
    to: string;
    mine?: '0' | '1';
    limit?: number;
  }): Promise<LeadFollowUp[]> => apiFetch<LeadFollowUp[]>('/follow-ups/calendar', { query }),
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
  /** PL-3 — replace the rule list (omit to leave unchanged). */
  distributionRules?: { source: LeadSource; assigneeUserId: string }[];
}

export const tenantSettingsApi = {
  get: (): Promise<TenantSettingsRow> => apiFetch<TenantSettingsRow>('/tenant/settings'),
  update: (input: UpdateTenantSettingsInput): Promise<TenantSettingsRow> =>
    apiFetch<TenantSettingsRow>('/tenant/settings', { method: 'PATCH', body: input }),
};

// ───────────────────────────────────────────────────────────────────────
// Distribution Engine (Phase 1A — A8)
//
// Admin-side surface for the rule engine that decides which agent a
// lead is routed to. Three flat resources mirror the API:
//   - rules       → CRUD over distribution_rules (priority order)
//   - capacities  → upsert per-user capacity row (max active leads,
//                   weight, availability, OOF, working hours)
//   - logs        → read-only routing decisions (audit trail)
//
// `targetUserId` is REQUIRED when strategy='specific_user' and
// FORBIDDEN otherwise — Zod enforces this server-side; the form layer
// mirrors the same invariant for UX (PATCH re-validates against the
// merged shape).
// ───────────────────────────────────────────────────────────────────────

export interface CreateDistributionRuleInput {
  name: string;
  isActive?: boolean;
  /** Lower = higher precedence; default 100. Server clamps to [1, 1000]. */
  priority?: number;
  source?: LeadSource | null;
  companyId?: string | null;
  countryId?: string | null;
  targetTeamId?: string | null;
  strategy: DistributionStrategyName;
  /** Required when `strategy === 'specific_user'`. */
  targetUserId?: string | null;
}

export type UpdateDistributionRuleInput = Partial<CreateDistributionRuleInput>;

export interface UpsertAgentCapacityInput {
  weight?: number;
  isAvailable?: boolean;
  /** ISO datetime; pass `null` to clear the OOF window. */
  outOfOfficeUntil?: string | null;
  /** `null` = no cap. */
  maxActiveLeads?: number | null;
  workingHours?: Record<string, { start: string; end: string }> | null;
}

export interface ListRoutingLogsQuery {
  leadId?: string;
  /** ISO datetime — return only logs decided at or after this point. */
  from?: string;
  /** Default 50, max 200. */
  limit?: number;
}

export const distributionApi = {
  rules: {
    list: (): Promise<DistributionRuleRow[]> =>
      apiFetch<DistributionRuleRow[]>('/distribution/rules'),
    create: (input: CreateDistributionRuleInput): Promise<DistributionRuleRow> =>
      apiFetch<DistributionRuleRow>('/distribution/rules', { method: 'POST', body: input }),
    update: (id: string, input: UpdateDistributionRuleInput): Promise<DistributionRuleRow> =>
      apiFetch<DistributionRuleRow>(`/distribution/rules/${id}`, {
        method: 'PATCH',
        body: input,
      }),
    remove: (id: string): Promise<void> =>
      apiFetch<void>(`/distribution/rules/${id}`, { method: 'DELETE' }),
  },
  capacities: {
    list: (): Promise<AgentCapacityRow[]> =>
      apiFetch<AgentCapacityRow[]>('/distribution/capacities'),
    upsert: (userId: string, input: UpsertAgentCapacityInput): Promise<AgentCapacityRow> =>
      apiFetch<AgentCapacityRow>(`/distribution/capacities/${userId}`, {
        method: 'PUT',
        body: input,
      }),
  },
  logs: {
    list: (query: ListRoutingLogsQuery = {}): Promise<LeadRoutingLogRow[]> =>
      apiFetch<LeadRoutingLogRow[]>('/distribution/logs', {
        query: {
          ...(query.leadId !== undefined && { leadId: query.leadId }),
          ...(query.from !== undefined && { from: query.from }),
          ...(query.limit !== undefined && { limit: query.limit }),
        },
      }),
  },
};
