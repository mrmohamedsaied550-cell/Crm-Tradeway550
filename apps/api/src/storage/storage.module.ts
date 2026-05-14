import { Global, Module } from '@nestjs/common';

import { StorageService } from './storage.service';

/**
 * Sprint 16 (D16) — global storage module.
 *
 * Exposes a single `StorageService` so any module that needs to read or
 * write a private file (Lead documents today; potentially more in
 * future sprints) injects the service rather than picking a provider
 * itself. Marked `@Global` so the CrmModule and any future module
 * don't have to re-import here.
 */
@Global()
@Module({
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
