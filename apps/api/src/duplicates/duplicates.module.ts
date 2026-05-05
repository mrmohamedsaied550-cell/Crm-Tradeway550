import { Global, Module } from '@nestjs/common';

import { LeadAttemptsService } from '../crm/lead-attempts.service';

import { DuplicateDecisionService } from './duplicate-decision.service';
import { DuplicateRulesService } from './duplicate-rules.service';

/**
 * Phase D2 — D2.2: duplicate / reactivation engine module.
 *
 * `@Global` so the existing CRM, WhatsApp, and Ingestion modules
 * (D2.3 wiring) can inject `DuplicateDecisionService` without
 * re-importing this module everywhere — mirrors DistributionModule
 * + NotificationsModule + RealtimeModule.
 *
 * `LeadAttemptsService` lives under `apps/api/src/crm/` (same dir
 * as `LeadsService`) but is registered here so the duplicates engine
 * owns its lifecycle. The CRM module re-exports it via this module's
 * global scope.
 *
 * No controllers in D2.2 — there's no HTTP surface yet. The
 * duplicate-rules CRUD lands in D2.4 alongside the admin tenant-
 * settings panel.
 */
@Global()
@Module({
  providers: [DuplicateRulesService, DuplicateDecisionService, LeadAttemptsService],
  exports: [DuplicateRulesService, DuplicateDecisionService, LeadAttemptsService],
})
export class DuplicatesModule {}
