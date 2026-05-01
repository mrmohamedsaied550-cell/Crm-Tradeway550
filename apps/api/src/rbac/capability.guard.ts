import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { PrismaService } from '../prisma/prisma.service';
import type { AccessTokenClaims } from '../identity/jwt.types';

import { CAPABILITY_KEY } from './require-capability.decorator';
import type { CapabilityCode } from './capabilities.registry';

/**
 * P2-01 — capability gate. Used together with `JwtAuthGuard`:
 *
 *   @UseGuards(JwtAuthGuard, CapabilityGuard)
 *   @RequireCapability('lead.write')
 *   create(...)
 *
 * Reads the calling user's role and capability set from the database
 * (tenant-scoped via prisma.withTenant). For requests with no
 * @RequireCapability metadata the guard is a no-op so existing
 * routes that the JWT alone gates aren't affected.
 *
 * Caching: capabilities are attached to `req.user.capabilities` after
 * the first lookup so subsequent passes within the same request reuse
 * them. A future cross-request cache (Redis / in-memory LRU keyed by
 * roleId) is a clean drop-in here.
 */
@Injectable()
export class CapabilityGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<readonly CapabilityCode[] | undefined>(
      CAPABILITY_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (!required || required.length === 0) return true;

    const req = ctx
      .switchToHttp()
      .getRequest<Request & { user?: AccessTokenClaims & { capabilities?: readonly string[] } }>();
    const user = req.user;
    if (!user) {
      throw new UnauthorizedException({
        code: 'auth.missing_token',
        message: 'Missing authenticated user (JwtAuthGuard not applied?)',
      });
    }

    const have = await this.resolveCapabilities(user);
    const missing = required.filter((cap) => !have.includes(cap));
    if (missing.length > 0) {
      throw new ForbiddenException({
        code: 'auth.forbidden',
        message: `Missing capabilities: ${missing.join(', ')}`,
      });
    }
    return true;
  }

  private async resolveCapabilities(
    user: AccessTokenClaims & { capabilities?: readonly string[] },
  ): Promise<readonly string[]> {
    if (user.capabilities) return user.capabilities;
    const tenantId = user.tid;
    const roleId = user.rid;
    const role = await this.prisma.withTenant(tenantId, (tx) =>
      tx.role.findUnique({
        where: { id: roleId },
        include: {
          capabilities: { include: { capability: { select: { code: true } } } },
        },
      }),
    );
    const codes = role?.capabilities.map((rc) => rc.capability.code) ?? [];
    user.capabilities = codes;
    return codes;
  }
}
