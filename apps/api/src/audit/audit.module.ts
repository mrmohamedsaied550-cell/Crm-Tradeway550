import { Global, Module } from '@nestjs/common';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';

/**
 * Made @Global so any service (Bonuses / Competitions / FollowUps /
 * future writers) can inject AuditService without boilerplate
 * re-exports through every parent module.
 */
@Global()
@Module({
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
