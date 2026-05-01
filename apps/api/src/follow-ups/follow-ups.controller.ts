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

import { FollowUpsService } from './follow-ups.service';
import { CreateFollowUpSchema, ListMyFollowUpsQuerySchema } from './follow-up.dto';

class CreateFollowUpDto extends createZodDto(CreateFollowUpSchema) {}
class ListMyFollowUpsQueryDto extends createZodDto(ListMyFollowUpsQuerySchema) {}

/**
 * /api/v1 — lead follow-ups (C36).
 *
 * Three routes:
 *   - GET /follow-ups/mine                  — my queue (default = pending)
 *   - GET /leads/:leadId/follow-ups         — full list per lead
 *   - POST /leads/:leadId/follow-ups        — schedule a follow-up
 *   - POST /follow-ups/:id/complete         — mark done
 *   - DELETE /follow-ups/:id                — admin housekeeping
 */
@ApiTags('follow-ups')
@Controller()
@UseGuards(JwtAuthGuard)
export class FollowUpsController {
  constructor(private readonly followUps: FollowUpsService) {}

  @Get('follow-ups/mine')
  @ApiOperation({ summary: "List the calling user's follow-ups (default: pending only)" })
  mine(@Query() query: ListMyFollowUpsQueryDto, @CurrentUser() user: AccessTokenClaims) {
    return this.followUps.listMine(user.sub, query);
  }

  @Get('leads/:leadId/follow-ups')
  @ApiOperation({ summary: 'List every follow-up scheduled on this lead' })
  listForLead(@Param('leadId', new ParseUUIDPipe()) leadId: string) {
    return this.followUps.listForLead(leadId);
  }

  @Post('leads/:leadId/follow-ups')
  @ApiOperation({ summary: 'Schedule a follow-up on this lead' })
  create(
    @Param('leadId', new ParseUUIDPipe()) leadId: string,
    @Body() body: CreateFollowUpDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    return this.followUps.create(leadId, body, user.sub);
  }

  @Post('follow-ups/:id/complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark a follow-up as completed (now)' })
  complete(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.followUps.complete(id);
  }

  @Delete('follow-ups/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a follow-up' })
  remove(@Param('id', new ParseUUIDPipe()) id: string): Promise<void> {
    return this.followUps.remove(id);
  }
}
