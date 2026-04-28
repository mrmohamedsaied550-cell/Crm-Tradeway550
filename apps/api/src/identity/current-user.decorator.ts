import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { AccessTokenClaims } from './jwt.types';

/**
 * @CurrentUser() — pulls the access-token claims attached by JwtAuthGuard
 * out of `request.user`. Throws if used without the guard (defensive: the
 * decorator must compose with the guard, never replace it).
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AccessTokenClaims => {
    const req = ctx.switchToHttp().getRequest<Request & { user?: AccessTokenClaims }>();
    if (!req.user) {
      throw new Error('@CurrentUser used without JwtAuthGuard on the route');
    }
    return req.user;
  },
);
