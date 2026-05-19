/**
 * Sprint M2 — sign + verify the OAuth `state` parameter.
 *
 * Wire format: `<base64url(payload)>.<base64url(hmac-sha256)>`
 *
 * The payload carries the tenant id (so the unauthenticated callback
 * route can look up the right tenant), an optional `returnTo` URL the
 * controller redirects to on success, and an `exp` unix timestamp.
 * HMAC is verified before JSON parse to avoid leaking parser
 * behaviour to forged inputs; timing-safe equality is mandatory.
 *
 * Default TTL is 10 minutes, which is long enough for a normal
 * consent screen + maybe-2FA bounce but short enough that a stolen
 * link is not reusable.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

const STATE_TTL_SECONDS = 10 * 60;

export interface OAuthStatePayload {
  tenantId: string;
  returnTo?: string;
  /** Unix seconds. */
  exp: number;
}

export function signOAuthState(
  payload: { tenantId: string; returnTo?: string },
  secret: string,
  now: number = Math.floor(Date.now() / 1000),
): string {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error('signOAuthState: secret is required');
  }
  const full: OAuthStatePayload = {
    tenantId: payload.tenantId,
    ...(payload.returnTo !== undefined && { returnTo: payload.returnTo }),
    exp: now + STATE_TTL_SECONDS,
  };
  const body = b64urlEncode(Buffer.from(JSON.stringify(full), 'utf8'));
  const sig = b64urlEncode(createHmac('sha256', secret).update(body).digest());
  return `${body}.${sig}`;
}

export function verifyOAuthState(
  state: string,
  secret: string,
  now: number = Math.floor(Date.now() / 1000),
): OAuthStatePayload {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error('verifyOAuthState: secret is required');
  }
  if (typeof state !== 'string') {
    throw new InvalidStateError('meta.oauth.invalid_state');
  }
  const dotIdx = state.indexOf('.');
  if (dotIdx <= 0 || dotIdx === state.length - 1) {
    throw new InvalidStateError('meta.oauth.invalid_state');
  }
  const body = state.slice(0, dotIdx);
  const presentedSig = state.slice(dotIdx + 1);

  const expected = createHmac('sha256', secret).update(body).digest();
  let presented: Buffer;
  try {
    presented = b64urlDecode(presentedSig);
  } catch {
    throw new InvalidStateError('meta.oauth.invalid_state');
  }
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    throw new InvalidStateError('meta.oauth.invalid_state');
  }

  let parsed: OAuthStatePayload;
  try {
    parsed = JSON.parse(b64urlDecode(body).toString('utf8')) as OAuthStatePayload;
  } catch {
    throw new InvalidStateError('meta.oauth.invalid_state');
  }
  if (typeof parsed.tenantId !== 'string' || parsed.tenantId.length === 0) {
    throw new InvalidStateError('meta.oauth.invalid_state');
  }
  if (typeof parsed.exp !== 'number' || parsed.exp < now) {
    throw new InvalidStateError('meta.oauth.expired_state');
  }
  return parsed;
}

export class InvalidStateError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'InvalidStateError';
  }
}

// ─── base64url helpers ─────────────────────────────────────────────

function b64urlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Buffer {
  const std = s.replace(/-/g, '+').replace(/_/g, '/');
  const padded = std + '='.repeat((4 - (std.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
}
