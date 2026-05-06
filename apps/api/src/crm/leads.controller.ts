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

import { JwtAuthGuard } from '../identity/jwt-auth.guard';
import { CurrentUser } from '../identity/current-user.decorator';
import type { AccessTokenClaims } from '../identity/jwt.types';
import { CapabilityGuard } from '../rbac/capability.guard';
import { RequireCapability } from '../rbac/require-capability.decorator';
import { ResourceFieldGate } from '../rbac/resource-field-gate.decorator';
import type { ScopeUserClaims } from '../rbac/scope-context.service';

/**
 * Phase C — C3: shrink the AccessTokenClaims to the trio LeadsService
 * needs for scope resolution. Keeps the service signature decoupled
 * from the JWT shape — feature modules outside identity don't have
 * to depend on the full claims type.
 */
function claimsToScope(claims: AccessTokenClaims): ScopeUserClaims {
  return { userId: claims.sub, tenantId: claims.tid, roleId: claims.rid };
}

import { LeadsService } from './leads.service';
import { CaptainsService } from './captains.service';
import { isD3EngineV1Enabled } from './d3-feature-flag';
import { LeadStageStatusService } from './lead-stage-status.service';
import { SetStageStatusSchema } from './lead-stage-status.dto';
import { PipelineService } from './pipeline.service';
import { RotationService } from './rotation.service';
import { SlaService } from './sla.service';
import {
  AddActivitySchema,
  AssignLeadSchema,
  BulkAssignSchema,
  BulkDeleteSchema,
  BulkMoveStageSchema,
  ConvertLeadSchema,
  CreateLeadSchema,
  ListLeadsByStageQuerySchema,
  ListLeadsQuerySchema,
  MoveStageSchema,
  RotateLeadSchema,
  UpdateLeadSchema,
} from './leads.dto';

class RotateLeadDto extends createZodDto(RotateLeadSchema) {}
class SetStageStatusDto extends createZodDto(SetStageStatusSchema) {}
class CreateLeadDto extends createZodDto(CreateLeadSchema) {}
class UpdateLeadDto extends createZodDto(UpdateLeadSchema) {}
class AssignLeadDto extends createZodDto(AssignLeadSchema) {}
class MoveStageDto extends createZodDto(MoveStageSchema) {}
class AddActivityDto extends createZodDto(AddActivitySchema) {}
class ConvertLeadDto extends createZodDto(ConvertLeadSchema) {}
class ListLeadsQueryDto extends createZodDto(ListLeadsQuerySchema) {}
class ListLeadsByStageQueryDto extends createZodDto(ListLeadsByStageQuerySchema) {}
class BulkAssignDto extends createZodDto(BulkAssignSchema) {}
class BulkMoveStageDto extends createZodDto(BulkMoveStageSchema) {}
class BulkDeleteDto extends createZodDto(BulkDeleteSchema) {}

/**
 * /api/v1/leads — full Lead lifecycle behind JwtAuthGuard.
 *
 * All routes require an access token; the tenant scope comes from the
 * verified `tid` claim via the existing tenant-context middleware. The
 * pipeline-stages catalogue is exposed as a sibling controller so the UI
 * can render dropdowns without hard-coding stage codes.
 */
@ApiTags('crm')
@Controller()
@UseGuards(JwtAuthGuard, CapabilityGuard)
export class LeadsController {
  constructor(
    private readonly leads: LeadsService,
    private readonly captains: CaptainsService,
    private readonly pipeline: PipelineService,
    private readonly sla: SlaService,
    /** Phase D3 — D3.3: stage-specific status surface. */
    private readonly stageStatus: LeadStageStatusService,
    /** Phase D3 — D3.4: lead rotation engine. */
    private readonly rotation: RotationService,
  ) {}

  @Get('pipeline/stages')
  @RequireCapability('pipeline.read')
  @ApiOperation({ summary: 'List the pipeline stages for the active tenant' })
  listStages() {
    return this.pipeline.list();
  }

