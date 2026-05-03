import { Global, Module } from '@nestjs/common';

import { AgentCapacitiesService } from './capacities.service';
import { DistributionController } from './distribution.controller';
import { DistributionService } from './distribution.service';
import { LeadRoutingLogService } from './routing-log.service';
import { DistributionRulesService } from './rules.service';

/**
 * Phase 1A — distribution engine module.
 *
 * `@Global` so LeadsService (CRM module) can inject DistributionService
 * without re-importing this module everywhere. The service surface
 * is small (one orchestrator + three repositories); keeping it
 * global mirrors NotificationsModule + RealtimeModule.
 *
 * Controllers (A7) live alongside the services — gated by
 * CapabilityGuard on `distribution.read` / `.write`. The
 * /leads/:id/routing-log route lives in the same controller for
 * locality (it queries the same LeadRoutingLogService).
 */
@Global()
@Module({
  controllers: [DistributionController],
  providers: [
    DistributionRulesService,
    AgentCapacitiesService,
    LeadRoutingLogService,
    DistributionService,
  ],
  exports: [
    DistributionRulesService,
    AgentCapacitiesService,
    LeadRoutingLogService,
    DistributionService,
  ],
})
export class DistributionModule {}
