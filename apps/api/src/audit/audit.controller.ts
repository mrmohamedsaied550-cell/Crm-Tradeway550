import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../identity/jwt-auth.guard';
import { AuditService } from './audit.service';

@ApiTags('audit')
@Controller('audit')
@UseGuards(JwtAuthGuard)
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @ApiOperation({
    summary: 'Unified audit stream (audit_events + lead_activities), newest first',
  })
  list(@Query('limit') limit?: string, @Query('before') before?: string) {
    const lim = limit ? Number.parseInt(limit, 10) : undefined;
    const beforeDate = before ? new Date(before) : undefined;
    return this.audit.list({
      limit: lim && Number.isFinite(lim) ? lim : undefined,
      before: beforeDate && !Number.isNaN(beforeDate.getTime()) ? beforeDate : undefined,
    });
  }
}
