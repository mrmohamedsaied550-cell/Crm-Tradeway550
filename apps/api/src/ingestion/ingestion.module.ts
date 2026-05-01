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
 * Depends on the global CRM module (PipelineService, AssignmentService,
 * SlaService) and the global PrismaService — both already provided
 * tenant-wide via @Global() modules.
 */
@Module({
  controllers: [LeadImportController, MetaLeadSourcesController, MetaLeadgenController],
  providers: [LeadIngestionService, MetaLeadSourcesService],
  exports: [LeadIngestionService, MetaLeadSourcesService],
})
export class IngestionModule {}
