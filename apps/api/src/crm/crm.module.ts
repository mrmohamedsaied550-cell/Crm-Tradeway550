import { Global, Module } from '@nestjs/common';
import { LeadsController } from './leads.controller';
import { CaptainsController } from './captains.controller';
import { CaptainDocumentsController } from './captain-documents.controller';
import { LostReasonsController } from './lost-reasons.controller';
import { PipelinesController } from './pipelines.controller';
import { LeadsService } from './leads.service';
import { CaptainsService } from './captains.service';
import { CaptainDocumentsService } from './captain-documents.service';
import { CaptainTripsService } from './captain-trips.service';
import { LostReasonsService } from './lost-reasons.service';
import { PipelineService } from './pipeline.service';
import { PipelinesService } from './pipelines.service';
import { AssignmentService } from './assignment.service';
import { SlaService } from './sla.service';
import { SlaSchedulerService } from './sla.scheduler';
import { SlaThresholdsService } from './sla-thresholds.service';
import { LeadStageStatusService } from './lead-stage-status.service';
import { RotationService } from './rotation.service';
import { EscalationPolicyService } from './escalation-policy.service';
import { LeadReviewService } from './lead-review.service';
import { LeadReviewsController } from './lead-reviews.controller';

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
  controllers: [
    LeadsController,
    CaptainsController,
    CaptainDocumentsController,
    LostReasonsController,
    PipelinesController,
    LeadReviewsController,
  ],
  providers: [
    LeadsService,
    CaptainsService,
    CaptainDocumentsService,
    CaptainTripsService,
    LostReasonsService,
    PipelineService,
    PipelinesService,
    AssignmentService,
    SlaService,
    SlaSchedulerService,
    SlaThresholdsService,
    LeadStageStatusService,
    RotationService,
    EscalationPolicyService,
    LeadReviewService,
  ],
  exports: [
    LeadsService,
    CaptainsService,
    CaptainDocumentsService,
    CaptainTripsService,
    LostReasonsService,
    PipelineService,
    PipelinesService,
    AssignmentService,
    SlaService,
    SlaSchedulerService,
    SlaThresholdsService,
    LeadStageStatusService,
    RotationService,
    EscalationPolicyService,
    LeadReviewService,
  ],
})
export class CrmModule {}
