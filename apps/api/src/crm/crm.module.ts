import { Global, Module } from '@nestjs/common';
import { LeadsController } from './leads.controller';
import { CaptainsController } from './captains.controller';
import { LeadExtensionsController } from './lead-extensions.controller';
import { LeadsService } from './leads.service';
import { CaptainsService } from './captains.service';
import { PipelineService } from './pipeline.service';
import { AssignmentService } from './assignment.service';
import { SlaService } from './sla.service';
import { SlaSchedulerService } from './sla.scheduler';
import { LeadExtensionsService } from './lead-extensions.service';

/**
 * CRM Core module (C10 + C11 + C18 + C29 + C30).
 *
 * C11 added round-robin AssignmentService and the response-SLA
 * SlaService. C18 added the read-only CaptainsController used by the
 * captain admin screens. C29 added the SlaSchedulerService which
 * triggers the breach scan via @nestjs/schedule. C30 adds lead
 * statuses, documents, follow-ups, advanced filtering, and WhatsApp
 * conversation lookup via LeadExtensionsService.
 */
@Global()
@Module({
  controllers: [LeadsController, CaptainsController, LeadExtensionsController],
  providers: [
    LeadsService,
    CaptainsService,
    PipelineService,
    AssignmentService,
    SlaService,
    SlaSchedulerService,
    LeadExtensionsService,
  ],
  exports: [
    LeadsService,
    CaptainsService,
    PipelineService,
    AssignmentService,
    SlaService,
    SlaSchedulerService,
    LeadExtensionsService,
  ],
})
export class CrmModule {}
