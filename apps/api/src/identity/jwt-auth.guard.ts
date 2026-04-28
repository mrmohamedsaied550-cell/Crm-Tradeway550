import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { TokensService } from './tokens.service';
import type { AccessTokenClaims } from './jwt.types';

/**
 * JwtAuthGuard — verifies an access token from the `Authorization: Bearer ...`
 * header and attaches the parsed claims to `request.user`.
 *
 * The guard is defined here in C9 but only applied to /auth/me + /auth/logout
 * for now. Broad application across business endpoints lands when those
 * endpoints exist (C12 onward).
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly tokens: TokensService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request & { user?: AccessTokenClaims }>();
    const header = req.header('authorization') ?? '';
    const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
    if (!m) {
      throw new UnauthorizedException({
        code: 'auth.missing_token',
        message: 'Missing or malformed Authorization header',
      });
    }
    try {
      const claims = this.tokens.verifyAccess(m[1] ?? '');
      req.user = claims;
      return true;
    } catch {
      throw new UnauthorizedException({
        code: 'auth.invalid_token',
        message: 'Invalid or expired access token',
      });
    }
  }
}
