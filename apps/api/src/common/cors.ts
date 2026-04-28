import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';

/**
 * Builds a CORS configuration from a comma-separated env allowlist.
 *
 * `*` is allowed as a development convenience but rejected when NODE_ENV is
 * `production` to prevent accidental wide-open deployments.
 */
export function buildCorsOptions(env: NodeJS.ProcessEnv): CorsOptions {
  const raw = env['CORS_ALLOWED_ORIGINS'] ?? '';
  const isProd = env['NODE_ENV'] === 'production';

  const list = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (list.includes('*')) {
    if (isProd) {
      throw new Error('CORS_ALLOWED_ORIGINS=* is not permitted in production.');
    }
    return {
      origin: true,
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Request-Id'],
      exposedHeaders: ['X-Request-Id'],
    };
  }

  return {
    origin: list.length > 0 ? list : false,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id'],
  };
}
