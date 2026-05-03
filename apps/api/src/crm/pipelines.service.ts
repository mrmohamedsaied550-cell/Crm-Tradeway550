import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { requireTenantId } from '../tenants/tenant-context';
import type {
  CreatePipelineDto,
  CreateStageDto,
  ReorderStagesDto,
  UpdatePipelineDto,
  UpdateStageDto,
} from './pipelines.dto';

/**
 * P2-07 — admin CRUD for Pipelines and the stages they contain.
 *
 * Invariants the service enforces:
 *
 *   - The tenant-default pipeline (`isDefault = TRUE`) cannot be
 *     deleted, deactivated, or downgraded by clearing isDefault.
 *     It's the fallback for every code path that resolves a stage by
 *     code without explicit pipeline scope (CSV import, Meta lead-gen,
 *     manual lead create), so removing it would orphan those flows.
 *
 *   - A stage cannot be deleted while leads still reference it. Leads
 *     would orphan via the FK's RESTRICT, but we surface a typed
 *     conflict before the DB error so the admin gets a clean message.
 *
 *   - `code` is unique within a pipeline. `order` is unique within a
 *     pipeline (enforced by the DB). The service appends to the end
 *     when a client omits `order` on stage create.
 *
 *   - Reorder is atomic — a single transaction rewrites every order
 *     value via a two-phase swap (move all rows to negative offsets
 *     first, then the target values) so the per-pipeline UNIQUE
 *     index doesn't fire mid-update.
 */
