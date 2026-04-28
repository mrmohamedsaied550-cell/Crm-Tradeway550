import { Global, Module } from '@nestjs/common';
import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';
import { CaptainsService } from './captains.service';
import { PipelineService } from './pipeline.service';
import { AssignmentService } from './assignment.service';
import { SlaService } from './sla.service';

/**
 * CRM Core module (C10 + C11).
 *
 * C11 added round-robin AssignmentService and the response-SLA
 * SlaService — both exported so the breach-scanner endpoint and any
 * future cron worker can pull them in without redeclaration.
 */
@Global()
@Module({
  controllers: [LeadsController],
  providers: [LeadsService, CaptainsService, PipelineService, AssignmentService, SlaService],
  exports: [LeadsService, CaptainsService, PipelineService, AssignmentService, SlaService],
})
export class CrmModule {}
