import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../identity/jwt-auth.guard';
import { CapabilityGuard } from '../rbac/capability.guard';
import { RequireCapability } from '../rbac/require-capability.decorator';
import { AuditService } from './audit.service';

@ApiTags('audit')
@Controller('audit')
@UseGuards(JwtAuthGuard, CapabilityGuard)
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @RequireCapability('audit.read')
  @ApiOperation({
    summary: 'Unified audit stream (audit_events + lead_activities), newest first',
    description:
      'Optional `action` query: exact verb (e.g. "auth.login.success") or ' +
      'prefix wildcard (e.g. "auth.*"). The wildcard form is what the admin ' +
      'audit screen uses to surface every auth-related event in one click.',
  })
  list(
    @Query('limit') limit?: string,
    @Query('before') before?: string,
    @Query('action') action?: string,
  ) {
    const lim = limit ? Number.parseInt(limit, 10) : undefined;
    const beforeDate = before ? new Date(before) : undefined;
    const trimmedAction = action?.trim();
    return this.audit.list({
      limit: lim && Number.isFinite(lim) ? lim : undefined,
      before: beforeDate && !Number.isNaN(beforeDate.getTime()) ? beforeDate : undefined,
      ...(trimmedAction && trimmedAction.length > 0 && { action: trimmedAction }),
    });
  }
}
