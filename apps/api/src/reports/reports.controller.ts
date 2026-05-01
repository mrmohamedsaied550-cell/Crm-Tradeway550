import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';

import { JwtAuthGuard } from '../identity/jwt-auth.guard';
import { CapabilityGuard } from '../rbac/capability.guard';
import { RequireCapability } from '../rbac/require-capability.decorator';

import { ReportsService } from './reports.service';
import { ReportFiltersSchema } from './report.dto';

class ReportFiltersDto extends createZodDto(ReportFiltersSchema) {}

/**
 * /api/v1/reports (C38) — single summary endpoint backing the
 * /admin/reports dashboard cards + leads-by-stage table.
 */
@ApiTags('reports')
@Controller('reports')
@UseGuards(JwtAuthGuard, CapabilityGuard)
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('summary')
  @RequireCapability('report.read')
  @ApiOperation({ summary: 'Tenant-scoped headline metrics for the manager dashboard' })
  summary(@Query() query: ReportFiltersDto) {
    return this.reports.summary(query);
  }
}
