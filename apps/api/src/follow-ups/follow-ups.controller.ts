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
import {
  CalendarFollowUpsQuerySchema,
  CreateFollowUpSchema,
  ListMyFollowUpsQuerySchema,
} from './follow-up.dto';

class CreateFollowUpDto extends createZodDto(CreateFollowUpSchema) {}
class ListMyFollowUpsQueryDto extends createZodDto(ListMyFollowUpsQuerySchema) {}
class CalendarFollowUpsQueryDto extends createZodDto(CalendarFollowUpsQuerySchema) {}

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

  /**
   * P3-04 — calendar feed. Returns every follow-up whose `dueAt` is
   * inside `[from, to]` for the calling user; with `mine=0` the same
   * capability lets a manager see the whole tenant's calendar (RLS
   * keeps cross-tenant rows out either way). The endpoint is
   * read-only and gated on `followup.read` like the other reads.
   */
  @Get('follow-ups/calendar')
  @RequireCapability('followup.read')
  @ApiOperation({ summary: 'List follow-ups in a date range (calendar feed)' })
  calendar(@Query() query: CalendarFollowUpsQueryDto, @CurrentUser() user: AccessTokenClaims) {
    return this.followUps.listInRange(user.sub, { ...query, allowAllAssignees: true });
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
