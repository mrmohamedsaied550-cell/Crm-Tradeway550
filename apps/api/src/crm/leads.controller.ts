import {
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

import { LeadsService } from './leads.service';
import { CaptainsService } from './captains.service';
import { PipelineService } from './pipeline.service';
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
  UpdateLeadSchema,
} from './leads.dto';

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
    return this.leads.create(body, user.sub);
  }

  @Get('leads')
  @RequireCapability('lead.read')
  @ApiOperation({ summary: 'List leads with filters + pagination' })
  list(@Query() query: ListLeadsQueryDto) {
    return this.leads.list(query);
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
  listByStage(@Query() query: ListLeadsByStageQueryDto) {
    return this.leads.listByStage(query);
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
    return this.leads.listOverdue({ assignedToId: filter });
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
    return this.leads.listDueToday({ assignedToId: filter });
  }

  @Get('leads/:id')
  @RequireCapability('lead.read')
  @ApiOperation({ summary: 'Get a lead by id' })
  findOne(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.leads.findByIdOrThrow(id);
  }

  @Patch('leads/:id')
  @RequireCapability('lead.write')
  @ApiOperation({ summary: 'Update lead fields (name / phone / email / source)' })
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateLeadDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    return this.leads.update(id, body, user.sub);
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
    return this.leads.assign(id, body.assignedToId, user.sub);
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
      body.pipelineStageId
        ? { pipelineStageId: body.pipelineStageId }
        : { stageCode: body.stageCode! },
      user.sub,
    );
  }

  @Get('leads/:id/activities')
  @RequireCapability('lead.read')
  @ApiOperation({ summary: 'Activity timeline for the lead' })
  activities(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.leads.listActivities(id);
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
