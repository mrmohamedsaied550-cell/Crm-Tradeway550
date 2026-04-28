/**
 * Tiny client-side auth store.
 *
 * The C13 admin screens consume the existing /api/v1/auth/login endpoint
 * directly from the browser; the access token returned is held in
 * `localStorage` so subsequent requests can attach it as a Bearer header.
 * The refresh token rotation flow + secure cookie storage land in a later
 * chunk — for now this is intentionally minimal so the admin UI is usable
 * end-to-end without expanding the backend surface.
 */

const ACCESS_TOKEN_KEY = 'crm.accessToken';
const TENANT_CODE_KEY = 'crm.tenantCode';
const ME_CACHE_KEY = 'crm.me';

export interface MeCache {
  readonly userId: string;
  readonly email: string;
  readonly name: string;
  readonly tenantCode: string;
  readonly roleCode: string;
  readonly roleNameEn: string;
  readonly roleNameAr: string;
}

function isBrowser(): boolean {
  return typeof window !== 'undefined';
}

export function getAccessToken(): string | null {
  if (!isBrowser()) return null;
  return window.localStorage.getItem(ACCESS_TOKEN_KEY);
}

export function setAccessToken(token: string | null): void {
  if (!isBrowser()) return;
  if (token) window.localStorage.setItem(ACCESS_TOKEN_KEY, token);
  else window.localStorage.removeItem(ACCESS_TOKEN_KEY);
}

export function getTenantCode(): string | null {
  if (!isBrowser()) return null;
  return window.localStorage.getItem(TENANT_CODE_KEY);
}

export function setTenantCode(code: string | null): void {
  if (!isBrowser()) return;
  if (code) window.localStorage.setItem(TENANT_CODE_KEY, code);
  else window.localStorage.removeItem(TENANT_CODE_KEY);
}

export function getCachedMe(): MeCache | null {
  if (!isBrowser()) return null;
  const raw = window.localStorage.getItem(ME_CACHE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as MeCache;
  } catch {
    return null;
  }
}

export function setCachedMe(me: MeCache | null): void {
  if (!isBrowser()) return;
  if (me) window.localStorage.setItem(ME_CACHE_KEY, JSON.stringify(me));
  else window.localStorage.removeItem(ME_CACHE_KEY);
}

export function clearAuth(): void {
  setAccessToken(null);
  setTenantCode(null);
  setCachedMe(null);
}
