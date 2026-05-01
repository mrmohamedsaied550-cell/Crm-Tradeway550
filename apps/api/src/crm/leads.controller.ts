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

import { LeadsService } from './leads.service';
import { CaptainsService } from './captains.service';
import { PipelineService } from './pipeline.service';
import { SlaService } from './sla.service';
import {
  AddActivitySchema,
  AssignLeadSchema,
  ConvertLeadSchema,
  CreateLeadSchema,
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
@UseGuards(JwtAuthGuard)
export class LeadsController {
  constructor(
    private readonly leads: LeadsService,
    private readonly captains: CaptainsService,
    private readonly pipeline: PipelineService,
    private readonly sla: SlaService,
  ) {}

  // ───────── pipeline catalogue ─────────

  @Get('pipeline/stages')
  @ApiOperation({ summary: 'List the pipeline stages for the active tenant' })
  listStages() {
    return this.pipeline.list();
  }

  // ───────── leads CRUD ─────────

  @Post('leads')
  @ApiOperation({ summary: 'Create a lead (phone normalised to E.164)' })
  create(@Body() body: CreateLeadDto, @CurrentUser() user: AccessTokenClaims) {
    return this.leads.create(body, user.sub);
  }

  @Get('leads')
  @ApiOperation({ summary: 'List leads with filters + pagination' })
  list(@Query() query: ListLeadsQueryDto) {
    return this.leads.list(query);
  }

  /**
   * C37 — leads whose pending follow-up is past its dueAt. Defaults
   * to the calling user's worklist; pass `assignedToId=…` (or `mine=0`)
   * to override / broaden.
   */
  @Get('leads/overdue')
  @ApiOperation({ summary: 'Overdue leads (pending follow-up dueAt < now)' })
  listOverdue(
    @Query('assignedToId') assignedToId: string | undefined,
    @Query('mine') mine: string | undefined,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    const filter = assignedToId ?? (mine === '0' ? undefined : user.sub);
    return this.leads.listOverdue({ assignedToId: filter });
  }

  /**
   * C37 — leads whose pending follow-up falls within today's window.
   * Same defaults as /leads/overdue.
   */
  @Get('leads/due-today')
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
  @ApiOperation({ summary: 'Get a lead by id' })
  findOne(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.leads.findByIdOrThrow(id);
  }

  @Patch('leads/:id')
  @ApiOperation({ summary: 'Update lead fields (name / phone / email / source)' })
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateLeadDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    return this.leads.update(id, body, user.sub);
  }

  @Delete('leads/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a lead and all its activities' })
  async remove(@Param('id', new ParseUUIDPipe()) id: string): Promise<void> {
    await this.leads.delete(id);
  }

  // ───────── lead actions ─────────

  @Post('leads/:id/assign')
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
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Auto-assign the lead via round-robin' })
  autoAssign(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AccessTokenClaims) {
    return this.leads.autoAssign(id, user.sub);
  }

  @Post('sla/run-breaches')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Scan SLA-breached leads and round-robin reassign them',
  })
  runSlaBreaches(@CurrentUser() user: AccessTokenClaims) {
    return this.sla.runReassignmentForBreaches(user.sub);
  }

  @Post('leads/:id/stage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Move the lead to a different pipeline stage' })
  moveStage(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: MoveStageDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    return this.leads.moveStage(id, body.stageCode, user.sub);
  }

  @Get('leads/:id/activities')
  @ApiOperation({ summary: 'Activity timeline for the lead' })
  activities(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.leads.listActivities(id);
  }

  @Post('leads/:id/activities')
  @ApiOperation({ summary: 'Append a note or call activity' })
  addActivity(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: AddActivityDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    return this.leads.addActivity(id, body, user.sub);
  }

  @Post('leads/:id/convert')
  @ApiOperation({ summary: 'Convert the lead to a Captain' })
  convert(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: ConvertLeadDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    return this.captains.convertFromLead(id, body, user.sub);
  }
}
