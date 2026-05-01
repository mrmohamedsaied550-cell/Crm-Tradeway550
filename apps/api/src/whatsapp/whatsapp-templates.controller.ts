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

import {
  CreateWhatsAppTemplateSchema,
  ListWhatsAppTemplatesQuerySchema,
  UpdateWhatsAppTemplateSchema,
} from './whatsapp-templates.dto';
import { WhatsAppTemplatesService } from './whatsapp-templates.service';

class CreateTemplateDto extends createZodDto(CreateWhatsAppTemplateSchema) {}
class UpdateTemplateDto extends createZodDto(UpdateWhatsAppTemplateSchema) {}
class ListTemplatesQueryDto extends createZodDto(ListWhatsAppTemplatesQuerySchema) {}

/**
 * /api/v1/whatsapp/templates (P2-12) — admin CRUD over the template
 * picker. Read is open to every CRM role (the picker shows up in
 * the agent inbox); write is admin-gated.
 */
@ApiTags('whatsapp')
@Controller('whatsapp/templates')
@UseGuards(JwtAuthGuard, CapabilityGuard)
export class WhatsAppTemplatesController {
  constructor(private readonly templates: WhatsAppTemplatesService) {}

  @Get()
  @RequireCapability('whatsapp.template.read')
  @ApiOperation({ summary: 'List WhatsApp templates for the active tenant' })
  list(@Query() query: ListTemplatesQueryDto) {
    return this.templates.list(query);
  }

  @Get(':id')
  @RequireCapability('whatsapp.template.read')
  @ApiOperation({ summary: 'Get a WhatsApp template by id' })
  findOne(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.templates.findByIdOrThrow(id);
  }

  @Post()
  @RequireCapability('whatsapp.template.write')
  @ApiOperation({ summary: 'Record a Meta-approved template' })
  create(@Body() body: CreateTemplateDto, @CurrentUser() user: AccessTokenClaims) {
    return this.templates.create(body, user.sub);
  }

  @Patch(':id')
  @RequireCapability('whatsapp.template.write')
  @ApiOperation({ summary: 'Update a recorded template (body / category / status)' })
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateTemplateDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    return this.templates.update(id, body, user.sub);
  }

  @Delete(':id')
  @RequireCapability('whatsapp.template.write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a template' })
  async remove(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<void> {
    await this.templates.delete(id, user.sub);
  }
}
