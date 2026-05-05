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

import { isD4PartnerHubV1Enabled } from './d4-feature-flag';
import {
  CreatePartnerSourceSchema,
  ListPartnerSourcesSchema,
  UpdatePartnerSourceSchema,
} from './partner-source.dto';
import { PartnerSourcesService } from './partner-sources.service';

class CreatePartnerSourceDto extends createZodDto(CreatePartnerSourceSchema) {}
class UpdatePartnerSourceDto extends createZodDto(UpdatePartnerSourceSchema) {}
class ListPartnerSourcesDto extends createZodDto(ListPartnerSourcesSchema) {}

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
  constructor(private readonly sources: PartnerSourcesService) {}

  @Get()
  @RequireCapability('partner.source.read')
  @ApiOperation({ summary: 'List partner sources for the active tenant' })
  list(@Query() query: ListPartnerSourcesDto) {
    this.assertEnabled();
    return this.sources.list(query);
  }

  @Get(':id')
  @RequireCapability('partner.source.read')
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
  @ApiOperation({ summary: 'Stub: validate config shape (real probe lands in D4.3)' })
  testConnection(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    this.assertEnabled();
    return this.sources.testConnectionStub(id, user.sub);
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
