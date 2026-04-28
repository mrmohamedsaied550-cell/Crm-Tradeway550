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
  Company,
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
  Team,
  UserStatus,
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
  disable: (id: string): Promise<AdminUser> =>
    apiFetch<AdminUser>(`/users/${id}/disable`, { method: 'POST' }),
  remove: (id: string): Promise<void> => apiFetch<void>(`/users/${id}`, { method: 'DELETE' }),
};

// ───────────────────────────────────────────────────────────────────────
// CRM — pipeline stages + leads + activities
// ───────────────────────────────────────────────────────────────────────

export const pipelineApi = {
  listStages: (): Promise<PipelineStage[]> => apiFetch<PipelineStage[]>('/pipeline/stages'),
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
    } = {},
  ): Promise<{ id: string; onboardingStatus: string }> =>
    apiFetch<{ id: string; onboardingStatus: string }>(`/leads/${id}/convert`, {
      method: 'POST',
      body: input,
    }),
};
