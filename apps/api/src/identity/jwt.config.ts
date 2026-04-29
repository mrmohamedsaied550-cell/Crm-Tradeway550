/**
 * Read JWT-related configuration from environment.
 *
 * `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` are required in production. In
 * dev/test we fall back to placeholders so `pnpm dev` works out of the box.
 *
 * C27 — when `NODE_ENV=production`, `buildJwtConfig` refuses to return
 * a config whose secret is missing or still equals the dev placeholder.
 * That makes a misconfigured deploy fail loudly at boot rather than
 * silently issue forgeable tokens.
 */

import { isProduction } from '../common/env';

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

const DEV_DEFAULT_SECRETS: ReadonlySet<string> = new Set([
  DEFAULTS.accessSecret,
  DEFAULTS.refreshSecret,
]);

export class JwtConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JwtConfigError';
  }
}

export function buildJwtConfig(env: NodeJS.ProcessEnv = process.env): JwtConfig {
  const cfg: JwtConfig = {
    accessSecret: env['JWT_ACCESS_SECRET'] ?? DEFAULTS.accessSecret,
    refreshSecret: env['JWT_REFRESH_SECRET'] ?? DEFAULTS.refreshSecret,
    accessTtl: env['JWT_ACCESS_TTL'] ?? DEFAULTS.accessTtl,
    refreshTtl: env['JWT_REFRESH_TTL'] ?? DEFAULTS.refreshTtl,
    issuer: env['JWT_ISSUER'] ?? DEFAULTS.issuer,
  };
  if (isProduction(env)) {
    assertProductionSecret('JWT_ACCESS_SECRET', cfg.accessSecret);
    assertProductionSecret('JWT_REFRESH_SECRET', cfg.refreshSecret);
    if (cfg.accessSecret === cfg.refreshSecret) {
      throw new JwtConfigError(
        'JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must differ in production',
      );
    }
  }
  return cfg;
}

function assertProductionSecret(name: string, value: string): void {
  // Placeholder check first so the operator gets a clearer message
  // ("you forgot to set $name") than the generic length error.
  if (DEV_DEFAULT_SECRETS.has(value)) {
    throw new JwtConfigError(
      `${name} is still set to the development placeholder; refusing to boot in production`,
    );
  }
  if (!value || value.length < 32) {
    throw new JwtConfigError(`${name} must be set to a strong (>=32 char) secret in production`);
  }
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
