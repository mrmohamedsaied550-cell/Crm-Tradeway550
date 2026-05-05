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
import { CreatePartnerMappingSchema, UpdatePartnerMappingSchema } from './partner-mapping.dto';
import { PartnerMappingsService } from './partner-mappings.service';

class CreatePartnerMappingDto extends createZodDto(CreatePartnerMappingSchema) {}
class UpdatePartnerMappingDto extends createZodDto(UpdatePartnerMappingSchema) {}

/**
 * Phase D4 — D4.2: PartnerFieldMapping admin CRUD.
 *
 * Mounted under `/partner-sources/:id/mappings/...` so the source
 * id is visible in every URL — matches the lead-detail-scoped
 * sub-resource pattern from D3 (`/leads/:id/rotations`,
 * `/leads/:id/stage-statuses`).
 *
 * Capability matrix:
 *   GET    /partner-sources/:id/mappings          — partner.source.read
 *   GET    /partner-sources/:id/mappings/readiness — partner.source.read
 *   POST   /partner-sources/:id/mappings          — partner.source.write
 *   PATCH  /partner-sources/:id/mappings/:mid     — partner.source.write
 *   DELETE /partner-sources/:id/mappings/:mid     — partner.source.write
 */
@ApiTags('partner')
@Controller('partner-sources/:id/mappings')
@UseGuards(JwtAuthGuard, CapabilityGuard)
export class PartnerMappingsController {
  constructor(private readonly mappings: PartnerMappingsService) {}

  @Get()
  @RequireCapability('partner.source.read')
  @ApiOperation({ summary: 'List field mappings for a partner source' })
  list(@Param('id', new ParseUUIDPipe()) id: string) {
    this.assertEnabled();
    return this.mappings.list(id);
  }

  @Get('readiness')
  @RequireCapability('partner.source.read')
  @ApiOperation({ summary: 'Mapping readiness — phone mapped + recommended fields' })
  readiness(@Param('id', new ParseUUIDPipe()) id: string) {
    this.assertEnabled();
    return this.mappings.getReadiness(id);
  }

  @Post()
  @RequireCapability('partner.source.write')
  @ApiOperation({ summary: 'Create a field mapping on a partner source' })
  create(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: CreatePartnerMappingDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    this.assertEnabled();
    return this.mappings.create(id, body, user.sub);
  }

  @Patch(':mappingId')
  @RequireCapability('partner.source.write')
  @ApiOperation({ summary: 'Update a field mapping' })
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('mappingId', new ParseUUIDPipe()) mappingId: string,
    @Body() body: UpdatePartnerMappingDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    this.assertEnabled();
    return this.mappings.update(id, mappingId, body, user.sub);
  }

  @Delete(':mappingId')
  @RequireCapability('partner.source.write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a field mapping' })
  remove(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('mappingId', new ParseUUIDPipe()) mappingId: string,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    this.assertEnabled();
    return this.mappings.remove(id, mappingId, user.sub);
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
