import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../identity/jwt-auth.guard';
import { CapabilityGuard } from '../rbac/capability.guard';
import { RequireCapability } from '../rbac/require-capability.decorator';

import { BackupService, type TenantBackup } from './backup.service';

/**
 * P3-07 — operator-only tenant export.
 *
 * `GET /admin/backup/export` returns a JSON snapshot of the active
 * tenant's CRM rows (sensitive fields stripped — see BackupService).
 * The route sets a Content-Disposition header so browsers save the
 * response as a file; the filename includes the tenant code + date
 * for easy archival.
 */
@ApiTags('backup')
@Controller('admin/backup')
@UseGuards(JwtAuthGuard, CapabilityGuard)
export class BackupController {
  constructor(private readonly backup: BackupService) {}

  @Get('export')
  @RequireCapability('tenant.export')
  @ApiOperation({ summary: 'Export the active tenant as a JSON snapshot' })
  @Header('Cache-Control', 'no-store')
  async export(): Promise<TenantBackup> {
    return this.backup.exportTenant();
    // Content-Disposition is set on the web side via fetch + Blob so
    // the route stays stateless; an `Accept: application/json` consumer
    // gets the JSON straight back.
  }
}
