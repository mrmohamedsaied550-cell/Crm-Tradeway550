import { BadRequestException, Injectable, Logger, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { isProduction } from '../common/env';
import { tenantContext } from './tenant-context';
import { TenantsService } from './tenants.service';
import { TokensService } from '../identity/tokens.service';

const HEADER_NAME = 'x-tenant';

/**
 * Resolves a tenant for the current request and stores it in AsyncLocalStorage.
 *
 * Resolution order:
 *   1. Verified JWT access-token claim `tid` (the production path from C9
 *      onward).
 *   2. Dev-only `X-Tenant: <code>` header (kept for unauth flows + admin
 *      debug). The header is *ignored* whenever a valid JWT is present so
 *      a client cannot upgrade their privileges by passing a different
 *      tenant code than their token's claim. C27 — the header path is
 *      additionally gated off entirely when `NODE_ENV=production`, so
 *      the dev convenience cannot leak into a deployed environment.
 *
 * Requests without either pass through unscoped — the store is empty.
 * That covers /health, /auth/login, and the root /.
 */
@Injectable()
export class TenantContextMiddleware implements NestMiddleware {
  private readonly logger = new Logger(TenantContextMiddleware.name);

  constructor(
    private readonly tenants: TenantsService,
    private readonly tokens: TokensService,
  ) {}

  async use(req: Request, _res: Response, next: NextFunction): Promise<void> {
    // 1. JWT path — preferred when present.
    const jwtTenantId = this.tryResolveFromJwt(req);
    if (jwtTenantId) {
      const tenant = await this.tenants.findById(jwtTenantId);
      if (tenant && tenant.isActive) {
        tenantContext.run({ tenantId: tenant.id, tenantCode: tenant.code, source: 'jwt' }, () =>
          next(),
        );
        return;
      }
      // JWT carried a stale/invalid tenant id — fall through to header path,
      // but only because that's the dev-friendly behavior. Production deploys
      // should never see this branch since JWTs are short-lived.
    }

    // 2. Dev header path. Disabled in production — verified JWT is the
    // only accepted source of tenant scope when deployed.
    if (isProduction()) {
      return next();
    }
    const raw = req.header(HEADER_NAME);
    const code = typeof raw === 'string' ? raw.trim() : '';
    if (!code) {
      return next();
    }

    const tenant = await this.tenants.findByCode(code);
    if (!tenant) {
      throw new BadRequestException({
        code: 'tenant.not_found',
        message: `Tenant not found: ${code}`,
      });
    }
    if (!tenant.isActive) {
      throw new BadRequestException({
        code: 'tenant.disabled',
        message: `Tenant disabled: ${code}`,
      });
    }

    this.logger.debug?.(`tenant=${tenant.code}`);
    tenantContext.run({ tenantId: tenant.id, tenantCode: tenant.code, source: 'header' }, () =>
      next(),
    );
  }

  private tryResolveFromJwt(req: Request): string | null {
    const header = req.header('authorization') ?? '';
    const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
    if (!m) return null;
    try {
      const claims = this.tokens.verifyAccess(m[1] ?? '');
      return claims.tid;
    } catch {
      // Invalid token — let the route guards reject it. This middleware
      // does not authenticate, only resolves tenant scope.
      return null;
    }
  }
}
