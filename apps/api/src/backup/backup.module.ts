import { Module } from '@nestjs/common';

import { BackupController } from './backup.controller';
import { BackupService } from './backup.service';

/**
 * P3-07 — tenant export.
 */
@Module({
  controllers: [BackupController],
  providers: [BackupService],
})
export class BackupModule {}
