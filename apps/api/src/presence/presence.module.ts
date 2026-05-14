import { Global, Module } from '@nestjs/common';
import { PresenceController } from './presence.controller';
import { PresenceService } from './presence.service';

/**
 * Sprint 10 (D10) — @Global so any service (Sla / Distribution /
 * future writers) can inject PresenceService without re-exports.
 * Production wiring is global by design — presence is a
 * tenant-wide signal, not a per-module concern.
 */
@Global()
@Module({
  controllers: [PresenceController],
  providers: [PresenceService],
  exports: [PresenceService],
})
export class PresenceModule {}
