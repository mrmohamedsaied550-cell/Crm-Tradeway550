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

import { CurrentUser } from '../identity/current-user.decorator';
import { JwtAuthGuard } from '../identity/jwt-auth.guard';
import type { AccessTokenClaims } from '../identity/jwt.types';
import { CapabilityGuard } from '../rbac/capability.guard';
import { RequireCapability } from '../rbac/require-capability.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { requireTenantId } from '../tenants/tenant-context';

import { PipelineService } from './pipeline.service';
import {
  CreatePipelineSchema,
  CreateStageSchema,
  ReorderStagesSchema,
  UpdatePipelineSchema,
  UpdateStageSchema,
} from './pipelines.dto';
import { PipelinesService } from './pipelines.service';

class CreatePipelineDto extends createZodDto(CreatePipelineSchema) {}
class UpdatePipelineDto extends createZodDto(UpdatePipelineSchema) {}
class CreateStageDto extends createZodDto(CreateStageSchema) {}
class UpdateStageDto extends createZodDto(UpdateStageSchema) {}
class ReorderStagesDto extends createZodDto(ReorderStagesSchema) {}

/**
 * /api/v1/pipelines (P2-07) — Pipeline Builder admin API.
 *
 * Reads are gated by `pipeline.read` (every CRM-touching role
 * already has it via the READ_CRM bundle); writes by `pipeline.write`
 * (added in P2-07 to ops_manager + account_manager).
 */
@ApiTags('crm')
@Controller('pipelines')
@UseGuards(JwtAuthGuard, CapabilityGuard)
export class PipelinesController {
  constructor(
    private readonly pipelines: PipelinesService,
    /** Phase 1B — `resolve` + `stages` rely on the resolver service. */
    private readonly pipelineResolver: PipelineService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  @RequireCapability('pipeline.read')
  @ApiOperation({ summary: 'List pipelines for the active tenant' })
  list() {
    return this.pipelines.list();
  }

  /**
   * Phase 1B — resolve the right pipeline for a (companyId, countryId)
   * scope. Returns the pipeline + its stages so the create-lead form
   * (and Kanban entry-point) can populate dropdowns dynamically
   * without a follow-up call.
   *
   * Query: companyId? + countryId?  (both optional)
   * Response: { pipeline: { id, name, isDefault, ... }, stages: [...] }
   */
  @Get('resolve')
  @RequireCapability('pipeline.read')
  @ApiOperation({
    summary: 'Resolve the right pipeline for a (company, country) scope + return its stages',
  })
  async resolve(@Query('companyId') companyId?: string, @Query('countryId') countryId?: string) {
    const tenantId = requireTenantId();
    return this.prisma.withTenant(tenantId, async (tx) => {
      const pipeline = await this.pipelineResolver.resolveForLeadInTx(tx, {
        companyId: companyId ?? null,
        countryId: countryId ?? null,
      });
      const stages = await tx.pipelineStage.findMany({
        where: { pipelineId: pipeline.id },
        orderBy: { order: 'asc' },
        select: {
          id: true,
          code: true,
          name: true,
          order: true,
          isTerminal: true,
          terminalKind: true,
        },
      });
      return { pipeline, stages };
    });
  }

  /**
   * Phase 1B — stages of a specific pipeline by id, ordered. Lets the
   * lead-detail dropdown / Kanban load the columns for whichever
   * pipeline the lead is currently on, without going through the
   * heavier `findByIdOrThrow` payload.
   */
  @Get(':id/stages')
  @RequireCapability('pipeline.read')
  @ApiOperation({ summary: 'List stages of a specific pipeline (ordered)' })
  async stagesOf(@Param('id', new ParseUUIDPipe()) id: string) {
    const tenantId = requireTenantId();
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.pipelineStage.findMany({
        where: { pipelineId: id },
        orderBy: { order: 'asc' },
        select: {
          id: true,
          code: true,
          name: true,
          order: true,
          isTerminal: true,
          terminalKind: true,
        },
      }),
    );
  }

  @Get(':id')
  @RequireCapability('pipeline.read')
  @ApiOperation({ summary: 'Get a pipeline (with its stages) by id' })
  findOne(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.pipelines.findByIdOrThrow(id);
  }

  @Post()
  @RequireCapability('pipeline.write')
  @ApiOperation({ summary: 'Create a pipeline (optionally scoped to a company × country)' })
  create(@Body() body: CreatePipelineDto, @CurrentUser() user: AccessTokenClaims) {
    return this.pipelines.create(body, user.sub);
  }

  @Patch(':id')
  @RequireCapability('pipeline.write')
  @ApiOperation({ summary: 'Rename / activate / deactivate a pipeline' })
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdatePipelineDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    return this.pipelines.update(id, body, user.sub);
  }

  @Delete(':id')
  @RequireCapability('pipeline.write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a pipeline (forbidden if leads still reference it)' })
  async remove(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<void> {
    await this.pipelines.delete(id, user.sub);
  }

  // ─── stages ───

  @Post(':id/stages')
  @RequireCapability('pipeline.write')
  @ApiOperation({ summary: 'Add a stage to the pipeline' })
  addStage(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: CreateStageDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    return this.pipelines.addStage(id, body, user.sub);
  }

  @Patch(':id/stages/:stageId')
  @RequireCapability('pipeline.write')
  @ApiOperation({ summary: 'Rename / toggle terminal flag of a stage' })
  updateStage(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('stageId', new ParseUUIDPipe()) stageId: string,
    @Body() body: UpdateStageDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    return this.pipelines.updateStage(id, stageId, body, user.sub);
  }

  @Delete(':id/stages/:stageId')
  @RequireCapability('pipeline.write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a stage (forbidden if leads still reference it)' })
  async removeStage(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('stageId', new ParseUUIDPipe()) stageId: string,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<void> {
    await this.pipelines.deleteStage(id, stageId, user.sub);
  }

  @Post(':id/stages/reorder')
  @RequireCapability('pipeline.write')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reorder all stages in this pipeline (atomic)' })
  reorder(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: ReorderStagesDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    return this.pipelines.reorderStages(id, body, user.sub);
  }
}
