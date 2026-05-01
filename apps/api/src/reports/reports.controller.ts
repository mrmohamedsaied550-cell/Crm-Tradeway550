import { Controller, Get, Header, Query, Res, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import type { Response } from 'express';

import { JwtAuthGuard } from '../identity/jwt-auth.guard';
import { CapabilityGuard } from '../rbac/capability.guard';
import { RequireCapability } from '../rbac/require-capability.decorator';

import { ReportsService } from './reports.service';
import { ReportFiltersSchema, TimeseriesQuerySchema } from './report.dto';

class ReportFiltersDto extends createZodDto(ReportFiltersSchema) {}
class TimeseriesQueryDto extends createZodDto(TimeseriesQuerySchema) {}

/**
 * /api/v1/reports (C38 + P2-11) — manager-dashboard surface.
 *
 *   - GET /reports/summary       headline KPIs + per-stage funnel
 *   - GET /reports/timeseries    daily-bucket counts for one metric
 *   - GET /reports/export.csv    flattened summary + leads_created
 *                                series in CSV
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

  @Get('timeseries')
  @RequireCapability('report.read')
  @ApiOperation({
    summary: 'Daily-bucket time-series for one metric',
    description:
      'Default window is the trailing 30 days. Returns one point per UTC day, ' +
      'including zero-rows for days with no activity.',
  })
  timeseries(@Query() query: TimeseriesQueryDto) {
    return this.reports.timeseries(query);
  }

  @Get('export.csv')
  @RequireCapability('report.read')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'CSV export of summary KPIs + per-stage funnel + leads_created series',
  })
  async exportCsv(@Query() query: ReportFiltersDto, @Res() res: Response): Promise<void> {
    const csv = await this.reports.exportCsv(query);
    const filename = `crm-report-${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  }
}
