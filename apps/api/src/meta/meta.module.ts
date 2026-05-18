/**
 * Sprint M2 — Meta Lead Ads integration module.
 *
 * Wires:
 *   - `MetaOAuthController` (OAuth initiate + callback routes)
 *   - `MetaOAuthService`   (token exchange, encrypt-and-persist)
 *   - `MetaGraphService`   (Graph API client used by the webhook
 *                           ingest path + future admin "test connection"
 *                           and "pick a page/form" surfaces)
 *
 * Both services are exported so the existing ingestion module (which
 * owns `/webhooks/meta/leadgen`) can inject `MetaGraphService` to do
 * the per-event lead-data fetch and attribution lookup.
 *
 * `PrismaModule` is `@Global()` at the app level, so no explicit
 * import is needed here — matches the pattern used by the other
 * domain modules.
 */

import { Module } from '@nestjs/common';

import { MetaGraphService } from './meta-graph.service';
import { MetaOAuthController } from './meta-oauth.controller';
import { MetaOAuthService } from './meta-oauth.service';

@Module({
  controllers: [MetaOAuthController],
  providers: [MetaOAuthService, MetaGraphService],
  exports: [MetaOAuthService, MetaGraphService],
})
export class MetaModule {}
