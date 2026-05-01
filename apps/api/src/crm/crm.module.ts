import { Global, Module } from '@nestjs/common';
import { LeadsController } from './leads.controller';
import { CaptainsController } from './captains.controller';
import { PipelinesController } from './pipelines.controller';
import { LeadsService } from './leads.service';
import { CaptainsService } from './captains.service';
import { PipelineService } from './pipeline.service';
import { PipelinesService } from './pipelines.service';
import { AssignmentService } from './assignment.service';
import { SlaService } from './sla.service';
import { SlaSchedulerService } from './sla.scheduler';

/**
 * CRM Core module (C10 + C11 + C18 + C29 + P2-07).
 *
 * P2-07 added PipelinesService (admin CRUD over the new Pipeline
 * entity + its stages) and PipelinesController. The original
 * read-only PipelineService stays — Lead lifecycle code still
 * resolves stage codes through it against the tenant-default
 * pipeline.
 */
@Global()
@Module({
  controllers: [LeadsController, CaptainsController, PipelinesController],
  providers: [
    LeadsService,
    CaptainsService,
    PipelineService,
    PipelinesService,
    AssignmentService,
    SlaService,
    SlaSchedulerService,
  ],
  exports: [
    LeadsService,
    CaptainsService,
    PipelineService,
    PipelinesService,
    AssignmentService,
    SlaService,
    SlaSchedulerService,
  ],
})
export class CrmModule {}
