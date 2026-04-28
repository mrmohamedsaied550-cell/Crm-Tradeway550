/**
 * Response-SLA configuration.
 *
 * Reads `LEAD_SLA_MINUTES` from the environment and clamps it into a
 * sensible range. Defaults to 15 minutes per the C11 spec. A future
 * Sprint 2 chunk replaces this with per-tenant config rows.
 */

const DEFAULT_MINUTES = 15;
const MIN_MINUTES = 1;
const MAX_MINUTES = 24 * 60; // 1 day

export function getSlaMinutes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['LEAD_SLA_MINUTES'];
  if (!raw) return DEFAULT_MINUTES;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) return DEFAULT_MINUTES;
  if (n < MIN_MINUTES) return MIN_MINUTES;
  if (n > MAX_MINUTES) return MAX_MINUTES;
  return n;
}

export function getSlaWindowMs(env: NodeJS.ProcessEnv = process.env): number {
  return getSlaMinutes(env) * 60 * 1000;
}
