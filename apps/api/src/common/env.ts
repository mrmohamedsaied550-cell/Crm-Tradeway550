/**
 * Single source of truth for "are we running in production".
 *
 * Used by the boot-time security gates (JWT secret validation, helmet),
 * the request-time middleware (X-Tenant header is dev/test only), the
 * webhook controller (HMAC must be enforced), and the accounts service
 * (an account cannot be enabled without an appSecret in production).
 *
 * The function takes an explicit env so tests can exercise both branches
 * without mutating process.env.
 */
export function isProduction(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['NODE_ENV'] === 'production';
}
