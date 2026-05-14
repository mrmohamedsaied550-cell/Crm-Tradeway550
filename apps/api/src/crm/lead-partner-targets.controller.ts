import {
  Body,
  Controller,
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
import type { ScopeUserClaims } from '../rbac/scope-context.service';

import {
  CreateLeadPartnerTargetSchema,
  ListLeadPartnerTargetsQuerySchema,
} from './lead-partner-targets.dto';
import { LeadPartnerTargetsService } from './lead-partner-targets.service';

class CreateLeadPartnerTargetBody extends createZodDto(CreateLeadPartnerTargetSchema) {}
class ListLeadPartnerTargetsQuery extends createZodDto(ListLeadPartnerTargetsQuerySchema) {}

/**
 * /api/v1/leads/:leadId/partner-targets — Sprint 13 (D13).
 *
 *   GET   /  — list targets for a lead. Requires `partner.target.read`.
 *              Lead scope gates visibility.
 *   POST  /  — create a new target. Requires `partner.target.write`.
 *              Dedupe via DB unique index; service returns
 *              `lead.partner_target.duplicate` on conflict so the
 *              UI can render a clean error.
 *
 * PATCH is deferred to a follow-up sprint per the Sprint 13 spec
 * ("Only if safe and quick"). Sprint 13 ships read + create.
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
}
