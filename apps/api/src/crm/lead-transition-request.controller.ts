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
import { z } from 'zod';

import { CurrentUser } from '../identity/current-user.decorator';
import { JwtAuthGuard } from '../identity/jwt-auth.guard';
import type { AccessTokenClaims } from '../identity/jwt.types';
import { CapabilityGuard } from '../rbac/capability.guard';
import { RequireCapability } from '../rbac/require-capability.decorator';
import type { ScopeUserClaims } from '../rbac/scope-context.service';

import { LeadTransitionRequestService } from './lead-transition-request.service';

/** Mirrors the helper inlined in leads.controller.ts — keeps the
 *  request flow decoupled from leads.controller's private scope. */
function claimsToScope(claims: AccessTokenClaims): ScopeUserClaims {
  return { userId: claims.sub, tenantId: claims.tid, roleId: claims.rid };
}

/**
 * Sprint 3 (D7.1) — REST surface for the stage-transition
 * approval workflow.
 *
 *   POST /api/v1/leads/:leadId/transition-requests
 *     - Body: { toStageId, requestedStatusCode?, notes?,
 *               communicationMethod?, reasonCode?, reasonText? }
 *     - Capability: `lead.transition.request`
 *     - Scope: requester must already see the lead
 *
 *   GET  /api/v1/leads/:leadId/transition-requests
 *     - Returns the lead's request history (newest first).
 *     - Capability: `lead.read`
 *
 *   POST /api/v1/lead-transition-requests/:id/approve
 *     - Body: { notes? }
 *     - Capability: `lead.transition.approve`
 *
 *   POST /api/v1/lead-transition-requests/:id/reject
 *     - Body: { reason: string, correctiveActionTitle?, correctiveDueAt? }
 *     - Capability: `lead.transition.approve`
 *     - Rejection reason is REQUIRED — service-side enforced.
 *
 *   POST /api/v1/lead-transition-requests/:id/cancel
 *     - Capability: `lead.transition.request`
 *     - Service rejects when caller isn't the original requester.
 */

const RequestSchema = z
  .object({
    toStageId: z.string().uuid(),
    requestedStatusCode: z.string().trim().min(1).max(64).optional(),
    communicationMethod: z
      .enum(['call', 'whatsapp', 'sms', 'manual', 'partner_sheet', 'system'])
      .optional(),
    notes: z.string().trim().max(2000).optional(),
    reasonCode: z.string().trim().max(128).optional(),
    reasonText: z.string().trim().max(1000).optional(),
  })
  .strict();
class RequestDto extends createZodDto(RequestSchema) {}

const ApproveSchema = z
  .object({
    notes: z.string().trim().max(2000).optional(),
  })
  .strict();
class ApproveDto extends createZodDto(ApproveSchema) {}

const RejectSchema = z
  .object({
    reason: z.string().trim().min(1).max(1000),
    correctiveActionTitle: z.string().trim().min(1).max(160).optional(),
    correctiveDueAt: z.string().datetime().optional(),
  })
  .strict();
class RejectDto extends createZodDto(RejectSchema) {}

@ApiTags('crm')
@Controller()
@UseGuards(JwtAuthGuard, CapabilityGuard)
export class LeadTransitionRequestController {
  constructor(private readonly service: LeadTransitionRequestService) {}

  @Post('leads/:leadId/transition-requests')
  @RequireCapability('lead.transition.request')
  @ApiOperation({ summary: 'Submit a stage-transition request for approval (Sprint 3)' })
  request(
    @Param('leadId', new ParseUUIDPipe()) leadId: string,
    @Body() body: RequestDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    return this.service.request(
      {
        leadId,
        toStageId: body.toStageId,
        requestedStatusCode: body.requestedStatusCode ?? null,
        communicationMethod: body.communicationMethod ?? null,
        notes: body.notes ?? null,
        reasonCode: body.reasonCode ?? null,
        reasonText: body.reasonText ?? null,
      },
      claimsToScope(user),
    );
  }

  @Get('leads/:leadId/transition-requests')
  @RequireCapability('lead.read')
  @ApiOperation({ summary: 'List transition requests for a lead, newest first (Sprint 3)' })
  list(
    @Param('leadId', new ParseUUIDPipe()) leadId: string,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    return this.service.listForLead(leadId, claimsToScope(user));
  }

  /**
   * Sprint 5 — the calling user's transition requests across all
   * leads, used by the Sales Dashboard / TL Dashboard for the
   * "Returned to Me" + "Waiting Approval" queues.
   */
  @Get('lead-transition-requests/mine')
  @RequireCapability('lead.transition.request')
  @ApiOperation({ summary: 'List my transition requests (Sprint 5)' })
  listMineAsRequester(
    @CurrentUser() user: AccessTokenClaims,
    @Query('state') state?: 'pending' | 'rejected' | 'approved' | 'cancelled',
  ) {
    return this.service.listForUser(claimsToScope(user), { role: 'requester', state });
  }

  /**
   * Sprint 5 — pending requests where the caller is in-scope as
   * approver. Gated on `lead.transition.approve`; today the
   * service returns the tenant's pending queue (RLS scoped),
   * tightened in a later sprint when team-leader signal is
   * formalised.
   */
  @Get('lead-transition-requests/approver-queue')
  @RequireCapability('lead.transition.approve')
  @ApiOperation({ summary: 'List pending transition requests I can approve (Sprint 5)' })
  listMineAsApprover(@CurrentUser() user: AccessTokenClaims) {
    return this.service.listForUser(claimsToScope(user), {
      role: 'approver',
      state: 'pending',
    });
  }

  @Post('lead-transition-requests/:id/approve')
  @RequireCapability('lead.transition.approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve a pending transition request (Sprint 3)' })
  async approve(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: ApproveDto,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<{ ok: true }> {
    await this.service.approve(id, { notes: body.notes ?? null }, claimsToScope(user));
    return { ok: true };
  }

  @Post('lead-transition-requests/:id/reject')
  @RequireCapability('lead.transition.approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reject a pending transition request with a required reason (Sprint 3)',
  })
  async reject(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: RejectDto,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<{ ok: true }> {
    await this.service.reject(
      id,
      {
        reason: body.reason,
        correctiveActionTitle: body.correctiveActionTitle ?? null,
        correctiveDueAt: body.correctiveDueAt ?? null,
      },
      claimsToScope(user),
    );
    return { ok: true };
  }

  @Post('lead-transition-requests/:id/cancel')
  @RequireCapability('lead.transition.request')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel a pending transition request (requester only) (Sprint 3)' })
  async cancel(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<{ ok: true }> {
    await this.service.cancel(id, claimsToScope(user));
    return { ok: true };
  }
}
