import {
  BadRequestException,
  Body,
  Controller,
  Delete,
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
import type { ExportColumn, StructuredExport } from '../rbac/export-contract';
import { ExportGate } from '../rbac/export-gate.decorator';
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

  /**
   * Phase D5 — D5.6B: governed CSV export — full commission progress.
   *
   * Returns the structured shape; ExportInterceptor redacts +
   * serialises + audits + sets headers. Capability is the new
   * `partner.commission.export` (D5.6A) — distinct from the JSON
   * `partner.verification.read` cap that gates the per-lead
   * progress endpoint above. Roles with tenant.export got the
   * new cap automatically; sub-tenant.export roles need an
   * explicit grant to download.
   */
  @Get('partner/reports/commission-progress.csv')
  @RequireCapability('partner.commission.export')
  @ExportGate({
    primary: 'partner.commission',
    inherits: ['lead', 'captain', 'partner.verification'],
    format: 'csv',
    filename: () => `partner-commission-progress-${new Date().toISOString().slice(0, 10)}.csv`,
  })
  @ApiOperation({ summary: 'CSV: every active partner milestone progress row (governed)' })
  async exportProgress(@Query('partnerSourceId') partnerSourceId: string | undefined) {
    this.assertEnabled();
    const rows = await this.progress.listAllProgress({
      ...(partnerSourceId && { partnerSourceId }),
    });
    return buildStructuredCommissionExport(rows, false);
  }

  /**
   * Phase D5 — D5.6B: governed CSV export — at-risk only filter.
   * Same shape + capability as the progress export; the only
   * difference is the upstream `onlyAtRisk: true` filter.
   */
  @Get('partner/reports/commission-risk.csv')
  @RequireCapability('partner.commission.export')
  @ExportGate({
    primary: 'partner.commission',
    inherits: ['lead', 'captain', 'partner.verification'],
    format: 'csv',
    filename: () => `partner-commission-risk-${new Date().toISOString().slice(0, 10)}.csv`,
  })
  @ApiOperation({ summary: 'CSV: at-risk partner milestone rows only (governed)' })
  async exportRisk(@Query('partnerSourceId') partnerSourceId: string | undefined) {
    this.assertEnabled();
    const rows = await this.progress.listAllProgress({
      ...(partnerSourceId && { partnerSourceId }),
      onlyAtRisk: true,
    });
    return buildStructuredCommissionExport(rows, true);
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

/**
 * D5.6B — produce a `StructuredExport` for the commission progress /
 * risk CSVs. Column order, label spelling, and value formatting are
 * deliberately matched to the legacy `buildCsv` output so that an
 * un-redacted run under the new path is byte-identical to D5.5
 * (pinned by golden-file tests). `riskOnly` only affects the
 * comments preamble and the filename — the row set is filtered
 * upstream by the service.
 */
export function buildStructuredCommissionExport(
  rows: ReadonlyArray<{
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
): StructuredExport {
  const columns: ExportColumn[] = [
    { key: 'phone', label: 'phone', resource: 'lead', field: 'phone', sensitive: true },
    { key: 'crm_name', label: 'crm_name', resource: 'lead', field: 'name' },
    { key: 'crm_stage', label: 'crm_stage', resource: 'lead', field: 'lifecycleState' },
    {
      key: 'partner_source',
      label: 'partner_source',
      resource: 'partner.commission',
      field: 'partnerSourceName',
    },
    {
      key: 'config_code',
      label: 'config_code',
      resource: 'partner.commission',
      field: 'configCode',
    },
    {
      key: 'anchor_at',
      label: 'anchor_at',
      resource: 'partner.commission',
      field: 'anchorAt',
      sensitive: true,
    },
    {
      key: 'window_ends_at',
      label: 'window_ends_at',
      resource: 'partner.commission',
      field: 'windowEndsAt',
      sensitive: true,
    },
    {
      key: 'days_left',
      label: 'days_left',
      resource: 'partner.commission',
      field: 'daysLeft',
      sensitive: true,
    },
    {
      key: 'partner_trip_count',
      label: 'partner_trip_count',
      resource: 'partner.verification',
      field: 'tripCount',
      sensitive: true,
    },
    {
      key: 'target_trips',
      label: 'target_trips',
      resource: 'partner.commission',
      field: 'targetTrips',
      sensitive: true,
    },
    {
      key: 'current_milestone',
      label: 'current_milestone',
      resource: 'partner.commission',
      field: 'currentMilestone',
      sensitive: true,
    },
    {
      key: 'next_milestone',
      label: 'next_milestone',
      resource: 'partner.commission',
      field: 'nextMilestone',
      sensitive: true,
    },
    { key: 'risk', label: 'risk', resource: 'partner.commission', field: 'risk', sensitive: true },
    {
      key: 'needs_push',
      label: 'needs_push',
      resource: 'partner.commission',
      field: 'needsPush',
      sensitive: true,
    },
    { key: 'owner', label: 'owner', resource: 'lead', field: 'assignedToId' },
  ];

  return {
    format: 'csv',
    filename: `partner-commission-${riskOnly ? 'risk' : 'progress'}-${new Date()
      .toISOString()
      .slice(0, 10)}.csv`,
    comments: [
      `# Trade Way / Captain Masr CRM — partner commission ${riskOnly ? 'risk' : 'progress'} export`,
      `# generated: ${new Date().toISOString()}`,
    ],
    columns,
    rows: rows.map((row) => ({
      phone: row.phone,
      crm_name: row.crmName ?? '',
      crm_stage: row.crmStage ?? '',
      partner_source: row.projection.partnerSourceName,
      config_code: row.projection.configCode,
      anchor_at: row.projection.anchorAt ?? '',
      window_ends_at: row.projection.windowEndsAt ?? '',
      days_left: row.projection.daysLeft?.toString() ?? '',
      partner_trip_count: row.projection.tripCount?.toString() ?? '',
      target_trips: row.projection.targetTrips.toString(),
      current_milestone: row.projection.currentMilestone?.toString() ?? '',
      next_milestone: row.projection.nextMilestone?.toString() ?? '',
      risk: row.projection.risk,
      needs_push: row.projection.needsPush ? 'true' : 'false',
      owner: row.owner ?? '',
    })),
  };
}
