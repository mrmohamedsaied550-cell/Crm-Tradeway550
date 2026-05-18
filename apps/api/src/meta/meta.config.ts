/**
 * Sprint M2 — env-derived configuration for the Meta Lead Ads OAuth
 * integration. Read on first access and cached for the lifetime of
 * the process; tests can reset via `__resetMetaConfigForTesting`.
 *
 * Resolution order for each variable mirrors the rest of the API:
 * direct `process.env` access, no nested ConfigService indirection.
 *
 *   META_APP_ID              — Facebook app id (numeric string).
 *   META_APP_SECRET          — app secret; used for the code → token
 *                              exchange AND as the global HMAC fallback
 *                              when a MetaLeadSource row has no
 *                              per-source `app_secret` configured.
 *   META_REDIRECT_URI        — absolute URL of the /api/v1/meta/auth/
 *                              callback route as registered with Meta.
 *   META_GRAPH_API_VERSION   — Graph API version (default `v21.0`).
 *   META_OAUTH_STATE_SECRET  — HMAC secret for the `state` parameter
 *                              we sign at /initiate; defaults to
 *                              META_APP_SECRET when unset.
 *
 * In production all four required values (state secret falls back to
 * app secret) must be present, otherwise the first /initiate call
 * throws on boot of the auth flow. In dev/test, empty values are
 * tolerated so a checkout-and-run developer doesn't need the live app
 * credentials just to typecheck or run unrelated tests.
 */

import { isProduction } from '../common/env';

export interface MetaConfig {
  appId: string;
  appSecret: string;
  redirectUri: string;
  graphApiVersion: string;
  stateSecret: string;
}

let cached: MetaConfig | null = null;

export function getMetaConfig(env: NodeJS.ProcessEnv = process.env): MetaConfig {
  if (cached) return cached;

  const appId = env['META_APP_ID'] ?? '';
  const appSecret = env['META_APP_SECRET'] ?? '';
  const redirectUri = env['META_REDIRECT_URI'] ?? '';
  const graphApiVersion = env['META_GRAPH_API_VERSION'] ?? 'v21.0';
  const stateSecret = env['META_OAUTH_STATE_SECRET'] ?? appSecret;

  if (isProduction(env)) {
    if (appId.length === 0) throw new Error('META_APP_ID is required in production');
    if (appSecret.length === 0) throw new Error('META_APP_SECRET is required in production');
    if (redirectUri.length === 0) throw new Error('META_REDIRECT_URI is required in production');
    if (stateSecret.length === 0) {
      throw new Error('META_OAUTH_STATE_SECRET (or META_APP_SECRET) is required in production');
    }
  }

  cached = { appId, appSecret, redirectUri, graphApiVersion, stateSecret };
  return cached;
}

/** Test-only — clear the cached config so tests can swap envs. */
export function __resetMetaConfigForTesting(): void {
  cached = null;
}
