import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Prisma } from '@prisma/client';
import { createZodDto } from 'nestjs-zod';

import { CurrentUser } from '../identity/current-user.decorator';
import { JwtAuthGuard } from '../identity/jwt-auth.guard';
import type { AccessTokenClaims } from '../identity/jwt.types';
import { PrismaService } from '../prisma/prisma.service';
import { CapabilityGuard } from '../rbac/capability.guard';
import { RequireCapability } from '../rbac/require-capability.decorator';
import { requireTenantId } from '../tenants/tenant-context';

import { AgentCapacitiesService } from './capacities.service';
import {
  CreateDistributionRuleSchema,
  ListRoutingLogsQuerySchema,
  UpdateDistributionRuleSchema,
  UpsertAgentCapacitySchema,
} from './distribution.dto';
import type { StrategyName } from './distribution.types';
import { LeadRoutingLogService } from './routing-log.service';
import { DistributionRulesService } from './rules.service';

class CreateDistributionRuleDto extends createZodDto(CreateDistributionRuleSchema) {}
class UpdateDistributionRuleDto extends createZodDto(UpdateDistributionRuleSchema) {}
class UpsertAgentCapacityDto extends createZodDto(UpsertAgentCapacitySchema) {}
class ListRoutingLogsQueryDto extends createZodDto(ListRoutingLogsQuerySchema) {}

/**
 * Phase 1A — A7: admin REST surface for the Distribution Engine.
 *
 * One controller mounts everything under /distribution and
 * /leads/:id/routing-log. CapabilityGuard + RequireCapability gate
 * each route — read endpoints require `distribution.read`, write
 * endpoints require `distribution.write`. JWT is required across
 * the board (no public access).
 *
 * The controller is a thin DTO + capability + tenant-scope wrapper
 * around the services from A4 (rules, capacities, routing log).
 * Service-level validation (e.g. specific_user requires target,
 * cross-tenant FK guards) is enforced by the underlying services
 * + RLS.
 */
