import { Module } from '@nestjs/common';

import { PartnerCredentialsCryptoService } from './partner-credentials-crypto.service';
import { PartnerMappingsController } from './partner-mappings.controller';
import { PartnerMappingsService } from './partner-mappings.service';
import { PartnerSourcesController } from './partner-sources.controller';
import { PartnerSourcesService } from './partner-sources.service';

/**
 * Phase D4 — D4.2: Partner Data Hub module.
 *
 * Configuration only. No sync engine, no Google Sheets adapter, no
 * scheduler tick. Later D4.x chunks add:
 *   D4.3 — sync engine + adapters + scheduler
 *   D4.4 — verification projection + lead-detail card
 *   D4.5 — controlled merge + evidence
 *   D4.6 — reconciliation reports
 *   D4.7 — milestones + commission CSV
 *
 * The module is plain (not @Global) — services are imported by
 * later modules explicitly so the dependency graph stays
 * inspectable.
 */
@Module({
  controllers: [PartnerSourcesController, PartnerMappingsController],
  providers: [PartnerSourcesService, PartnerMappingsService, PartnerCredentialsCryptoService],
  exports: [PartnerSourcesService, PartnerMappingsService, PartnerCredentialsCryptoService],
})
export class PartnerModule {}