@Injectable()
export class PipelinesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ─────────────────── pipelines ───────────────────

  list() {
    const tenantId = requireTenantId();
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.pipeline.findMany({
        orderBy: [{ isDefault: 'desc' }, { isActive: 'desc' }, { name: 'asc' }],
        include: {
          _count: { select: { stages: true } },
          company: { select: { id: true, code: true, name: true } },
          country: { select: { id: true, code: true, name: true } },
        },
      }),
    );
  }

  async findById(id: string) {
    const tenantId = requireTenantId();
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.pipeline.findFirst({
        where: { id },
        include: {
          stages: { orderBy: { order: 'asc' } },
          company: { select: { id: true, code: true, name: true } },
          country: { select: { id: true, code: true, name: true } },
        },
      }),
    );
  }

  async findByIdOrThrow(id: string) {
    const row = await this.findById(id);
    if (!row) {
      throw new NotFoundException({
        code: 'pipeline.not_found',
        message: `Pipeline ${id} not found in active tenant`,
      });
    }
    return row;
  }

  async create(dto: CreatePipelineDto, actorUserId: string | null) {
    const tenantId = requireTenantId();

    // Cross-validate company / country belong to this tenant. RLS
    // already filters cross-tenant rows, so a missing row here means
    // either the id is wrong or it belongs to another tenant.
    if (dto.companyId) {
      await this.assertCompanyExists(tenantId, dto.companyId);
    }
    if (dto.countryId) {
      await this.assertCountryMatchesCompany(tenantId, dto.countryId, dto.companyId ?? null);
    }

    try {
      return await this.prisma.withTenant(tenantId, async (tx) => {
        const created = await tx.pipeline.create({
          data: {
            tenantId,
            companyId: dto.companyId ?? null,
            countryId: dto.countryId ?? null,
            name: dto.name,
            isDefault: false, // user-created pipelines are never the default
            isActive: dto.isActive,
          },
          include: {
            stages: true,
            company: { select: { id: true, code: true, name: true } },
            country: { select: { id: true, code: true, name: true } },
          },
        });
        await this.audit.writeInTx(tx, tenantId, {
          action: 'pipeline.created',
          entityType: 'pipeline',
          entityId: created.id,
          actorUserId,
          payload: {
            name: created.name,
            companyId: created.companyId,
            countryId: created.countryId,
          } as Prisma.InputJsonValue,
        });
        return created;
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException({
          code: 'pipeline.duplicate',
          message: `A pipeline already exists for that (company, country) combination`,
        });
      }
      throw err;
    }
  }

  async update(id: string, dto: UpdatePipelineDto, actorUserId: string | null) {
    const tenantId = requireTenantId();
    const before = await this.findByIdOrThrow(id);

    // The tenant-default pipeline must remain active. Renaming is OK.
    if (before.isDefault && dto.isActive === false) {
      throw new BadRequestException({
        code: 'pipeline.default_must_stay_active',
        message: `The default pipeline cannot be deactivated`,
      });
    }

    return this.prisma.withTenant(tenantId, async (tx) => {
      const updated = await tx.pipeline.update({
        where: { id },
        data: {
          ...(dto.name !== undefined && { name: dto.name }),
          ...(dto.isActive !== undefined && { isActive: dto.isActive }),
        },
        include: {
          stages: { orderBy: { order: 'asc' } },
          company: { select: { id: true, code: true, name: true } },
          country: { select: { id: true, code: true, name: true } },
        },
      });
      await this.audit.writeInTx(tx, tenantId, {
        action: 'pipeline.updated',
        entityType: 'pipeline',
        entityId: id,
        actorUserId,
        payload: { changes: Object.keys(dto) } as Prisma.InputJsonValue,
      });
      return updated;
    });
  }

  async delete(id: string, actorUserId: string | null) {
    const tenantId = requireTenantId();
    const before = await this.findByIdOrThrow(id);
    if (before.isDefault) {
      throw new BadRequestException({
        code: 'pipeline.default_undeletable',
        message: `The default pipeline cannot be deleted`,
      });
    }

    return this.prisma.withTenant(tenantId, async (tx) => {
      // Reject deletion when any stage in this pipeline still owns
      // leads. The stage→lead FK is RESTRICT, so the DB would throw
      // P2003 anyway — checking up-front lets us surface the typed
      // error code the admin UI branches on.
      const inUse = await tx.lead.count({
        where: { stage: { pipelineId: id } },
      });
      if (inUse > 0) {
        throw new ConflictException({
          code: 'pipeline.has_leads',
          message: `Pipeline still has ${inUse} lead(s); reassign them before deleting`,
        });
      }
      await tx.pipeline.delete({ where: { id } });
      await this.audit.writeInTx(tx, tenantId, {
        action: 'pipeline.deleted',
        entityType: 'pipeline',
        entityId: id,
        actorUserId,
        payload: { name: before.name } as Prisma.InputJsonValue,
      });
    });
  }

  // ─────────────────── stages ───────────────────

  async addStage(pipelineId: string, dto: CreateStageDto, actorUserId: string | null) {
    const tenantId = requireTenantId();
    await this.findByIdOrThrow(pipelineId); // 404 cross-tenant

    try {
      return await this.prisma.withTenant(tenantId, async (tx) => {
        const order =
          dto.order ??
          ((
            await tx.pipelineStage.aggregate({
              where: { pipelineId },
              _max: { order: true },
            })
          )._max.order ?? 0) + 10;
        // Phase A — A6: terminalKind only valid on terminal stages.
        // Reject non-null terminalKind on a non-terminal stage so the
        // schema invariant ("a non-terminal stage cannot be 'won' or
        // 'lost'") is enforced at every write site.
        const terminalKind = dto.terminalKind === undefined ? null : dto.terminalKind;
        if (!dto.isTerminal && terminalKind !== null) {
          throw new BadRequestException({
            code: 'pipeline.stage.terminal_kind_requires_terminal',
            message: 'terminalKind can only be set on a terminal stage (isTerminal=true)',
          });
        }
        const stage = await tx.pipelineStage.create({
          data: {
            tenantId,
            pipelineId,
            code: dto.code,
            name: dto.name,
            order,
            isTerminal: dto.isTerminal,
            terminalKind,
          },
        });
        await this.audit.writeInTx(tx, tenantId, {
          action: 'pipeline.stage.created',
          entityType: 'pipeline_stage',
          entityId: stage.id,
          actorUserId,
          payload: {
            pipelineId,
            code: stage.code,
            name: stage.name,
            order: stage.order,
            isTerminal: stage.isTerminal,
          } as Prisma.InputJsonValue,
        });
        return stage;
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const target = (err.meta?.['target'] as string[] | string | undefined) ?? '';
        const targetStr = Array.isArray(target) ? target.join(',') : String(target);
        if (targetStr.includes('order')) {
          throw new ConflictException({
            code: 'pipeline.stage.duplicate_order',
            message: `Another stage in this pipeline already uses order ${dto.order}`,
          });
        }
        throw new ConflictException({
          code: 'pipeline.stage.duplicate_code',
          message: `Stage code "${dto.code}" already exists in this pipeline`,
        });
      }
      throw err;
    }
  }

  async updateStage(
    pipelineId: string,
    stageId: string,
    dto: UpdateStageDto,
    actorUserId: string | null,
  ) {
    const tenantId = requireTenantId();
    await this.findByIdOrThrow(pipelineId);

    return this.prisma.withTenant(tenantId, async (tx) => {
      const before = await tx.pipelineStage.findFirst({
        where: { id: stageId, pipelineId },
      });
      if (!before) {
        throw new NotFoundException({
          code: 'pipeline.stage.not_found',
          message: `Stage ${stageId} not found in pipeline ${pipelineId}`,
        });
      }
      // Phase A — A6: same invariant as create. The merged shape
      // (existing + patch) must be: terminalKind=null OR
      // isTerminal=true. When the patch flips isTerminal=false,
      // any existing or incoming terminalKind is forced to null.
      const mergedIsTerminal = dto.isTerminal ?? before.isTerminal;
      const mergedTerminalKind =
        dto.terminalKind !== undefined ? dto.terminalKind : before.terminalKind;
      if (!mergedIsTerminal && mergedTerminalKind !== null) {
        throw new BadRequestException({
          code: 'pipeline.stage.terminal_kind_requires_terminal',
          message: 'terminalKind can only be set on a terminal stage (isTerminal=true)',
        });
      }
      const updated = await tx.pipelineStage.update({
        where: { id: stageId },
        data: {
          ...(dto.name !== undefined && { name: dto.name }),
          ...(dto.isTerminal !== undefined && { isTerminal: dto.isTerminal }),
          ...(dto.terminalKind !== undefined && { terminalKind: dto.terminalKind }),
          // If the patch made the stage non-terminal, defensively
          // null out terminalKind even if the caller didn't pass it.
          ...(dto.isTerminal === false && dto.terminalKind === undefined && { terminalKind: null }),
        },
      });
      await this.audit.writeInTx(tx, tenantId, {
        action: 'pipeline.stage.updated',
        entityType: 'pipeline_stage',
        entityId: stageId,
        actorUserId,
        payload: { changes: Object.keys(dto) } as Prisma.InputJsonValue,
      });
      return updated;
    });
  }

  async deleteStage(pipelineId: string, stageId: string, actorUserId: string | null) {
    const tenantId = requireTenantId();
    await this.findByIdOrThrow(pipelineId);

    return this.prisma.withTenant(tenantId, async (tx) => {
      const stage = await tx.pipelineStage.findFirst({
        where: { id: stageId, pipelineId },
      });
      if (!stage) {
        throw new NotFoundException({
          code: 'pipeline.stage.not_found',
          message: `Stage ${stageId} not found in pipeline ${pipelineId}`,
        });
      }
      const usedBy = await tx.lead.count({ where: { stageId } });
      if (usedBy > 0) {
        throw new ConflictException({
          code: 'pipeline.stage.in_use',
          message: `Stage "${stage.code}" is still used by ${usedBy} lead(s); move them first`,
        });
      }
      await tx.pipelineStage.delete({ where: { id: stageId } });
      await this.audit.writeInTx(tx, tenantId, {
        action: 'pipeline.stage.deleted',
        entityType: 'pipeline_stage',
        entityId: stageId,
        actorUserId,
        payload: { pipelineId, code: stage.code } as Prisma.InputJsonValue,
      });
    });
  }

  /**
   * Atomically rewrite the order column for every stage in this
   * pipeline. The two-phase update (-1, -2, ... -N then +10, +20, ...
   * +N*10) avoids touching the (pipelineId, order) UNIQUE index
   * mid-flight: negative orders never collide with the positive
   * range that's about to be re-laid-down.
   */
  async reorderStages(pipelineId: string, dto: ReorderStagesDto, actorUserId: string | null) {
    const tenantId = requireTenantId();
    await this.findByIdOrThrow(pipelineId);

    return this.prisma.withTenant(tenantId, async (tx) => {
      const stages = await tx.pipelineStage.findMany({
        where: { pipelineId },
        select: { id: true },
      });
      const known = new Set(stages.map((s) => s.id));
      if (dto.stageIds.length !== stages.length) {
        throw new BadRequestException({
          code: 'pipeline.reorder.mismatch',
          message: `Expected ${stages.length} stage ids, got ${dto.stageIds.length}`,
        });
      }
      for (const id of dto.stageIds) {
        if (!known.has(id)) {
          throw new BadRequestException({
            code: 'pipeline.reorder.unknown_stage',
            message: `Stage ${id} does not belong to pipeline ${pipelineId}`,
          });
        }
      }

      // Phase 1: move every stage to a negative offset to clear the
      // positive UNIQUE index range. We use the stage's own index in
      // the input array so each phase-1 update is unique.
      for (let i = 0; i < dto.stageIds.length; i += 1) {
        await tx.pipelineStage.update({
          where: { id: dto.stageIds[i] as string },
          data: { order: -1 - i },
        });
      }
      // Phase 2: write the final orders (10, 20, 30 ...).
      for (let i = 0; i < dto.stageIds.length; i += 1) {
        await tx.pipelineStage.update({
          where: { id: dto.stageIds[i] as string },
          data: { order: (i + 1) * 10 },
        });
      }

      await this.audit.writeInTx(tx, tenantId, {
        action: 'pipeline.stages.reordered',
        entityType: 'pipeline',
        entityId: pipelineId,
        actorUserId,
        payload: { stageIds: dto.stageIds } as Prisma.InputJsonValue,
      });

      return tx.pipelineStage.findMany({
        where: { pipelineId },
        orderBy: { order: 'asc' },
      });
    });
  }

  // ─────────────────── helpers ───────────────────

  private async assertCompanyExists(tenantId: string, companyId: string): Promise<void> {
    const ok = await this.prisma.withTenant(tenantId, (tx) =>
      tx.company.findUnique({ where: { id: companyId }, select: { id: true } }),
    );
    if (!ok) {
      throw new BadRequestException({
        code: 'pipeline.company_not_found',
        message: `Company ${companyId} not found in active tenant`,
      });
    }
  }

  private async assertCountryMatchesCompany(
    tenantId: string,
    countryId: string,
    companyId: string | null,
  ): Promise<void> {
    const country = await this.prisma.withTenant(tenantId, (tx) =>
      tx.country.findUnique({
        where: { id: countryId },
        select: { id: true, companyId: true },
      }),
    );
    if (!country) {
      throw new BadRequestException({
        code: 'pipeline.country_not_found',
        message: `Country ${countryId} not found in active tenant`,
      });
    }
    if (companyId && country.companyId !== companyId) {
      throw new BadRequestException({
        code: 'pipeline.country_company_mismatch',
        message: `Country ${countryId} does not belong to the supplied company`,
      });
    }
  }
}
