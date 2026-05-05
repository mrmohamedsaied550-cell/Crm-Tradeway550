import { Module } from '@nestjs/common';

import { RbacModule } from '../rbac/rbac.module';
import { TenantsModule } from '../tenants/tenants.module';
import { GoogleSheetsAdapter } from './adapters/google-sheets-adapter';
import { ManualUploadAdapter } from './adapters/manual-upload-adapter';
import { PartnerCredentialsCryptoService } from './partner-credentials-crypto.service';
import { PartnerMappingsController } from './partner-mappings.controller';
import { PartnerMappingsService } from './partner-mappings.service';
import { PartnerMergeService } from './partner-merge.service';
import { PartnerSnapshotsController } from './partner-snapshots.controller';
import { PartnerSnapshotsService } from './partner-snapshots.service';
import { PartnerSourcesController } from './partner-sources.controller';
import { PartnerSourcesService } from './partner-sources.service';
import { PartnerSyncSchedulerService } from './partner-sync.scheduler';
import { PartnerSyncService } from './partner-sync.service';
import { PartnerVerificationController } from './partner-verification.controller';
import { PartnerVerificationService } from './partner-verification.service';

/**
 * Phase D4 — D4.2 → D4.3: Partner Data Hub module.
 *
 * D4.2: configuration CRUD (sources + mappings) + credential
 * envelope.
 * D4.3: sync engine + Google Sheets adapter seam + manual upload
 * adapter + snapshot history endpoints + cron scheduler.
 *
 * Later D4.x chunks add:
 *   D4.4 — verification projection + lead-detail card
 *   D4.5 — controlled merge + evidence
 *   D4.6 — reconciliation reports
 *   D4.7 — milestones + commission CSV
 *
 * Imports `TenantsModule` so `TenantSettingsService` (used by
 * the sync engine for the tenant default dial code during phone
 * normalisation) is available without a circular dep.
 */
@Module({
  imports: [TenantsModule, RbacModule],
  controllers: [
    PartnerSourcesController,
    PartnerMappingsController,
    PartnerSnapshotsController,
    PartnerVerificationController,
  ],
  providers: [
    PartnerSourcesService,
    PartnerMappingsService,
    PartnerSnapshotsService,
    PartnerSyncService,
    PartnerSyncSchedulerService,
    PartnerVerificationService,
    PartnerMergeService,
    PartnerCredentialsCryptoService,
    GoogleSheetsAdapter,
    ManualUploadAdapter,
  ],
  exports: [
    PartnerSourcesService,
    PartnerMappingsService,
    PartnerSnapshotsService,
    PartnerSyncService,
    PartnerVerificationService,
    PartnerMergeService,
    PartnerCredentialsCryptoService,
  ],
})
export class PartnerModule {}
