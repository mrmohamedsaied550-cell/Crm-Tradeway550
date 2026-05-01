/**
 * Backend API base URL.
 *
 * Lives behind `NEXT_PUBLIC_API_BASE_URL` so the same web bundle can point
 * at a local Nest server (default :3000) in dev and at any environment in
 * production. The `NEXT_PUBLIC_` prefix exposes the value to client code.
 *
 * When the env var is unset and we're running in the browser, fall back to
 * `window.location.origin` so the app works behind a single-origin reverse
 * proxy (where /api/* and / are served from the same host).
 */
export function getApiBaseUrl(): string {
  const fromEnv = process.env['NEXT_PUBLIC_API_BASE_URL'];
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  if (typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin;
  }
  return 'http://localhost:3000';
}

// Kept for backwards compatibility with existing `import { API_BASE_URL }`
// usages. Note: this is the value at *module load* time on the server; on
// the client, prefer `getApiBaseUrl()` for per-request resolution.
export const API_BASE_URL: string = getApiBaseUrl();

export const API_VERSION_PREFIX = '/api/v1';
