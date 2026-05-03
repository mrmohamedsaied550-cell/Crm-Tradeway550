import { Module } from '@nestjs/common';

import { LeadImportController } from './lead-import.controller';
import { LeadIngestionService } from './lead-ingestion.service';
import { MetaLeadSourcesController } from './meta-lead-sources.controller';
import { MetaLeadSourcesService } from './meta-lead-sources.service';
import { MetaLeadgenController } from './meta-leadgen.controller';

/**
 * P2-06 — lead ingestion module.
 *
 * Two surfaces:
 *   - admin CSV import + Meta lead-source CRUD (auth-gated),
 *   - public Meta Lead Ads webhook (cross-tenant; uses
 *     `meta_lead_sources` for routing).
 *
 * A5.5 — auto-assign for ingested leads now goes through
 * LeadsService.autoAssign which delegates to DistributionService.
 * Source / company / country / team rules apply identically to
 * manually-created leads. Pre-A5.5, ingestion called
 * AssignmentService directly and bypassed rule consultation.
 *
 * Depends on the global CRM + Distribution + Tenants modules — all
 * provided tenant-wide via @Global() so no explicit imports here.
 */
@Module({
  controllers: [LeadImportController, MetaLeadSourcesController, MetaLeadgenController],
  providers: [LeadIngestionService, MetaLeadSourcesService],
  exports: [LeadIngestionService, MetaLeadSourcesService],
})
export class IngestionModule {}
