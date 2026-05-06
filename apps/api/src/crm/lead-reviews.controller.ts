import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
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
import { ResourceFieldGate } from '../rbac/resource-field-gate.decorator';
import type { ScopeUserClaims } from '../rbac/scope-context.service';

import { LeadReviewService } from './lead-review.service';
import { ListLeadReviewsSchema, ResolveLeadReviewSchema } from './lead-review.dto';

class ListLeadReviewsDto extends createZodDto(ListLeadReviewsSchema) {}
class ResolveLeadReviewDto extends createZodDto(ResolveLeadReviewSchema) {}

function claimsToScope(claims: AccessTokenClaims): ScopeUserClaims {
  return { userId: claims.sub, tenantId: claims.tid, roleId: claims.rid };
}

/**
 * Phase D3 — D3.6: TL Review Queue HTTP surface.
 *
 * Mirrors the proven D1.5 `WhatsAppReviewController` shape:
 *   - `GET /lead-reviews`             — scope-aware list with chips.
 *   - `GET /lead-reviews/count`       — unresolved count (sidebar
 *                                       badge, cheap).
 *   - `GET /lead-reviews/:id`         — single row with lead context.
 *   - `POST /lead-reviews/:id/resolve` — close with one of the four
 *                                       resolutions.
 *
 * Capability gates:
 *   - `lead.review.read`    — list / count / get one.
 *   - `lead.review.resolve` — resolve.
 *
 * Both granted to TLs / Ops / Account Manager / Super Admin. Sales /
 * activation / driving agents fail the gate at the guard layer.
 */
@ApiTags('crm')
@Controller('lead-reviews')
@UseGuards(JwtAuthGuard, CapabilityGuard)
export class LeadReviewsController {
  constructor(private readonly reviews: LeadReviewService) {}

  @Get()
  @RequireCapability('lead.review.read')
  @ResourceFieldGate('lead.review')
  @ApiOperation({ summary: 'List TL Review Queue rows in scope' })
  list(@Query() query: ListLeadReviewsDto, @CurrentUser() user: AccessTokenClaims) {
    return this.reviews.listReviews(claimsToScope(user), query);
  }

  /**
   * Unresolved count for the sidebar badge. Cheap — drops every
   * filter except the implicit scope + `resolved=false`.
   */
  @Get('count')
  @RequireCapability('lead.review.read')
  @ApiOperation({ summary: 'Unresolved lead-review count in scope' })
  async count(@CurrentUser() user: AccessTokenClaims) {
    const result = await this.reviews.listReviews(claimsToScope(user), {
      resolved: false,
      limit: 1,
      offset: 0,
    });
    return { unresolved: result.total };
  }

  @Get(':id')
  @RequireCapability('lead.review.read')
  @ResourceFieldGate('lead.review')
  @ApiOperation({ summary: 'Get a single review row in scope' })
  async getOne(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    const row = await this.reviews.findByIdInScope(claimsToScope(user), id);
    if (!row) {
      throw new NotFoundException({
        code: 'lead.review.not_found',
        message: `Review not found: ${id}`,
      });
    }
    return row;
  }

  @Post(':id/resolve')
  @RequireCapability('lead.review.resolve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Resolve a review row (rotated / kept_owner / escalated / dismissed)' })
  resolve(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: ResolveLeadReviewDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    return this.reviews.resolveReview(
      id,
      body.resolution,
      body.notes,
      user.sub,
      claimsToScope(user),
    );
  }
}
