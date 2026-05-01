/**
 * Backend API base URL.
 *
 * Lives behind `NEXT_PUBLIC_API_BASE_URL` so the same web bundle can point
 * at a local Nest server (default :3000) in dev and at any environment in
 * production. The `NEXT_PUBLIC_` prefix exposes the value to client code.
 *
 * `NEXT_PUBLIC_API_URL` is honoured as a legacy alias (older `.env.example`
 * shipped with that name). Prefer `NEXT_PUBLIC_API_BASE_URL` going forward.
 */
export const API_BASE_URL: string =
  process.env['NEXT_PUBLIC_API_BASE_URL'] ??
  process.env['NEXT_PUBLIC_API_URL'] ??
  'http://localhost:3000';

export const API_VERSION_PREFIX = '/api/v1';