  @Post('leads')
  @RequireCapability('lead.write')
  @ApiOperation({ summary: 'Create a lead (phone normalised to E.164)' })
  create(@Body() body: CreateLeadDto, @CurrentUser() user: AccessTokenClaims) {
    return this.leads.create(body, user.sub, claimsToScope(user));
  }

  @Get('leads')
  @RequireCapability('lead.read')
  @ResourceFieldGate('lead')
  @ApiOperation({ summary: 'List leads with filters + pagination' })
  list(@Query() query: ListLeadsQueryDto, @CurrentUser() user: AccessTokenClaims) {
    return this.leads.list(query, claimsToScope(user));
  }

  /**
   * Phase 1B — Kanban grouped query. Returns one bucket per stage
   * of the requested pipeline, each bucket carrying its totalCount
   * and the first `perStage` cards. Drives the workspace board with
   * a single round-trip.
   */
  @Get('leads/by-stage')
  @RequireCapability('lead.read')
  @ApiOperation({ summary: 'Group leads by pipeline stage (Kanban view)' })
  listByStage(@Query() query: ListLeadsByStageQueryDto, @CurrentUser() user: AccessTokenClaims) {
    return this.leads.listByStage(query, claimsToScope(user));
  }

  @Get('leads/overdue')
  @RequireCapability('lead.read')
  @ApiOperation({ summary: 'Overdue leads (pending follow-up dueAt < now)' })
  listOverdue(
    @Query('assignedToId') assignedToId: string | undefined,
    @Query('mine') mine: string | undefined,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    const filter = assignedToId ?? (mine === '0' ? undefined : user.sub);
    return this.leads.listOverdue({ assignedToId: filter }, claimsToScope(user));
  }

  @Get('leads/due-today')
  @RequireCapability('lead.read')
  @ApiOperation({ summary: 'Leads with a pending follow-up due today' })
  listDueToday(
    @Query('assignedToId') assignedToId: string | undefined,
    @Query('mine') mine: string | undefined,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    const filter = assignedToId ?? (mine === '0' ? undefined : user.sub);
    return this.leads.listDueToday({ assignedToId: filter }, claimsToScope(user));
  }

  @Get('leads/:id')
  @RequireCapability('lead.read')
  @ResourceFieldGate('lead')
  @ApiOperation({ summary: 'Get a lead by id (scope-aware)' })
  findOne(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AccessTokenClaims) {
    return this.leads.findByIdInScopeOrThrow(id, claimsToScope(user));
  }

