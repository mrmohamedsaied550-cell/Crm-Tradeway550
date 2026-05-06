import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';

import { CurrentUser } from '../identity/current-user.decorator';
import { JwtAuthGuard } from '../identity/jwt-auth.guard';
import type { AccessTokenClaims } from '../identity/jwt.types';
import { CapabilityGuard } from '../rbac/capability.guard';
import { RequireCapability } from '../rbac/require-capability.decorator';
import { ResourceFieldGate } from '../rbac/resource-field-gate.decorator';

import { isD4PartnerHubV1Enabled } from './d4-feature-flag';
import {
  CreatePartnerSourceSchema,
  ListPartnerSourcesSchema,
  UpdatePartnerSourceSchema,
} from './partner-source.dto';
import { PartnerSourcesService } from './partner-sources.service';
import { PartnerSyncService } from './partner-sync.service';
import { z } from 'zod';

class CreatePartnerSourceDto extends createZodDto(CreatePartnerSourceSchema) {}
class UpdatePartnerSourceDto extends createZodDto(UpdatePartnerSourceSchema) {}
class ListPartnerSourcesDto extends createZodDto(ListPartnerSourcesSchema) {}

/**
 * D4.3 — manual upload body. CSV string is bounded so a runaway
 * paste doesn't blow the request body limit; 5 MB is generous for
 * a sheet of ~50k rows × 100 chars/row.
 */
const SyncUploadSchema = z
  .object({
    csv: z
      .string()
      .min(1)
      .max(5 * 1024 * 1024),
  })
  .strict();
class SyncUploadDto extends createZodDto(SyncUploadSchema) {}

/**
 * Phase D4 — D4.2: PartnerSource admin CRUD.
 *
 * `D4_PARTNER_HUB_V1` gates every endpoint. Flag-off: every call
 * rejects with `partner.feature.disabled` so a stale UI in
 * production can't accidentally write through. Same shape as the
 * D3 `lead.rotate.disabled` gate.
 *
 * Capability matrix:
 *   GET    /partner-sources           — partner.source.read
 *   GET    /partner-sources/:id       — partner.source.read
 *   POST   /partner-sources           — partner.source.write
 *   PATCH  /partner-sources/:id       — partner.source.write
 *   DELETE /partner-sources/:id       — partner.source.write   (soft-disable)
 *   POST   /partner-sources/:id/test-connection — partner.source.write
 *
 * The DELETE flips `isActive=false` rather than hard-deleting the
 * row — snapshot history cascades on hard-delete and we never want
 * a single click to lose audit data.
 */
@ApiTags('partner')
@Controller('partner-sources')
@UseGuards(JwtAuthGuard, CapabilityGuard)
export class PartnerSourcesController {
  constructor(
    private readonly sources: PartnerSourcesService,
    private readonly syncService: PartnerSyncService,
  ) {}

  @Get()
  @RequireCapability('partner.source.read')
  @ResourceFieldGate('partner_source')
  @ApiOperation({ summary: 'List partner sources for the active tenant' })
  list(@Query() query: ListPartnerSourcesDto) {
    this.assertEnabled();
    return this.sources.list(query);
  }

  @Get(':id')
  @RequireCapability('partner.source.read')
  @ResourceFieldGate('partner_source')
  @ApiOperation({ summary: 'Get a partner source by id' })
  findOne(@Param('id', new ParseUUIDPipe()) id: string) {
    this.assertEnabled();
    return this.sources.findById(id);
  }

  @Post()
  @RequireCapability('partner.source.write')
  @ApiOperation({ summary: 'Create a partner source' })
  create(@Body() body: CreatePartnerSourceDto, @CurrentUser() user: AccessTokenClaims) {
    this.assertEnabled();
    return this.sources.create(body, user.sub);
  }

  @Patch(':id')
  @RequireCapability('partner.source.write')
  @ApiOperation({ summary: 'Update a partner source' })
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdatePartnerSourceDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    this.assertEnabled();
    return this.sources.update(id, body, user.sub);
  }

  @Delete(':id')
  @RequireCapability('partner.source.write')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Soft-disable a partner source (isActive=false)' })
  remove(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AccessTokenClaims) {
    this.assertEnabled();
    return this.sources.softDisable(id, user.sub);
  }

  @Post(':id/test-connection')
  @RequireCapability('partner.source.write')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Probe the partner adapter and refresh connectionStatus' })
  testConnection(@Param('id', new ParseUUIDPipe()) id: string) {
    this.assertEnabled();
    return this.syncService.testConnection(id);
  }

  /**
   * D4.3 — manual sync trigger.
   *
   * For Google Sheets sources: routes through the GoogleSheetsAdapter
   * (currently a seam — returns `partner.adapter.not_wired` as a
   * controlled error and lands the snapshot as `failed`).
   *
   * For manual_upload sources: this endpoint refuses (no CSV body).
   * Use `POST /partner-sources/:id/sync-upload` instead.
   */
  @Post(':id/sync')
  @RequireCapability('partner.sync.run')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Trigger a manual sync (non-upload)' })
  sync(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AccessTokenClaims) {
    this.assertEnabled();
    return this.syncService.runSync(id, { trigger: 'manual', actorUserId: user.sub });
  }

  /**
   * D4.3 — manual upload sync trigger. Accepts a CSV string body
   * and runs it through the manual-upload adapter. Source must
   * have `adapter='manual_upload'`; otherwise the service rejects
   * with `partner.sync.upload_not_supported`.
   */
  @Post(':id/sync-upload')
  @RequireCapability('partner.sync.run')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Trigger a manual sync from an uploaded CSV string' })
  syncUpload(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: SyncUploadDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    this.assertEnabled();
    return this.syncService.runSync(id, {
      trigger: 'manual_upload',
      actorUserId: user.sub,
      manualCsv: body.csv,
    });
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
