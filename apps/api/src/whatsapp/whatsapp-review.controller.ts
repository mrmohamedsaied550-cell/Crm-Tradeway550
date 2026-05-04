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
import { z } from 'zod';

import { CurrentUser } from '../identity/current-user.decorator';
import { JwtAuthGuard } from '../identity/jwt-auth.guard';
import type { AccessTokenClaims } from '../identity/jwt.types';
import { CapabilityGuard } from '../rbac/capability.guard';
import { RequireCapability } from '../rbac/require-capability.decorator';
import type { ScopeUserClaims } from '../rbac/scope-context.service';

import { WhatsAppReviewService } from './whatsapp-review.service';

const ListReviewsQuerySchema = z
  .object({
    resolved: z.coerce.boolean().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();
class ListReviewsQueryDto extends createZodDto(ListReviewsQuerySchema) {}

const ResolveReviewSchema = z
  .object({
    resolution: z.enum(['linked_to_lead', 'linked_to_captain', 'new_lead', 'dismissed']),
    leadId: z.string().uuid().optional(),
  })
  .strict();
class ResolveReviewDto extends createZodDto(ResolveReviewSchema) {}

function claimsToScope(claims: AccessTokenClaims): ScopeUserClaims {
  return { userId: claims.sub, tenantId: claims.tid, roleId: claims.rid };
}

/**
 * /api/v1/whatsapp/reviews — Phase C — C10B-4 review-queue admin
 * surface.
 *
 * Reviews inherit conversation scope (locked decision §4). The
 * `whatsapp.review.read` capability gates listing; `whatsapp.review.resolve`
 * gates the resolve endpoint. Both are admin-tier (super_admin /
 * ops_manager / account_manager) — TLs see the queue (read) but
 * cannot resolve.
 */
@ApiTags('whatsapp')
@Controller('whatsapp/reviews')
@UseGuards(JwtAuthGuard, CapabilityGuard)
export class WhatsAppReviewController {
  constructor(private readonly reviews: WhatsAppReviewService) {}

  @Get()
  @RequireCapability('whatsapp.review.read')
  @ApiOperation({ summary: 'List WhatsApp review-queue rows in scope' })
  list(@Query() query: ListReviewsQueryDto, @CurrentUser() user: AccessTokenClaims) {
    return this.reviews.listForUser(claimsToScope(user), {
      resolved: query.resolved,
      limit: query.limit,
      offset: query.offset,
    });
  }

  @Get(':id')
  @RequireCapability('whatsapp.review.read')
  @ApiOperation({ summary: 'Get a review row + its conversation + contact' })
  async getOne(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    const row = await this.reviews.findByIdInScope(claimsToScope(user), id);
    if (!row) {
      throw new NotFoundException({
        code: 'whatsapp.review.not_found',
        message: `Review ${id} not found in active tenant`,
      });
    }
    return row;
  }

  @Post(':id/resolve')
  @RequireCapability('whatsapp.review.resolve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Resolve a review — link to existing lead / link to captain / create new lead / dismiss',
  })
  resolve(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: ResolveReviewDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    return this.reviews.resolve(claimsToScope(user), id, {
      resolution: body.resolution,
      leadId: body.leadId,
    });
  }
}
