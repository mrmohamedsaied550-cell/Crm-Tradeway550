import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
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

import { FollowUpsService } from './follow-ups.service';
import { CreateFollowUpSchema, ListMyFollowUpsQuerySchema } from './follow-up.dto';

class CreateFollowUpDto extends createZodDto(CreateFollowUpSchema) {}
class ListMyFollowUpsQueryDto extends createZodDto(ListMyFollowUpsQuerySchema) {}

@ApiTags('follow-ups')
@Controller()
@UseGuards(JwtAuthGuard, CapabilityGuard)
export class FollowUpsController {
  constructor(private readonly followUps: FollowUpsService) {}

  @Get('follow-ups/mine')
  @RequireCapability('followup.read')
  @ApiOperation({ summary: "List the calling user's follow-ups (default: pending only)" })
  mine(@Query() query: ListMyFollowUpsQueryDto, @CurrentUser() user: AccessTokenClaims) {
    return this.followUps.listMine(user.sub, query);
  }

  @Get('leads/:leadId/follow-ups')
  @RequireCapability('followup.read')
  @ApiOperation({ summary: 'List every follow-up scheduled on this lead' })
  listForLead(@Param('leadId', new ParseUUIDPipe()) leadId: string) {
    return this.followUps.listForLead(leadId);
  }

  @Post('leads/:leadId/follow-ups')
  @RequireCapability('followup.write')
  @ApiOperation({ summary: 'Schedule a follow-up on this lead' })
  create(
    @Param('leadId', new ParseUUIDPipe()) leadId: string,
    @Body() body: CreateFollowUpDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    return this.followUps.create(leadId, body, user.sub);
  }

  @Post('follow-ups/:id/complete')
  @RequireCapability('followup.complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark a follow-up as completed (now)' })
  complete(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AccessTokenClaims) {
    return this.followUps.complete(id, user.sub);
  }

  @Delete('follow-ups/:id')
  @RequireCapability('followup.write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a follow-up' })
  remove(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<void> {
    return this.followUps.remove(id, user.sub);
  }
}
