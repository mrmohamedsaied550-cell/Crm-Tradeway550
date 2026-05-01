import { Global, Module } from '@nestjs/common';
import { BonusesController } from './bonuses.controller';
import { BonusAccrualsController } from './bonus-accruals.controller';
import { BonusesService } from './bonuses.service';
import { BonusAccrualsService } from './bonus-accruals.service';
import { BonusEngine } from './bonus-engine.service';

/**
 * @Global so `BonusEngine` can be injected by `CaptainsService`
 * (CRM module) without circular re-exports.
 */
@Global()
@Module({
  controllers: [BonusesController, BonusAccrualsController],
  providers: [BonusesService, BonusAccrualsService, BonusEngine],
  exports: [BonusesService, BonusAccrualsService, BonusEngine],
})
export class BonusesModule {}
