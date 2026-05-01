import {
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

import { CreateMetaLeadSourceSchema, UpdateMetaLeadSourceSchema } from './ingestion.dto';
import { MetaLeadSourcesService } from './meta-lead-sources.service';

class CreateMetaLeadSourceDto extends createZodDto(CreateMetaLeadSourceSchema) {}
class UpdateMetaLeadSourceDto extends createZodDto(UpdateMetaLeadSourceSchema) {}

/**
 * /api/v1/meta-lead-sources (P2-06) — admin CRUD for Meta lead-ad
 * routing rows. The public webhook (`/webhooks/meta/leadgen`) reads
 * the same table but bypasses tenant scoping; here every operation
 * is tenant-scoped via the JWT `tid` claim and the field
 * `app_secret` is intentionally never returned.
 */
@ApiTags('crm')
@Controller('meta-lead-sources')
@UseGuards(JwtAuthGuard, CapabilityGuard)
export class MetaLeadSourcesController {
  constructor(private readonly sources: MetaLeadSourcesService) {}

  @Get()
  @RequireCapability('meta.leadsource.read')
  @ApiOperation({ summary: 'List Meta lead-ad sources for the active tenant' })
  list() {
    return this.sources.list();
  }

  @Get(':id')
  @RequireCapability('meta.leadsource.read')
  @ApiOperation({ summary: 'Read a Meta lead-ad source by id' })
  findOne(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.sources.findByIdOrThrow(id);
  }

  @Post()
  @RequireCapability('meta.leadsource.write')
  @ApiOperation({ summary: 'Create a Meta lead-ad source' })
  create(@Body() body: CreateMetaLeadSourceDto, @CurrentUser() user: AccessTokenClaims) {
    return this.sources.create(body, user.sub);
  }

  @Patch(':id')
  @RequireCapability('meta.leadsource.write')
  @ApiOperation({ summary: 'Update a Meta lead-ad source' })
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateMetaLeadSourceDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    return this.sources.update(id, body, user.sub);
  }

  @Delete(':id')
  @RequireCapability('meta.leadsource.write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a Meta lead-ad source' })
  async remove(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<void> {
    await this.sources.delete(id, user.sub);
  }
}
