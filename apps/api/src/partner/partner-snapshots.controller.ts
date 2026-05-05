import {
  BadRequestException,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../identity/jwt-auth.guard';
import { CapabilityGuard } from '../rbac/capability.guard';
import { RequireCapability } from '../rbac/require-capability.decorator';

import { isD4PartnerHubV1Enabled } from './d4-feature-flag';
import { PartnerSnapshotsService } from './partner-snapshots.service';

/**
 * Phase D4 — D4.3: PartnerSnapshot read endpoints.
 *
 *   GET /partner-snapshots
 *   GET /partner-snapshots/:id
 *   GET /partner-snapshots/:id/records
 *
 * All require `partner.source.read` (every TL+ already has it).
 * Feature-flag gate is the same `partner.feature.disabled` shape
 * the source endpoints use.
 */
@ApiTags('partner')
@Controller('partner-snapshots')
@UseGuards(JwtAuthGuard, CapabilityGuard)
export class PartnerSnapshotsController {
  constructor(private readonly snapshots: PartnerSnapshotsService) {}

  @Get()
  @RequireCapability('partner.source.read')
  @ApiOperation({ summary: 'List partner snapshots' })
  list(
    @Query('partnerSourceId') partnerSourceId: string | undefined,
    @Query('status') status: string | undefined,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('offset') offset: string | undefined,
  ) {
    this.assertEnabled();
    const lim = limit ? Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200) : 50;
    const off = offset ? Math.max(Number.parseInt(offset, 10) || 0, 0) : 0;
    const fromDate = from ? new Date(from) : undefined;
    const toDate = to ? new Date(to) : undefined;
    return this.snapshots.list({
      ...(partnerSourceId && { partnerSourceId }),
      ...(status && { status }),
      ...(fromDate && !Number.isNaN(fromDate.getTime()) && { from: fromDate }),
      ...(toDate && !Number.isNaN(toDate.getTime()) && { to: toDate }),
      limit: lim,
      offset: off,
    });
  }

  @Get(':id')
  @RequireCapability('partner.source.read')
  @ApiOperation({ summary: 'Get a partner snapshot by id' })
  findOne(@Param('id', new ParseUUIDPipe()) id: string) {
    this.assertEnabled();
    return this.snapshots.findById(id);
  }

  @Get(':id/records')
  @RequireCapability('partner.source.read')
  @ApiOperation({ summary: 'List records inside a snapshot (paginated)' })
  records(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('limit') limit: string | undefined,
    @Query('offset') offset: string | undefined,
  ) {
    this.assertEnabled();
    const lim = limit ? Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 500) : 100;
    const off = offset ? Math.max(Number.parseInt(offset, 10) || 0, 0) : 0;
    return this.snapshots.recordsForSnapshot(id, { limit: lim, offset: off });
  }

  private assertEnabled(): void {
    if (!isD4PartnerHubV1Enabled()) {
      throw new BadRequestException({
        code: 'partner.feature.disabled',
        message: 'Partner Data Hub is disabled in this environment.',
      });
    }
  }
}
