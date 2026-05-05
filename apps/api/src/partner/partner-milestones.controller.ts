import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { createZodDto } from 'nestjs-zod';

import { CurrentUser } from '../identity/current-user.decorator';
import { JwtAuthGuard } from '../identity/jwt-auth.guard';
import type { AccessTokenClaims } from '../identity/jwt.types';
import { CapabilityGuard } from '../rbac/capability.guard';
import { RequireCapability } from '../rbac/require-capability.decorator';
import type { ScopeUserClaims } from '../rbac/scope-context.service';

import { isD4PartnerHubV1Enabled } from './d4-feature-flag';
import {
  CreateMilestoneConfigSchema,
  ListMilestoneConfigsSchema,
  UpdateMilestoneConfigSchema,
} from './partner-milestone.dto';
import { PartnerMilestoneConfigsService } from './partner-milestone-configs.service';
import { PartnerMilestoneProgressService } from './partner-milestone-progress.service';

class CreateMilestoneConfigDto extends createZodDto(CreateMilestoneConfigSchema) {}
class UpdateMilestoneConfigDto extends createZodDto(UpdateMilestoneConfigSchema) {}
class ListMilestoneConfigsDto extends createZodDto(ListMilestoneConfigsSchema) {}

/**
 * Phase D4 — D4.7: Partner milestones — admin CRUD + progress
 * read + commission CSV exports.
 *
 *   GET    /partner-milestone-configs              — list (read)
 *   GET    /partner-milestone-configs/:id          — single
 *   POST   /partner-milestone-configs              — create
 *   PATCH  /partner-milestone-configs/:id          — update
 *   DELETE /partner-milestone-configs/:id          — soft-disable
 *   GET    /partner/milestones/leads/:leadId       — progress
 *   GET    /partner/reports/commission-progress.csv — full export
 *   GET    /partner/reports/commission-risk.csv     — at-risk only
 *
 * Capability matrix:
 *   • Reads: `partner.verification.read` (every TL+ already holds
 *     it; matches the read of the underlying snapshot data).
 *   • Writes: `partner.milestone.write` (Ops / Account Manager /
 *     Super Admin only; conservative default per D4.1).
 *   • Commission CSVs: `partner.reconciliation.read` — reuses the
 *     same gate as the reconciliation report so an Ops user sees
 *     a unified set of CSV exports.
 *
 * Feature-flag gate: every endpoint rejects with
 * `partner.feature.disabled` when the flag is off.
 */
@ApiTags('partner')
@Controller()
@UseGuards(JwtAuthGuard, CapabilityGuard)
export class PartnerMilestonesController {
  constructor(
    private readonly configs: PartnerMilestoneConfigsService,
    private readonly progress: PartnerMilestoneProgressService,
  ) {}

  // ─── milestone configs CRUD ──────────────────────────────────

  @Get('partner-milestone-configs')
  @RequireCapability('partner.verification.read')
  @ApiOperation({ summary: 'List partner milestone configs' })
  list(@Query() query: ListMilestoneConfigsDto) {
    this.assertEnabled();
    return this.configs.list(query);
  }

  @Get('partner-milestone-configs/:id')
  @RequireCapability('partner.verification.read')
  @ApiOperation({ summary: 'Get a partner milestone config' })
  findOne(@Param('id', new ParseUUIDPipe()) id: string) {
    this.assertEnabled();
    return this.configs.findById(id);
  }

  @Post('partner-milestone-configs')
  @RequireCapability('partner.milestone.write')
  @ApiOperation({ summary: 'Create a partner milestone config' })
  create(@Body() body: CreateMilestoneConfigDto, @CurrentUser() user: AccessTokenClaims) {
    this.assertEnabled();
    return this.configs.create(body, user.sub);
  }

