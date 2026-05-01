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

import { JwtAuthGuard } from '../identity/jwt-auth.guard';

import { BonusesService } from './bonuses.service';
import { CreateBonusRuleSchema, UpdateBonusRuleSchema } from './bonus.dto';

class CreateBonusRuleDto extends createZodDto(CreateBonusRuleSchema) {}
class UpdateBonusRuleDto extends createZodDto(UpdateBonusRuleSchema) {}

/**
 * /api/v1/bonuses (C32) — admin CRUD for BonusRules.
 */
@ApiTags('bonuses')
@Controller('bonuses')
@UseGuards(JwtAuthGuard)
export class BonusesController {
  constructor(private readonly bonuses: BonusesService) {}

  @Get()
  @ApiOperation({ summary: 'List bonus rules in the active tenant' })
  list() {
    return this.bonuses.list();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one bonus rule' })
  get(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.bonuses.findByIdOrThrow(id);
  }

  @Post()
  @ApiOperation({ summary: 'Create a bonus rule' })
  create(@Body() body: CreateBonusRuleDto) {
    return this.bonuses.create(body);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a bonus rule' })
  update(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: UpdateBonusRuleDto) {
    return this.bonuses.update(id, body);
  }

  @Post(':id/enable')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Enable a bonus rule (idempotent)' })
  enable(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.bonuses.setActive(id, true);
  }

  @Post(':id/disable')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Disable a bonus rule (idempotent)' })
  disable(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.bonuses.setActive(id, false);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a bonus rule' })
  remove(@Param('id', new ParseUUIDPipe()) id: string): Promise<void> {
    return this.bonuses.remove(id);
  }
}
