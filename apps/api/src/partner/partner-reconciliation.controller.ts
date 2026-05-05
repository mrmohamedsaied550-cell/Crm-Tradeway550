import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { CurrentUser } from '../identity/current-user.decorator';
import { JwtAuthGuard } from '../identity/jwt-auth.guard';
import type { AccessTokenClaims } from '../identity/jwt.types';
import { CapabilityGuard } from '../rbac/capability.guard';
import { RequireCapability } from '../rbac/require-capability.decorator';
import type { ScopeUserClaims } from '../rbac/scope-context.service';

import { isD4PartnerHubV1Enabled } from './d4-feature-flag';
import {
  PartnerReconciliationService,
  type ReconciliationCategory,
} from './partner-reconciliation.service';

const ReconciliationCategorySchema = z.enum([
  'partner_missing',
  'partner_active_not_in_crm',
  'partner_date_mismatch',
  'partner_dft_mismatch',
  'partner_trips_mismatch',
]);

const OpenReviewSchema = z
  .object({
    category: ReconciliationCategorySchema,
    leadId: z.string().uuid(),
    partnerSourceId: z.string().uuid(),
    partnerRecordId: z.string().uuid().optional(),
    notes: z.string().trim().max(1000).optional(),
  })
  .strict();
class OpenReviewDto extends createZodDto(OpenReviewSchema) {}

/**
 * Phase D4 — D4.6: Partner reconciliation read + export + open-review.
 *
 *   GET  /partner/reconciliation                 — JSON list with counts.
 *   GET  /partner/reconciliation/export.csv      — CSV export.
 *   POST /partner/reconciliation/open-review     — promote a discrepancy
 *                                                  into the TL Review
 *                                                  Queue (idempotent).
 *
 * Read endpoints behind `partner.reconciliation.read`. The
 * open-review action behind `partner.reconciliation.resolve`.
 * Sales / activation / driving agents hold neither (D4.4 / D4.5
 * conservative defaults preserved).
 */
@ApiTags('partner')
@Controller('partner/reconciliation')
@UseGuards(JwtAuthGuard, CapabilityGuard)
export class PartnerReconciliationController {
  constructor(private readonly reconciliation: PartnerReconciliationService) {}

  @Get()
  @RequireCapability('partner.reconciliation.read')
  @ApiOperation({ summary: 'List partner reconciliation discrepancies' })
  list(
    @Query('partnerSourceId') partnerSourceId: string | undefined,
    @Query('companyId') companyId: string | undefined,
    @Query('countryId') countryId: string | undefined,
    @Query('category') category: string | undefined,
    @Query('limit') limit: string | undefined,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    this.assertEnabled();
    const lim = limit ? Math.min(Math.max(Number.parseInt(limit, 10) || 200, 1), 1000) : 200;
    const cat = parseCategory(category);
    return this.reconciliation.list(
      {
        ...(partnerSourceId && { partnerSourceId }),
        ...(companyId && { companyId }),
        ...(countryId && { countryId }),
        ...(cat && { category: cat }),
        limit: lim,
      },
      this.toClaims(user),
    );
  }

  @Get('export.csv')
  @RequireCapability('partner.reconciliation.read')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'CSV export of partner reconciliation discrepancies' })
  async exportCsv(
    @Query('partnerSourceId') partnerSourceId: string | undefined,
    @Query('companyId') companyId: string | undefined,
    @Query('countryId') countryId: string | undefined,
    @Query('category') category: string | undefined,
    @CurrentUser() user: AccessTokenClaims,
    @Res() res: Response,
  ): Promise<void> {
    this.assertEnabled();
    const cat = parseCategory(category);
    const csv = await this.reconciliation.exportCsv(
      {
        ...(partnerSourceId && { partnerSourceId }),
        ...(companyId && { companyId }),
        ...(countryId && { countryId }),
        ...(cat && { category: cat }),
      },
      this.toClaims(user),
    );
    const filename = `partner-reconciliation-${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  }

  @Post('open-review')
  @RequireCapability('partner.reconciliation.resolve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Promote a partner reconciliation discrepancy into the TL Review Queue (idempotent)',
  })
  openReview(@Body() body: OpenReviewDto, @CurrentUser() user: AccessTokenClaims) {
    this.assertEnabled();
    return this.reconciliation.openReview(
      {
        category: body.category,
        leadId: body.leadId,
        partnerSourceId: body.partnerSourceId,
        ...(body.partnerRecordId && { partnerRecordId: body.partnerRecordId }),
        ...(body.notes && { notes: body.notes }),
        actorUserId: user.sub,
      },
      this.toClaims(user),
    );
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

function parseCategory(raw: string | undefined): ReconciliationCategory | undefined {
  if (!raw) return undefined;
  const parsed = ReconciliationCategorySchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}
