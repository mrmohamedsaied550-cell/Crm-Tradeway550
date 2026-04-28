/**
 * JWT payload shapes for the C9 auth API.
 *
 * Two token types are issued:
 *   - access  (short-lived; carries identity + tenant + role for guards)
 *   - refresh (long-lived; opaque to clients, kept stateful in user_sessions)
 *
 * Both share the standard registered claims (`sub`, `iat`, `exp`, `iss`, `jti`)
 * via the JwtService, but only the application claims are typed below.
 */

export type TokenType = 'access' | 'refresh';

export interface AccessTokenClaims {
  /** Token type discriminator. */
  typ: 'access';
  /** User id (uuid). */
  sub: string;
  /** Tenant id (uuid). */
  tid: string;
  /** Role id (uuid) — convenience cache; capabilities are looked up at request time. */
  rid: string;
}

export interface RefreshTokenClaims {
  typ: 'refresh';
  /** User id (uuid). */
  sub: string;
  /** Tenant id (uuid). */
  tid: string;
  /** Session id — the row this refresh token corresponds to in user_sessions. */
  sid: string;
}

export type AnyTokenClaims = AccessTokenClaims | RefreshTokenClaims;

/** Type guard helpful for narrowing in middleware/guards. */
export function isAccessClaims(claims: AnyTokenClaims): claims is AccessTokenClaims {
  return claims.typ === 'access';
}

export function isRefreshClaims(claims: AnyTokenClaims): claims is RefreshTokenClaims {
  return claims.typ === 'refresh';
}
