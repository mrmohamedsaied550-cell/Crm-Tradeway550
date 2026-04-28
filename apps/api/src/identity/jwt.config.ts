/**
 * Read JWT-related configuration from environment.
 *
 * `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` are required in production. In
 * dev/test we fall back to placeholders so `pnpm dev` works out of the box.
 * The production deployment guide (Sprint 1 hardening) wires real secrets
 * via the deployment platform's secret manager.
 */

export interface JwtConfig {
  accessSecret: string;
  refreshSecret: string;
  /** Access token TTL (e.g. "60m"). Format accepted by jsonwebtoken. */
  accessTtl: string;
  /** Refresh token TTL (e.g. "30d"). */
  refreshTtl: string;
  issuer: string;
}

const DEFAULTS: JwtConfig = {
  // Long, deterministic placeholders so dev login works without manual env
  // setup. Production MUST override both via the deployment env.
  accessSecret: 'change-me-access',
  refreshSecret: 'change-me-refresh',
  accessTtl: '60m',
  refreshTtl: '30d',
  issuer: 'crm-tradeway',
};

export function buildJwtConfig(env: NodeJS.ProcessEnv = process.env): JwtConfig {
  return {
    accessSecret: env['JWT_ACCESS_SECRET'] ?? DEFAULTS.accessSecret,
    refreshSecret: env['JWT_REFRESH_SECRET'] ?? DEFAULTS.refreshSecret,
    accessTtl: env['JWT_ACCESS_TTL'] ?? DEFAULTS.accessTtl,
    refreshTtl: env['JWT_REFRESH_TTL'] ?? DEFAULTS.refreshTtl,
    issuer: env['JWT_ISSUER'] ?? DEFAULTS.issuer,
  };
}

/**
 * Convert a TTL string ("60m", "30d", "2h", "90s") into seconds.
 * Used when we need to compute a Date for the user_sessions.expires_at
 * column (the JWT itself encodes the expiry separately).
 */
export function ttlToSeconds(ttl: string): number {
  const m = /^(\d+)([smhd])$/.exec(ttl.trim());
  if (!m) throw new Error(`Invalid TTL: ${ttl}`);
  const n = Number.parseInt(m[1] ?? '', 10);
  switch (m[2]) {
    case 's':
      return n;
    case 'm':
      return n * 60;
    case 'h':
      return n * 3600;
    case 'd':
      return n * 86400;
    default:
      throw new Error(`Invalid TTL unit: ${ttl}`);
  }
}
