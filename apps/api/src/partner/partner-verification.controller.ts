import {
  BadRequestException,
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
import { ResourceFieldGate } from '../rbac/resource-field-gate.decorator';
import type { ScopeUserClaims } from '../rbac/scope-context.service';

import { isD4PartnerHubV1Enabled } from './d4-feature-flag';
import { PartnerMergeService } from './partner-merge.service';
import { PartnerVerificationService } from './partner-verification.service';

/**
 * D4.5 — Zod schema for the merge body. Closed list of mergeable
 * fields enforced at the parser boundary; `evidenceNote` capped at
 * 1 KB matching the LeadReview notes pattern.
 */
const MergePartnerFieldsSchema = z
  .object({
    partnerSourceId: z.string().uuid(),
    fields: z
      .array(z.enum(['active_date', 'dft_date']))
      .min(1)
      .max(2),
    evidenceNote: z.string().trim().max(1000).optional(),
  })
  .strict();
class MergePartnerFieldsDto extends createZodDto(MergePartnerFieldsSchema) {}

/**
 * D4.8 — Zod schema for the evidence-only attach body. Lets an
 * approver pin a partner snapshot record to a lead without
 * mutating any CRM column. Used by the ConvertConfirmModal so
 * the "Attach partner snapshot as evidence" toggle has a clean
 * API to call.
 */
const AttachEvidenceSchema = z
  .object({
    partnerSourceId: z.string().uuid(),
    partnerRecordId: z.string().uuid().optional(),
    partnerSnapshotId: z.string().uuid().optional(),
    notes: z.string().trim().max(1000).optional(),
  })
  .strict();
class AttachEvidenceDto extends createZodDto(AttachEvidenceSchema) {}

/**
 * Phase D4 — D4.4 → D4.5: PartnerVerification surface.
 *
 *   GET  /partner-verification/leads/:leadId
 *   GET  /partner-verification/leads/:leadId/evidence
 *   POST /partner-verification/leads/:leadId/merge
 *
 * Read endpoints behind `partner.verification.read`; merge behind
 * `partner.merge.write`. Sales / activation / driving agents hold
 * NEITHER capability in this build (D4.4 conservative default).
 *
 * Feature-flag gate is the same `partner.feature.disabled` shape
 * the rest of the partner surface uses.
 */
@ApiTags('partner')
@Controller('partner-verification')
@UseGuards(JwtAuthGuard, CapabilityGuard)
export class PartnerVerificationController {
  constructor(
    private readonly verification: PartnerVerificationService,
    private readonly merge: PartnerMergeService,
  ) {}

  @Get('leads/:leadId')
  @RequireCapability('partner.verification.read')
  @ResourceFieldGate('partner.verification')
  @ApiOperation({ summary: 'Partner verification projection for a lead' })
  forLead(
    @Param('leadId', new ParseUUIDPipe()) leadId: string,
    @Query('partnerSourceId') partnerSourceId: string | undefined,
    @Query('explicitCheck') explicitCheck: string | undefined,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    this.assertEnabled();
    const claims = this.toClaims(user);
    return this.verification.getForLead(leadId, claims, {
      ...(partnerSourceId && { partnerSourceId }),
      explicitCheck: explicitCheck === '1' || explicitCheck === 'true',
      actorUserId: user.sub,
    });
  }

  /**
   * D4.5 — list partner-related evidence rows on a lead. Surfaces
   * what merges / screenshots / notes are attached. Capability is
   * `partner.verification.read` so a TL inspecting a lead can see
   * the evidence chain even if they don't hold the merge cap.
   */
  @Get('leads/:leadId/evidence')
  @RequireCapability('partner.verification.read')
  @ResourceFieldGate('partner.evidence')
  @ApiOperation({ summary: 'List partner-related evidence rows attached to a lead' })
  evidence(
    @Param('leadId', new ParseUUIDPipe()) leadId: string,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    this.assertEnabled();
    return this.merge.listEvidenceForLead(leadId, this.toClaims(user));
  }

  /**
   * D4.5 — controlled merge. The body whitelist is enforced by the
   * Zod parser AND the service layer. One tx writes the captain
   * update + LeadEvidence + LeadActivity('partner_merge') + audit
   * row. NEVER touches `Captain.tripCount` or `CaptainTrip`.
   */
  @Post('leads/:leadId/merge')
  @RequireCapability('partner.merge.write')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Apply selected partner fields to the lead's captain (controlled merge with evidence + audit)",
  })
  mergePartner(
    @Param('leadId', new ParseUUIDPipe()) leadId: string,
    @Body() body: MergePartnerFieldsDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    this.assertEnabled();
    return this.merge.mergeFields({
      leadId,
      partnerSourceId: body.partnerSourceId,
      fields: body.fields,
      ...(body.evidenceNote && { evidenceNote: body.evidenceNote }),
      actorUserId: user.sub,
      userClaims: this.toClaims(user),
    });
  }

  /**
   * D4.8 — evidence-only attach. Pins a partner snapshot record
   * to a lead as `LeadEvidence` without mutating Captain or any
   * CRM column. Used by the convert-confirm modal so an approver
   * can leave a forensic trail without triggering a controlled
   * merge.
   *
   * Capability: `partner.evidence.write` (TLs / Ops / Account
   * Manager / Super Admin via TEAM_LEAD_EXTRAS + explicit grants).
   * Sales / activation / driving agents cannot reach this
   * endpoint by capability.
   */
  @Post('leads/:leadId/evidence')
  @RequireCapability('partner.evidence.write')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Attach a partner snapshot record as evidence on a lead (no Captain mutation, no merge)',
  })
  attachEvidence(
    @Param('leadId', new ParseUUIDPipe()) leadId: string,
    @Body() body: AttachEvidenceDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    this.assertEnabled();
    return this.merge.attachEvidence({
      leadId,
      partnerSourceId: body.partnerSourceId,
      ...(body.partnerRecordId && { partnerRecordId: body.partnerRecordId }),
      ...(body.partnerSnapshotId && { partnerSnapshotId: body.partnerSnapshotId }),
      ...(body.notes && { notes: body.notes }),
      actorUserId: user.sub,
      userClaims: this.toClaims(user),
    });
  }

  // ─── helpers ──────────────────────────────────────────────────

  private assertEnabled(): void {
    if (!isD4PartnerHubV1Enabled()) {
      throw new BadRequestException({
        code: 'partner.feature.disabled',
        message: 'Partner Data Hub is disabled in this environment.',
      });
    }
  }

  private toClaims(user: AccessTokenClaims): ScopeUserClaims {
    return { userId: user.sub, tenantId: user.tid, roleId: user.rid };
  }
}