  @Patch('partner-milestone-configs/:id')
  @RequireCapability('partner.milestone.write')
  @ApiOperation({ summary: 'Update a partner milestone config' })
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateMilestoneConfigDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    this.assertEnabled();
    return this.configs.update(id, body, user.sub);
  }

  @Delete('partner-milestone-configs/:id')
  @RequireCapability('partner.milestone.write')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Soft-disable a partner milestone config' })
  remove(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AccessTokenClaims) {
    this.assertEnabled();
    return this.configs.softDisable(id, user.sub);
  }

  // ─── progress + commission CSV ───────────────────────────────

  @Get('partner/milestones/leads/:leadId')
  @RequireCapability('partner.verification.read')
  @ApiOperation({ summary: 'Per-lead milestone progress projection (one entry per active config)' })
  progressForLead(
    @Param('leadId', new ParseUUIDPipe()) leadId: string,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    this.assertEnabled();
    return this.progress.forLead(leadId, this.toClaims(user));
  }

  @Get('partner/reports/commission-progress.csv')
  @RequireCapability('partner.reconciliation.read')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'CSV: every active partner milestone progress row' })
  async exportProgress(
    @Query('partnerSourceId') partnerSourceId: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    this.assertEnabled();
    const rows = await this.progress.listAllProgress({
      ...(partnerSourceId && { partnerSourceId }),
    });
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="partner-commission-progress-${new Date()
        .toISOString()
        .slice(0, 10)}.csv"`,
    );
    res.send(buildCsv(rows, false));
  }

  @Get('partner/reports/commission-risk.csv')
  @RequireCapability('partner.reconciliation.read')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'CSV: at-risk partner milestone rows only' })
  async exportRisk(
    @Query('partnerSourceId') partnerSourceId: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    this.assertEnabled();
    const rows = await this.progress.listAllProgress({
      ...(partnerSourceId && { partnerSourceId }),
      onlyAtRisk: true,
    });
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="partner-commission-risk-${new Date().toISOString().slice(0, 10)}.csv"`,
    );
    res.send(buildCsv(rows, true));
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

// ─── helpers ────────────────────────────────────────────────────────

function buildCsv(
  rows: Array<{
    phone: string;
    crmName: string | null;
    crmStage: string | null;
    owner: string | null;
    projection: {
      partnerSourceName: string;
      configCode: string;
      anchorAt: string | null;
      windowEndsAt: string | null;
      daysLeft: number | null;
      tripCount: number | null;
      targetTrips: number;
      currentMilestone: number | null;
      nextMilestone: number | null;
      risk: string;
      needsPush: boolean;
    };
  }>,
  riskOnly: boolean,
): string {
  const lines: string[] = [];
  lines.push(
    `# Trade Way / Captain Masr CRM — partner commission ${riskOnly ? 'risk' : 'progress'} export`,
  );
  lines.push(`# generated: ${new Date().toISOString()}`);
  lines.push(
    [
      'phone',
      'crm_name',
      'crm_stage',
      'partner_source',
      'config_code',
      'anchor_at',
      'window_ends_at',
      'days_left',
      'partner_trip_count',
      'target_trips',
      'current_milestone',
      'next_milestone',
      'risk',
      'needs_push',
      'owner',
    ].join(','),
  );
  for (const row of rows) {
    lines.push(
      [
        csvEscape(row.phone),
        csvEscape(row.crmName ?? ''),
        csvEscape(row.crmStage ?? ''),
        csvEscape(row.projection.partnerSourceName),
        csvEscape(row.projection.configCode),
        csvEscape(row.projection.anchorAt ?? ''),
        csvEscape(row.projection.windowEndsAt ?? ''),
        row.projection.daysLeft?.toString() ?? '',
        row.projection.tripCount?.toString() ?? '',
        row.projection.targetTrips.toString(),
        row.projection.currentMilestone?.toString() ?? '',
        row.projection.nextMilestone?.toString() ?? '',
        row.projection.risk,
        row.projection.needsPush ? 'true' : 'false',
        csvEscape(row.owner ?? ''),
      ].join(','),
    );
  }
  return lines.join('\n');
}

function csvEscape(s: string): string {
  if (!s) return '';
  const t = String(s);
  if (/[",\n]/.test(t)) return `"${t.replace(/"/g, '""')}"`;
  return t;
}
