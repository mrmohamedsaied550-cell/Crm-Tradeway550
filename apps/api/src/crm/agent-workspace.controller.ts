import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../identity/current-user.decorator';
import { JwtAuthGuard } from '../identity/jwt-auth.guard';
import type { AccessTokenClaims } from '../identity/jwt.types';
import { CapabilityGuard } from '../rbac/capability.guard';
import { RequireCapability } from '../rbac/require-capability.decorator';

import { AgentWorkspaceService, type NeedsAttentionResult } from './agent-workspace.service';

/**
 * Phase D3 — D3.7: agent workspace surface.
 *
 * `GET /agent/needs-attention` — single read endpoint that powers the
 * "Needs attention now" panel on `/agent/workspace`. Returns three
 * lists (rotated-to-me / at-risk SLA / open reviews) for the calling
 * user, scoped to the active tenant.
 *
 * Required capability: `lead.read` — every operational role already
 * holds this. The `openReviews` list is always filtered to
 * `assignedTlId = me`, so an agent without `lead.review.read` simply
 * sees an empty list (the queue at `/admin/lead-reviews` is the
 * dedicated TL surface and gates separately).
 */
@ApiTags('crm')
@Controller('agent')
@UseGuards(JwtAuthGuard, CapabilityGuard)
export class AgentWorkspaceController {
  constructor(private readonly workspace: AgentWorkspaceService) {}

  @Get('needs-attention')
  @RequireCapability('lead.read')
  @ApiOperation({ summary: 'Compact "needs attention now" feed for the calling agent' })
  needsAttention(@CurrentUser() user: AccessTokenClaims): Promise<NeedsAttentionResult> {
    return this.workspace.getNeedsAttention(user.sub);
  }
}
