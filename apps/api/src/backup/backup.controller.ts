import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../identity/jwt-auth.guard';
import { CapabilityGuard } from '../rbac/capability.guard';
import { ExportGate } from '../rbac/export-gate.decorator';
import { RequireCapability } from '../rbac/require-capability.decorator';
import type { StructuredTenantBackup } from '../rbac/export-contract';

import { BackupService, BACKUP_INHERIT_RESOURCES } from './backup.service';

/**
 * P3-07 — operator-only tenant export.
 *
 * `GET /admin/backup/export` returns a JSON snapshot of the active
 * tenant's CRM rows (sensitive fields stripped — see BackupService).
 *
 * Phase D5 — D5.6D-1: tenant backup governance foundation.
 *
 *   The endpoint now passes through the D5 export pipeline. The
 *   service builds a `StructuredTenantBackup` (one
 *   `StructuredExport` per backup table); the export interceptor
 *   serialises it to the legacy `TenantBackup` JSON wire shape so
 *   `scripts/restore.sh` continues to round-trip without alteration.
 *   Audit metadata (table names, per-table row counts) lands in the
 *   `tenant.export.completed` audit row when D5 is on.
 *
 *   D5.6D-1 ships the structured shape + catalogue coverage. Real
 *   redaction semantics + the
 *   `E_BACKUP_REDACTED_NOT_RESTORABLE` guard land in D5.6D-2 — no
 *   role deny rule strips a column from the backup in D5.6D-1.
 *
 *   Capability stays `tenant.export`. The capability is intentionally
 *   not split into a more granular set because the backup ships a
 *   single restore-compatible artefact: any per-resource granularity
 *   would either produce restorable-with-holes files (a DR
 *   anti-pattern) or duplicate the existing `*.export` caps without
 *   adding governance value. The granularity D5.6D-2 surfaces is
 *   field-level via the catalogue — which is the right surface for
 *   role-builder-driven control.
 */
@ApiTags('backup')
@Controller('admin/backup')
@UseGuards(JwtAuthGuard, CapabilityGuard)
export class BackupController {
  constructor(private readonly backup: BackupService) {}

  @Get('export')
  @RequireCapability('tenant.export')
  @ExportGate({
    primary: 'tenant',
    inherits: BACKUP_INHERIT_RESOURCES,
    format: 'json-tenant-backup',
    filename: () => `tenant-backup-${new Date().toISOString().slice(0, 10)}.json`,
  })
  @ApiOperation({
    summary: 'Export the active tenant as a JSON snapshot (governed, restore-compatible)',
  })
  async export(): Promise<StructuredTenantBackup> {
    return this.backup.exportTenant();
  }
}