  @Patch('leads/:id')
  @RequireCapability('lead.write')
  @ApiOperation({ summary: 'Update lead fields (name / phone / email / source)' })
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateLeadDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    return this.leads.update(id, body, user.sub, claimsToScope(user));
  }

  @Delete('leads/:id')
  @RequireCapability('lead.write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a lead and all its activities' })
  async remove(@Param('id', new ParseUUIDPipe()) id: string): Promise<void> {
    await this.leads.delete(id);
  }

  @Post('leads/:id/assign')
  @RequireCapability('lead.assign')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Assign or unassign the lead' })
  assign(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: AssignLeadDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    return this.leads.assign(id, body.assignedToId, user.sub, claimsToScope(user));
  }

  @Post('leads/:id/auto-assign')
  @RequireCapability('lead.assign')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Auto-assign the lead via round-robin' })
  autoAssign(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AccessTokenClaims) {
    return this.leads.autoAssign(id, user.sub);
  }

  @Post('sla/run-breaches')
  @RequireCapability('lead.assign')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Scan SLA-breached leads and round-robin reassign them' })
  runSlaBreaches(@CurrentUser() user: AccessTokenClaims) {
    return this.sla.runReassignmentForBreaches(user.sub);
  }

  @Post('leads/:id/stage')
  @RequireCapability('lead.stage.move')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Move the lead to a different pipeline stage' })
  moveStage(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: MoveStageDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    return this.leads.moveStage(
      id,
      {
        ...(body.pipelineStageId
          ? { pipelineStageId: body.pipelineStageId }
          : { stageCode: body.stageCode! }),
        // Phase A — lostReasonId / lostNote are optional at the DTO
        // level; the service rejects when the target stage's
        // terminalKind is 'lost' and they're missing (or vice versa).
        ...(body.lostReasonId !== undefined && { lostReasonId: body.lostReasonId }),
        ...(body.lostNote !== undefined && { lostNote: body.lostNote }),
      },
      user.sub,
    );
  }

  /**
   * Phase D2 — D2.5: list every attempt for the contact behind this
   * lead, scope-filtered against the calling user. Powers the lead-
   * detail "Attempts history" card and the WhatsApp side-panel
   * "N attempts on this contact" line.
   *
   * Capability: `lead.read`. Same scope contract as the rest of the
   * lead-detail surface — out-of-scope predecessors are NOT leaked;
   * the response carries a `outOfScopeCount` so the UI can surface
   * "N previous attempts are outside your access." without
   * disclosing any of those attempts' fields.
   */
  @Get('leads/:id/attempts')
  @RequireCapability('lead.read')
  @ApiOperation({ summary: 'List every scoped attempt for the contact behind this lead' })
  attempts(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AccessTokenClaims) {
    return this.leads.listAttemptsForLeadInScope(id, claimsToScope(user));
  }

  @Get('leads/:id/activities')
  @RequireCapability('lead.read')
  @ResourceFieldGate('lead.activity')
  @ApiOperation({ summary: 'Activity timeline for the lead' })
  activities(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AccessTokenClaims) {
    return this.leads.listActivities(id, claimsToScope(user));
  }

  /**
   * Phase D2 — D2.6: manual reactivation override.
   *
   * Forces a fresh attempt for a closed predecessor. Requires
   * `lead.reactivate` (granted to ops_manager / account_manager /
   * super_admin by default — sales agents and TLs cannot trigger).
   *
   * Returns the new attempt's id + index so the UI can redirect the
   * operator to the new lead detail page on success. Emits a
   * `lead.reactivated` audit verb in addition to the standard
   * `lead.duplicate_decision` row.
   */
  @Post('leads/:id/reactivate')
  @RequireCapability('lead.reactivate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Manually reactivate a closed lead (creates a new attempt)' })
  reactivate(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AccessTokenClaims) {
    return this.leads.manualReactivate(id, user.sub, claimsToScope(user));
  }

  /**
   * Phase D3 — D3.3: stage-specific status surface.
   *
   * GET — returns `{ stage, currentStatus, allowedStatuses, history }`
   * for the lead's CURRENT stage. Capability: `lead.read` (everyone
   * who can see the lead can see its statuses; the read is purely
   * informational, no PII / owner identity gated).
   *
   * POST — records a new status. Capability: `lead.stage.status.write`
   * (sales / activation / driving agents + TLs + ops + super_admin).
   * Body: `{ status: <code from allowedStatuses>, notes?: string }`.
   * Validates the status against the stage's catalogue; rejects with
   * `lead.stage.status.invalid` on a code that isn't configured.
   */
  @Get('leads/:id/stage-statuses')
  @RequireCapability('lead.read')
  @ApiOperation({ summary: 'List stage-status history + allowed-statuses for a lead' })
  listStageStatuses(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    return this.stageStatus.listForLead(id, claimsToScope(user));
  }

  @Post('leads/:id/stage-status')
  @RequireCapability('lead.stage.status.write')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Record a stage-specific status on the lead' })
  setStageStatus(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: SetStageStatusDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    return this.stageStatus.setStatus(
      id,
      { status: body.status, ...(body.notes !== undefined && { notes: body.notes }) },
      user.sub,
      claimsToScope(user),
    );
  }

  /**
   * Phase D3 — D3.4: lead rotation surface.
   *
   * `POST /leads/:id/rotate` — capability `lead.rotate` (TLs / ops /
   * account_manager / super_admin). Body picks `handoverMode` (full
   * / summary / clean) and optional `toUserId`, `reasonCode`,
   * `notes`. Rejects with `lead.rotate.disabled` when D3_ENGINE_V1
   * resolves false (the engine + log are dormant under flag-off so
   * legacy behaviour stays byte-identical).
   *
   * `GET /leads/:id/rotations` — capability `lead.read` (any caller
   * who can see the lead). Service-side visibility gate sanitises
   * `fromUser` / `toUser` / `actor` / `notes` for callers without
   * `lead.write` (D2.6 pattern). The `canSeeOwners` flag in the
   * response body lets the frontend render neutral copy without
   * second-guessing the redaction.
   */
  @Post('leads/:id/rotate')
  @RequireCapability('lead.rotate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rotate a lead to a different owner (audited)' })
  rotate(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: RotateLeadDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    if (!isD3EngineV1Enabled()) {
      throw new BadRequestException({
        code: 'lead.rotate.disabled',
        message: 'Rotation is disabled in this environment.',
      });
    }
    // Manual rotation through this endpoint is always recorded as
    // `manual_tl` — the distinction between TL and Ops triggers is
    // a reporting concern that can be derived later from
    // `actorUserId`'s role. Keeping a single trigger here avoids
    // a per-request DB role lookup.
    return this.rotation.rotateLead({
      leadId: id,
      trigger: 'manual_tl',
      handoverMode: body.handoverMode,
      ...(body.toUserId !== undefined && { toUserId: body.toUserId }),
      ...(body.reasonCode !== undefined && { reasonCode: body.reasonCode }),
      ...(body.notes !== undefined && { notes: body.notes }),
      actorUserId: user.sub,
      userClaims: claimsToScope(user),
    });
  }

  @Get('leads/:id/rotations')
  @RequireCapability('lead.read')
  @ResourceFieldGate('rotation')
  @ApiOperation({ summary: 'List rotation history for a lead (visibility-gated)' })
  listRotations(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    return this.rotation.listRotationsForLead(id, claimsToScope(user));
  }

  @Post('leads/:id/activities')
  @RequireCapability('lead.activity.write')
  @ApiOperation({ summary: 'Append a note or call activity' })
  addActivity(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: AddActivityDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    return this.leads.addActivity(id, body, user.sub);
  }

  @Post('leads/:id/convert')
  @RequireCapability('lead.convert')
  @ApiOperation({ summary: 'Convert the lead to a Captain' })
  convert(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: ConvertLeadDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    return this.captains.convertFromLead(id, body, user.sub);
  }

  /**
   * Phase A — A3: reverse a conversion. Allowed only when the
   * captain has zero recorded trips (operational safety).
   * Deletes the captain row, moves the lead back to its pipeline's
   * first non-terminal stage, flips lifecycleState back to 'open',
   * and writes a `system` activity with `event: 'unconverted'`.
   */
  @Post('leads/:id/unconvert')
  @RequireCapability('lead.convert')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reverse a Lead → Captain conversion (admin undo)' })
  unconvert(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AccessTokenClaims) {
    return this.captains.unconvertFromLead(id, user.sub);
  }

  // ─── P3-05 — bulk actions ───
  // Each endpoint accepts up to 100 lead ids per call (the schema
  // enforces) and returns `{ updated, failed }` so the UI can show
  // both halves of a partial outcome without making the operator
  // re-issue the whole batch on a single bad row.

  @Post('leads/bulk-assign')
  @RequireCapability('lead.assign')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Assign or unassign multiple leads in one call' })
  bulkAssign(@Body() body: BulkAssignDto, @CurrentUser() user: AccessTokenClaims) {
    return this.leads.bulkAssign(body, user.sub);
  }

  @Post('leads/bulk-stage')
  @RequireCapability('lead.stage.move')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Move multiple leads to the same pipeline stage' })
  bulkStage(@Body() body: BulkMoveStageDto, @CurrentUser() user: AccessTokenClaims) {
    return this.leads.bulkMoveStage(body, user.sub);
  }

  @Post('leads/bulk-delete')
  @RequireCapability('lead.write')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete multiple leads (and their activities) in one call' })
  bulkDelete(@Body() body: BulkDeleteDto) {
    return this.leads.bulkDelete(body);
  }
}
