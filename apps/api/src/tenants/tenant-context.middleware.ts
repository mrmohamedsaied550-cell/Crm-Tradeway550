import { BadRequestException, Injectable, Logger, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { tenantContext } from './tenant-context';
import { TenantsService } from './tenants.service';

const HEADER_NAME = 'x-tenant';

/**
 * Resolves a tenant for the current request and stores it in AsyncLocalStorage.
 *
 * MVP path: the dev-only `X-Tenant: <code>` header. Once C9 wires JWT, the
 * middleware will instead read `tenantId` from the verified token claim and
 * treat the header as ignored (or admin-only). The downstream consumers
 * (PrismaService.withTenant, future scope guards) only see the resolved
 * context — they do not care which source produced it.
 *
 * Requests without the header pass through unscoped — the store is empty.
 * That covers /health and any cross-tenant lookups (e.g. login).
 */
@Injectable()
export class TenantContextMiddleware implements NestMiddleware {
  private readonly logger = new Logger(TenantContextMiddleware.name);

  constructor(private readonly tenants: TenantsService) {}

  async use(req: Request, _res: Response, next: NextFunction): Promise<void> {
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
}
