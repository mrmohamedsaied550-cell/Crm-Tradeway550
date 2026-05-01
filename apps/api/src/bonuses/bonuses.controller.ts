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

import { BonusesService } from './bonuses.service';
import { CreateBonusRuleSchema, UpdateBonusRuleSchema } from './bonus.dto';

class CreateBonusRuleDto extends createZodDto(CreateBonusRuleSchema) {}
class UpdateBonusRuleDto extends createZodDto(UpdateBonusRuleSchema) {}

/**
 * /api/v1/bonuses (C32) — admin CRUD for BonusRules. Mutations write
 * an audit row (C40) attributed to the calling user.
 */
@ApiTags('bonuses')
@Controller('bonuses')
@UseGuards(JwtAuthGuard, CapabilityGuard)
export class BonusesController {
  constructor(private readonly bonuses: BonusesService) {}

  @Get()
  @RequireCapability('bonus.read')
  @ApiOperation({ summary: 'List bonus rules in the active tenant' })
  list() {
    return this.bonuses.list();
  }

  @Get(':id')
  @RequireCapability('bonus.read')
  @ApiOperation({ summary: 'Get one bonus rule' })
  get(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.bonuses.findByIdOrThrow(id);
  }

  @Post()
  @RequireCapability('bonus.write')
  @ApiOperation({ summary: 'Create a bonus rule' })
  create(@Body() body: CreateBonusRuleDto, @CurrentUser() user: AccessTokenClaims) {
    return this.bonuses.create(body, user.sub);
  }

  @Patch(':id')
  @RequireCapability('bonus.write')
  @ApiOperation({ summary: 'Update a bonus rule' })
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateBonusRuleDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    return this.bonuses.update(id, body, user.sub);
  }

  @Post(':id/enable')
  @RequireCapability('bonus.write')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Enable a bonus rule (idempotent)' })
  enable(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AccessTokenClaims) {
    return this.bonuses.setActive(id, true, user.sub);
  }

  @Post(':id/disable')
  @RequireCapability('bonus.write')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Disable a bonus rule (idempotent)' })
  disable(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AccessTokenClaims) {
    return this.bonuses.setActive(id, false, user.sub);
  }

  @Delete(':id')
  @RequireCapability('bonus.write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a bonus rule' })
  remove(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<void> {
    return this.bonuses.remove(id, user.sub);
  }
}
