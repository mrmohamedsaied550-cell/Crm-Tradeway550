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
const REFRESH_TOKEN_KEY = 'crm.refreshToken';
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
  /** P2-01 — flat list of capability codes granted by the user's role. */
  readonly capabilities?: readonly string[];
  /**
   * Phase C — C6: per-(resource × field) read/write toggles for the
   * calling user's role. Read by `lib/permissions.ts` and the
   * `<FieldGated>` UI wrapper. Empty list on the super_admin bypass.
   * Optional so the cache stays compatible with sessions written
   * before the C6 deploy — `permissions.ts` treats an absent list
   * as "no denies known", i.e. permissive by default. The server
   * remains the source of truth.
   */
  readonly fieldPermissions?: ReadonlyArray<{
    readonly resource: string;
    readonly field: string;
    readonly canRead: boolean;
    readonly canWrite: boolean;
  }>;
}

/**
 * P2-01 — quick capability check against the cached me payload.
 * Returns false on the server (SSR) so the UI defaults to "hide" until
 * hydration; the AdminAuthGuard owns the actual access decision.
 */
export function hasCapability(cap: string): boolean {
  if (!isBrowser()) return false;
  const me = getCachedMe();
  return Boolean(me?.capabilities?.includes(cap));
}

function isBrowser(): boolean {
  return typeof window !== 'undefined';
}

export function getAccessToken(): string | null {
  if (!isBrowser()) return null;
  const v = window.localStorage.getItem(ACCESS_TOKEN_KEY);
  // Treat an empty / whitespace-only entry as "no token" so apiFetch's
  // `if (token)` check never spuriously skips the Authorization header.
  return v && v.trim().length > 0 ? v : null;
}

export function setAccessToken(token: string | null): void {
  if (!isBrowser()) return;
  const v = typeof token === 'string' ? token.trim() : '';
  if (v.length > 0) window.localStorage.setItem(ACCESS_TOKEN_KEY, v);
  else window.localStorage.removeItem(ACCESS_TOKEN_KEY);
}

export function getRefreshToken(): string | null {
  if (!isBrowser()) return null;
  const v = window.localStorage.getItem(REFRESH_TOKEN_KEY);
  return v && v.trim().length > 0 ? v : null;
}

export function setRefreshToken(token: string | null): void {
  if (!isBrowser()) return;
  const v = typeof token === 'string' ? token.trim() : '';
  if (v.length > 0) window.localStorage.setItem(REFRESH_TOKEN_KEY, v);
  else window.localStorage.removeItem(REFRESH_TOKEN_KEY);
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
  setRefreshToken(null);
  setTenantCode(null);
  setCachedMe(null);
}
