import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash } from 'node:crypto';
import { buildJwtConfig, ttlToSeconds, type JwtConfig } from './jwt.config';
import { type AccessTokenClaims, type AnyTokenClaims, type RefreshTokenClaims } from './jwt.types';

/**
 * Sign + verify access and refresh tokens.
 *
 * The two token types use *different secrets* so a leaked access secret
 * cannot be used to forge refresh tokens (and vice versa). Each verify
 * also asserts the `typ` claim matches the expected type.
 */
@Injectable()
export class TokensService {
  private readonly cfg: JwtConfig;

  constructor(private readonly jwt: JwtService) {
    this.cfg = buildJwtConfig();
  }

  signAccess(claims: Omit<AccessTokenClaims, 'typ'>): string {
    return this.jwt.sign({ typ: 'access', ...claims } satisfies AccessTokenClaims, {
      secret: this.cfg.accessSecret,
      expiresIn: this.cfg.accessTtl,
      issuer: this.cfg.issuer,
      // `sub` is set by the standard claim, but we already include it in the
      // payload; jsonwebtoken hoists it to the registered slot for free.
    });
  }

  signRefresh(claims: Omit<RefreshTokenClaims, 'typ'>): string {
    return this.jwt.sign({ typ: 'refresh', ...claims } satisfies RefreshTokenClaims, {
      secret: this.cfg.refreshSecret,
      expiresIn: this.cfg.refreshTtl,
      issuer: this.cfg.issuer,
    });
  }

  /**
   * Verify an access token. Throws if the signature is invalid, the token
   * is expired, or the `typ` claim is wrong (e.g. a refresh token sent to
   * an access endpoint).
   */
  verifyAccess(token: string): AccessTokenClaims {
    const claims = this.verify(token, this.cfg.accessSecret);
    if (claims.typ !== 'access') {
      throw new Error('Token type mismatch: expected access');
    }
    return claims;
  }

  verifyRefresh(token: string): RefreshTokenClaims {
    const claims = this.verify(token, this.cfg.refreshSecret);
    if (claims.typ !== 'refresh') {
      throw new Error('Token type mismatch: expected refresh');
    }
    return claims;
  }

  private verify(token: string, secret: string): AnyTokenClaims {
    return this.jwt.verify(token, { secret, issuer: this.cfg.issuer }) as AnyTokenClaims;
  }

  /**
   * SHA-256 of a string. Used to hash refresh JWTs before storage —
   * the raw token never lives in the DB.
   */
  hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  /** Expose the configured refresh TTL in seconds for `expires_at` math. */
  refreshTtlSeconds(): number {
    return ttlToSeconds(this.cfg.refreshTtl);
  }
}
