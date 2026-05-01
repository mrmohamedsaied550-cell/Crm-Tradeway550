import { Global, Module } from '@nestjs/common';
import { TenantContextMiddleware } from './tenant-context.middleware';
import { TenantsService } from './tenants.service';
import { TenantSettingsController } from './tenant-settings.controller';
import { TenantSettingsService } from './tenant-settings.service';

/**
 * Tenant module — exposes TenantsService and TenantContextMiddleware.
 * P2-08 added TenantSettingsService for the per-tenant runtime knobs
 * (timezone / slaMinutes / defaultDialCode) that other services
 * (SlaService, lead ingestion) read on every relevant operation.
 * Global so any controller can inject without re-importing.
 */
@Global()
@Module({
  controllers: [TenantSettingsController],
  providers: [TenantsService, TenantContextMiddleware, TenantSettingsService],
  exports: [TenantsService, TenantContextMiddleware, TenantSettingsService],
})
export class TenantsModule {}
