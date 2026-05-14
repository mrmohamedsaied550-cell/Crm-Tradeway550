import {
  Body,
  Controller,
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
import type { ScopeUserClaims } from '../rbac/scope-context.service';

import {
  CreateLeadPartnerTargetSchema,
  ListLeadPartnerTargetsQuerySchema,
  UpdateLeadPartnerTargetSchema,
} from './lead-partner-targets.dto';
import { LeadPartnerTargetsService } from './lead-partner-targets.service';

class CreateLeadPartnerTargetBody extends createZodDto(CreateLeadPartnerTargetSchema) {}
class ListLeadPartnerTargetsQuery extends createZodDto(ListLeadPartnerTargetsQuerySchema) {}
class UpdateLeadPartnerTargetBody extends createZodDto(UpdateLeadPartnerTargetSchema) {}

/**
 * /api/v1/leads/:leadId/partner-targets — Sprint 13 (D13) + Sprint 17 (D17).
 *
 *   GET   /            — list targets for a lead. Requires `partner.target.read`.
 *                        Lead scope gates visibility.
 *   POST  /            — create a new target. Requires `partner.target.write`.
 *                        Dedupe via DB unique index; service returns
 *                        `lead.partner_target.duplicate` on conflict so the
 *                        UI can render a clean error.
 *   PATCH /:targetId   — Sprint 17: update status, owner, team, country, or note.
 *                        Requires `partner.target.write` (same capability as create —
 *                        no separate "transition" gate, matches Sprint 13's locked
 *                        permission contract). `partnerSourceId` stays immutable
 *                        so the unique-index dedupe key holds.
 */
@ApiTags('lead-partner-targets')
@Controller('leads/:leadId/partner-targets')
@UseGuards(JwtAuthGuard, CapabilityGuard)
export class LeadPartnerTargetsController {
  constructor(private readonly targets: LeadPartnerTargetsService) {}

  private claimsToScope(claims: AccessTokenClaims): ScopeUserClaims {
    return { userId: claims.sub, tenantId: claims.tid, roleId: claims.rid };
  }

  @Get()
  @RequireCapability('partner.target.read')
  @ApiOperation({
    summary: 'List partner-target intent rows for a lead. Lead scope + tenant-isolated.',
  })
  list(
    @Param('leadId', new ParseUUIDPipe()) leadId: string,
    @Query() query: ListLeadPartnerTargetsQuery,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    return this.targets.listForLead(leadId, this.claimsToScope(user), query);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequireCapability('partner.target.write')
  @ApiOperation({
    summary:
      'Create a new partner target for a lead. Dedupes on (lead, partner) via DB unique index; never duplicates the lead/contact.',
  })
  create(
    @Param('leadId', new ParseUUIDPipe()) leadId: string,
    @Body() body: CreateLeadPartnerTargetBody,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    return this.targets.create(leadId, body, this.claimsToScope(user));
  }

  @Patch(':targetId')
  @RequireCapability('partner.target.write')
  @ApiOperation({
    summary:
      'Sprint 17 — partial update of an existing partner target (status, owner, team, country, note).',
  })
  update(
    @Param('leadId', new ParseUUIDPipe()) leadId: string,
    @Param('targetId', new ParseUUIDPipe()) targetId: string,
    @Body() body: UpdateLeadPartnerTargetBody,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    return this.targets.update(leadId, targetId, body, this.claimsToScope(user));
  }
}
