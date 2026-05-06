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
import { ResourceFieldGate } from '../rbac/resource-field-gate.decorator';
import type { ScopeUserClaims } from '../rbac/scope-context.service';

import { FollowUpsService } from './follow-ups.service';
import {
  CalendarFollowUpsQuerySchema,
  CreateFollowUpSchema,
  ListMyFollowUpsQuerySchema,
  UpdateFollowUpSchema,
} from './follow-up.dto';

class CreateFollowUpDto extends createZodDto(CreateFollowUpSchema) {}
class UpdateFollowUpDto extends createZodDto(UpdateFollowUpSchema) {}
class ListMyFollowUpsQueryDto extends createZodDto(ListMyFollowUpsQuerySchema) {}
class CalendarFollowUpsQueryDto extends createZodDto(CalendarFollowUpsQuerySchema) {}

/** Same shape as crm/leads.controller's helper — kept private here to
 *  avoid cross-module import. Could live in a shared utility once a
 *  third controller needs it. */
function claimsToScope(claims: AccessTokenClaims): ScopeUserClaims {
  return { userId: claims.sub, tenantId: claims.tid, roleId: claims.rid };
}

@ApiTags('follow-ups')
@Controller()
@UseGuards(JwtAuthGuard, CapabilityGuard)
export class FollowUpsController {
  constructor(private readonly followUps: FollowUpsService) {}

  @Get('follow-ups/mine')
  @RequireCapability('followup.read')
  @ResourceFieldGate('followup')
  @ApiOperation({ summary: "List the calling user's follow-ups (default: pending only)" })
  mine(@Query() query: ListMyFollowUpsQueryDto, @CurrentUser() user: AccessTokenClaims) {
    return this.followUps.listMine(user.sub, query, claimsToScope(user));
  }

  /**
   * Phase A — A5: bell-badge counters for the calling user's
   * follow-ups. `dueTodayCount` is computed in the tenant's IANA
   * timezone so Cairo + Riyadh agents see "today" matching their
   * local wall-clock.
   */
  @Get('follow-ups/me/summary')
  @RequireCapability('followup.read')
  @ApiOperation({
    summary: 'Counts of overdue + due-today follow-ups for the calling user',
  })
  summary(@CurrentUser() user: AccessTokenClaims) {
    return this.followUps.summaryForUser(user.sub, claimsToScope(user));
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
  @ResourceFieldGate('followup')
  @ApiOperation({ summary: 'List follow-ups in a date range (calendar feed)' })
  calendar(@Query() query: CalendarFollowUpsQueryDto, @CurrentUser() user: AccessTokenClaims) {
    return this.followUps.listInRange(
      user.sub,
      { ...query, allowAllAssignees: true },
      claimsToScope(user),
    );
  }

  @Get('leads/:leadId/follow-ups')
  @RequireCapability('followup.read')
  @ResourceFieldGate('followup')
  @ApiOperation({ summary: 'List every follow-up scheduled on this lead' })
  listForLead(
    @Param('leadId', new ParseUUIDPipe()) leadId: string,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    return this.followUps.listForLead(leadId, claimsToScope(user));
  }

  @Post('leads/:leadId/follow-ups')
  @RequireCapability('followup.write')
  @ApiOperation({ summary: 'Schedule a follow-up on this lead' })
  create(
    @Param('leadId', new ParseUUIDPipe()) leadId: string,
    @Body() body: CreateFollowUpDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    return this.followUps.create(leadId, body, user.sub, claimsToScope(user));
  }

  @Post('follow-ups/:id/complete')
  @RequireCapability('followup.complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark a follow-up as completed (now)' })
  complete(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AccessTokenClaims) {
    return this.followUps.complete(id, user.sub, claimsToScope(user));
  }

  /**
   * Phase A — A5: PATCH a follow-up. Today the only patchable field
   * is `snoozedUntil` (push the row out of active windows until the
   * given time, or `null` to clear). Future fields plug in here.
   * Capability: `followup.write` — same as create.
   */
  @Patch('follow-ups/:id')
  @RequireCapability('followup.write')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update a follow-up (currently: snoozedUntil)' })
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateFollowUpDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    return this.followUps.update(id, body, user.sub, claimsToScope(user));
  }

  @Delete('follow-ups/:id')
  @RequireCapability('followup.write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a follow-up' })
  remove(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<void> {
    return this.followUps.remove(id, user.sub, claimsToScope(user));
  }
}
