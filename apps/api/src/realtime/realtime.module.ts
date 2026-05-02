import { Global, Module } from '@nestjs/common';

import { RealtimeController } from './realtime.controller';
import { RealtimeService } from './realtime.service';

/**
 * P3-02 — global so any service (notifications, whatsapp, leads,
 * sla) can inject `RealtimeService` to push events without a
 * round-trip through the database.
 */
@Global()
@Module({
  controllers: [RealtimeController],
  providers: [RealtimeService],
  exports: [RealtimeService],
})
export class RealtimeModule {}
