import { Global, Module } from '@nestjs/common';
import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';
import { CaptainsService } from './captains.service';
import { PipelineService } from './pipeline.service';

/**
 * CRM Core module (C10).
 *
 * Exports services so future modules (assignment engine, SLA timers,
 * dashboards) can compose without re-importing. Made @Global to mirror
 * the convention from C6–C9 — the rest of the app depends on these
 * services and importing them once is the cheapest path.
 */
@Global()
@Module({
  controllers: [LeadsController],
  providers: [LeadsService, CaptainsService, PipelineService],
  exports: [LeadsService, CaptainsService, PipelineService],
})
export class CrmModule {}
