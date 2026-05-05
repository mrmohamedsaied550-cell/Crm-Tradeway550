import {
  BadRequestException,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../identity/current-user.decorator';
import { JwtAuthGuard } from '../identity/jwt-auth.guard';
import type { AccessTokenClaims } from '../identity/jwt.types';
import { CapabilityGuard } from '../rbac/capability.guard';
import { RequireCapability } from '../rbac/require-capability.decorator';
import type { ScopeUserClaims } from '../rbac/scope-context.service';

import { isD4PartnerHubV1Enabled } from './d4-feature-flag';
import { PartnerVerificationService } from './partner-verification.service';

/**
 * Phase D4 — D4.4: PartnerVerification read-only surface.
 *
 *   GET /partner-verification/leads/:leadId
 *     ?partnerSourceId  — narrow to one source (optional).
 *     ?explicitCheck=1  — operator-initiated "Check now" action.
 *                          Adds a `partner.verification.checked`
 *                          audit row. Default page-load reads
 *                          DON'T audit (would be too chatty).
 *
 * Capability: `partner.verification.read`. Sales / activation /
 * driving agents do NOT hold this in D4.4 (intentional conservative
 * default — D4.4 plan §7). TLs / Ops / AM / Super Admin can read.
 */
@ApiTags('partner')
@Controller('partner-verification')
@UseGuards(JwtAuthGuard, CapabilityGuard)
export class PartnerVerificationController {
  constructor(private readonly verification: PartnerVerificationService) {}

  @Get('leads/:leadId')
  @RequireCapability('partner.verification.read')
  @ApiOperation({ summary: 'Partner verification projection for a lead' })
  forLead(
    @Param('leadId', new ParseUUIDPipe()) leadId: string,
    @Query('partnerSourceId') partnerSourceId: string | undefined,
    @Query('explicitCheck') explicitCheck: string | undefined,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    this.assertEnabled();
    const claims: ScopeUserClaims = {
      userId: user.sub,
      tenantId: user.tid,
      roleId: user.rid,
    };
    return this.verification.getForLead(leadId, claims, {
      ...(partnerSourceId && { partnerSourceId }),
      explicitCheck: explicitCheck === '1' || explicitCheck === 'true',
      actorUserId: user.sub,
    });
  }

  private assertEnabled(): void {
    if (!isD4PartnerHubV1Enabled()) {
      throw new BadRequestException({
        code: 'partner.feature.disabled',
        message: 'Partner Data Hub is disabled in this environment.',
      });
    }
  }
}