@ApiTags('distribution')
@Controller()
@UseGuards(JwtAuthGuard, CapabilityGuard)
export class DistributionController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rules: DistributionRulesService,
    private readonly capacities: AgentCapacitiesService,
    private readonly logs: LeadRoutingLogService,
  ) {}

  // ─── Rules ───

  @Get('distribution/rules')
  @RequireCapability('distribution.read')
  @ApiOperation({ summary: 'List distribution rules in priority order' })
  listRules() {
    return this.rules.list();
  }

  @Post('distribution/rules')
  @RequireCapability('distribution.write')
  @ApiOperation({ summary: 'Create a distribution rule' })
  async createRule(
    @Body() body: CreateDistributionRuleDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    const tenantId = requireTenantId();
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.distributionRule.create({
        data: {
          tenantId,
          name: body.name,
          isActive: body.isActive ?? true,
          priority: body.priority ?? 100,
          source: body.source ?? null,
          companyId: body.companyId ?? null,
          countryId: body.countryId ?? null,
          targetTeamId: body.targetTeamId ?? null,
          strategy: body.strategy,
          targetUserId: body.targetUserId ?? null,
          createdById: user.sub,
        },
      }),
    );
  }

  @Patch('distribution/rules/:id')
  @RequireCapability('distribution.write')
  @ApiOperation({ summary: 'Update a distribution rule (partial)' })
  async updateRule(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateDistributionRuleDto,
  ) {
    const tenantId = requireTenantId();
    // Re-validate the specific_user invariant against the merged
    // (existing + patch) shape — Zod already covers create-time;
    // PATCH must check too.
    const existing = await this.rules.findById(id);
    if (!existing) {
      throw new NotFoundException({
        code: 'distribution.rule.not_found',
        message: `Rule ${id} not found in active tenant`,
      });
    }
    const mergedStrategy = (body.strategy ?? existing.strategy) as StrategyName;
    const mergedTargetUserId =
      body.targetUserId !== undefined ? body.targetUserId : existing.targetUserId;
    if (mergedStrategy === 'specific_user' && !mergedTargetUserId) {
      throw new BadRequestException({
        code: 'distribution.rule.specific_user_requires_target_user',
        message: 'targetUserId is required when strategy is "specific_user"',
      });
    }
    if (mergedStrategy !== 'specific_user' && mergedTargetUserId) {
      throw new BadRequestException({
        code: 'distribution.rule.target_user_only_for_specific_user',
        message: 'targetUserId is only valid when strategy is "specific_user"',
      });
    }

    const data: Prisma.DistributionRuleUpdateInput = {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.isActive !== undefined && { isActive: body.isActive }),
      ...(body.priority !== undefined && { priority: body.priority }),
      ...(body.source !== undefined && { source: body.source }),
      ...(body.companyId !== undefined && {
        company:
          body.companyId === null ? { disconnect: true } : { connect: { id: body.companyId } },
      }),
      ...(body.countryId !== undefined && {
        country:
          body.countryId === null ? { disconnect: true } : { connect: { id: body.countryId } },
      }),
      ...(body.targetTeamId !== undefined && {
        targetTeam:
          body.targetTeamId === null
            ? { disconnect: true }
            : { connect: { id: body.targetTeamId } },
      }),
      ...(body.strategy !== undefined && { strategy: body.strategy }),
      ...(body.targetUserId !== undefined && {
        targetUser:
          body.targetUserId === null
            ? { disconnect: true }
            : { connect: { id: body.targetUserId } },
      }),
    };
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.distributionRule.update({ where: { id }, data }),
    );
  }

  @Delete('distribution/rules/:id')
  @RequireCapability('distribution.write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a distribution rule' })
  async deleteRule(@Param('id', new ParseUUIDPipe()) id: string): Promise<void> {
    const tenantId = requireTenantId();
    const existing = await this.rules.findById(id);
    if (!existing) {
      throw new NotFoundException({
        code: 'distribution.rule.not_found',
        message: `Rule ${id} not found in active tenant`,
      });
    }
    await this.prisma.withTenant(tenantId, (tx) => tx.distributionRule.delete({ where: { id } }));
  }

  // ─── Capacities ───

  @Get('distribution/capacities')
  @RequireCapability('distribution.read')
  @ApiOperation({ summary: 'List per-user capacity rows' })
  listCapacities() {
    return this.capacities.list();
  }

  @Put('distribution/capacities/:userId')
  @RequireCapability('distribution.write')
  @ApiOperation({ summary: 'Upsert one user’s capacity row' })
  async upsertCapacity(
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Body() body: UpsertAgentCapacityDto,
  ) {
    const tenantId = requireTenantId();
    // Defense in depth: ensure the target user is actually in the
    // active tenant. RLS would already filter cross-tenant ids out
    // of every read, but the UPSERT's `create` branch could bypass
    // that without an explicit check.
    const inTenant = await this.prisma.withTenant(tenantId, (tx) =>
      tx.user.findUnique({ where: { id: userId }, select: { id: true } }),
    );
    if (!inTenant) {
      throw new NotFoundException({
        code: 'distribution.capacity.user_not_in_tenant',
        message: `User ${userId} is not a member of the active tenant`,
      });
    }
    return this.capacities.upsert(userId, {
      ...(body.weight !== undefined && { weight: body.weight }),
      ...(body.isAvailable !== undefined && { isAvailable: body.isAvailable }),
      ...(body.outOfOfficeUntil !== undefined && {
        outOfOfficeUntil: body.outOfOfficeUntil === null ? null : new Date(body.outOfOfficeUntil),
      }),
      ...(body.maxActiveLeads !== undefined && { maxActiveLeads: body.maxActiveLeads }),
      // workingHours JSONB pass-through; CapacitiesService handles
      // the prisma upsert. Today the candidate-filter ignores it
      // (deferred); the column is still written + read-through.
    });
  }

  // ─── Routing logs ───

  @Get('distribution/logs')
  @RequireCapability('distribution.read')
  @ApiOperation({ summary: 'List routing-log rows (newest first)' })
  listLogs(@Query() query: ListRoutingLogsQueryDto) {
    return this.logs.list({
      ...(query.leadId && { leadId: query.leadId }),
      ...(query.from && { from: new Date(query.from) }),
      ...(query.limit && { limit: query.limit }),
    });
  }

  /**
   * Per-lead audit trail. Lives under /leads/:id/routing-log to
   * match the lead-detail panel's URL structure (mirrors
   * /leads/:id/activities + /leads/:id/follow-ups).
   *
   * Gated on `lead.read` rather than `distribution.read` because
   * ANYONE allowed to view the lead should see why it was routed
   * the way it was — that's part of the lead detail.
   */
  @Get('leads/:id/routing-log')
  @RequireCapability('lead.read')
  @ApiOperation({ summary: 'Routing decisions for one lead (newest first)' })
  listLeadLogs(@Param('id', new ParseUUIDPipe()) leadId: string) {
    return this.logs.list({ leadId });
  }
}
