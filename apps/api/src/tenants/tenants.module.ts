import { Global, Module } from '@nestjs/common';
import { TenantContextMiddleware } from './tenant-context.middleware';
import { TenantsService } from './tenants.service';

/**
 * Tenant module — exposes TenantsService and TenantContextMiddleware.
 * Global so any controller can inject TenantsService without re-importing.
 */
@Global()
@Module({
  providers: [TenantsService, TenantContextMiddleware],
  exports: [TenantsService, TenantContextMiddleware],
})
export class TenantsModule {}
