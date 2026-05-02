import { Global, Module } from '@nestjs/common';

import { AgentCapacitiesService } from './capacities.service';
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
 * Controllers land in A7. Until then this module is service-only —
 * no HTTP surface change for clients.
 */
@Global()
@Module({
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
