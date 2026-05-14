import { Global, Module } from '@nestjs/common';
import { TenantBrandingService } from './branding.service';
import { TenantContextMiddleware } from './tenant-context.middleware';
import { TenantsService } from './tenants.service';
import { TenantSettingsController } from './tenant-settings.controller';
import { TenantSettingsService } from './tenant-settings.service';

/**
 * Tenant module — exposes TenantsService and TenantContextMiddleware.
 * P2-08 added TenantSettingsService for the per-tenant runtime knobs
 * (timezone / slaMinutes / defaultDialCode) that other services
 * (SlaService, lead ingestion) read on every relevant operation.
 * Sprint 15 (D15) added TenantBrandingService alongside it; both write
 * to the same `tenant_settings` row but each exposes a distinct
 * read/write surface.
 * Global so any controller can inject without re-importing.
 */
@Global()
@Module({
  controllers: [TenantSettingsController],
  providers: [
    TenantsService,
    TenantContextMiddleware,
    TenantSettingsService,
    TenantBrandingService,
  ],
  exports: [TenantsService, TenantContextMiddleware, TenantSettingsService, TenantBrandingService],
})
export class TenantsModule {}
