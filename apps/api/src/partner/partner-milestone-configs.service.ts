import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { requireTenantId } from '../tenants/tenant-context';
import {
  type CreateMilestoneConfigDto,
  type ListMilestoneConfigsDto,
  type UpdateMilestoneConfigDto,
} from './partner-milestone.dto';

/**
 * Phase D4 — D4.7: PartnerMilestoneConfig admin CRUD.
 *
 * Multiple configs per partner source are allowed (locked product
 * decision: an operator may keep `commission_50_30` and a parallel
 * `commission_25_15` to compare cohorts). The (`partnerSourceId`,
 * `code`) UNIQUE in the schema prevents code collisions; "active"
 * is a soft flag — `isActive=true` configs feed the progress
 * service + reconciliation `commission_risk` category.
 *
 * Audit verb: `partner.milestone.config.updated` with `before` /
 * `after` / `changedFields` payload (mirrors the duplicate-rules
 * audit shape from D2.4).
 */
@Injectable()
export class PartnerMilestoneConfigsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(filters: ListMilestoneConfigsDto): Promise<{
    items: MilestoneConfigDto[];
    total: number;
  }> {
    const tenantId = requireTenantId();
    const where: Prisma.PartnerMilestoneConfigWhereInput = {
      tenantId,
      ...(filters.partnerSourceId && { partnerSourceId: filters.partnerSourceId }),
      ...(filters.isActive !== undefined && { isActive: filters.isActive }),
    };
    return this.prisma.withTenant(tenantId, async (tx) => {
      const [items, total] = await Promise.all([
        tx.partnerMilestoneConfig.findMany({
          where,
          orderBy: [{ isActive: 'desc' }, { displayName: 'asc' }],
          take: filters.limit,
          skip: filters.offset,
          include: {
            partnerSource: { select: { id: true, displayName: true, partnerCode: true } },
          },
        }),
        tx.partnerMilestoneConfig.count({ where }),
      ]);
      return { items: items.map((row) => toDto(row)), total };
    });
  }

  async findById(id: string): Promise<MilestoneConfigDto> {
    const tenantId = requireTenantId();
    const row = await this.prisma.withTenant(tenantId, (tx) =>
      tx.partnerMilestoneConfig.findFirst({
        where: { id, tenantId },
        include: {
          partnerSource: { select: { id: true, displayName: true, partnerCode: true } },
        },
      }),
    );
    if (!row) {
      throw new NotFoundException({
        code: 'partner.milestone.not_found',
        message: `Milestone config not found: ${id}`,
      });
    }
    return toDto(row);
  }

  async create(
    dto: CreateMilestoneConfigDto,
    actorUserId: string | null,
  ): Promise<MilestoneConfigDto> {
    const tenantId = requireTenantId();
    return this.prisma.withTenant(tenantId, async (tx) => {
      // Source visibility check — RLS already fences cross-tenant
      // but we want a clean 404 if the operator points at a
      // missing or out-of-tenant source.
      const source = await tx.partnerSource.findFirst({
        where: { id: dto.partnerSourceId, tenantId },
        select: { id: true },
      });
      if (!source) {
        throw new NotFoundException({
          code: 'partner.source.not_found',
          message: `Partner source not found: ${dto.partnerSourceId}`,
        });
      }
      try {
        const row = await tx.partnerMilestoneConfig.create({
          data: {
            tenantId,
            partnerSourceId: dto.partnerSourceId,
            code: dto.code,
            displayName: dto.displayName,
            windowDays: dto.windowDays,
            milestoneSteps: dto.milestoneSteps as Prisma.InputJsonValue,
            anchor: dto.anchor,
            ...(dto.riskThresholds && {
              riskThresholds: dto.riskThresholds as unknown as Prisma.InputJsonValue,
            }),
            isActive: dto.isActive,
          },
          include: {
            partnerSource: { select: { id: true, displayName: true, partnerCode: true } },
          },
        });
        await this.audit.writeInTx(tx, tenantId, {
          action: 'partner.milestone.config.updated',
          entityType: 'partner_milestone_config',
          entityId: row.id,
          actorUserId,
          payload: {
            partnerSourceId: row.partnerSourceId,
            action: 'create',
            after: toDto(row),
          } as unknown as Prisma.InputJsonValue,
        });
        return toDto(row);
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw new ConflictException({
            code: 'partner.milestone.duplicate_code',
            message: `Code '${dto.code}' is already used on this partner source.`,
          });
        }
        throw err;
      }
    });
  }

  async update(
    id: string,
    dto: UpdateMilestoneConfigDto,
    actorUserId: string | null,
  ): Promise<MilestoneConfigDto> {
    const tenantId = requireTenantId();
    return this.prisma.withTenant(tenantId, async (tx) => {
      const before = await tx.partnerMilestoneConfig.findFirst({
        where: { id, tenantId },
        include: {
          partnerSource: { select: { id: true, displayName: true, partnerCode: true } },
        },
      });
      if (!before) {
        throw new NotFoundException({
          code: 'partner.milestone.not_found',
          message: `Milestone config not found: ${id}`,
        });
      }
      try {
        const updated = await tx.partnerMilestoneConfig.update({
          where: { id },
          data: {
            ...(dto.code !== undefined && { code: dto.code }),
            ...(dto.displayName !== undefined && { displayName: dto.displayName }),
            ...(dto.windowDays !== undefined && { windowDays: dto.windowDays }),
            ...(dto.milestoneSteps !== undefined && {
              milestoneSteps: dto.milestoneSteps as Prisma.InputJsonValue,
            }),
            ...(dto.anchor !== undefined && { anchor: dto.anchor }),
            ...(dto.riskThresholds !== undefined && {
              riskThresholds:
                dto.riskThresholds === null
                  ? Prisma.JsonNull
                  : (dto.riskThresholds as unknown as Prisma.InputJsonValue),
            }),
            ...(dto.isActive !== undefined && { isActive: dto.isActive }),
          },
          include: {
            partnerSource: { select: { id: true, displayName: true, partnerCode: true } },
          },
        });
        const beforeDto = toDto(before);
        const afterDto = toDto(updated);
        const changedFields = (Object.keys(dto) as (keyof UpdateMilestoneConfigDto)[]).filter(
          (k) =>
            JSON.stringify((beforeDto as unknown as Record<string, unknown>)[k]) !==
            JSON.stringify((afterDto as unknown as Record<string, unknown>)[k]),
        );
        await this.audit.writeInTx(tx, tenantId, {
          action: 'partner.milestone.config.updated',
          entityType: 'partner_milestone_config',
          entityId: updated.id,
          actorUserId,
          payload: {
            partnerSourceId: updated.partnerSourceId,
            action: 'update',
            before: beforeDto,
            after: afterDto,
            changedFields,
          } as unknown as Prisma.InputJsonValue,
        });
        return afterDto;
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw new ConflictException({
            code: 'partner.milestone.duplicate_code',
            message: 'Code is already used on this partner source.',
          });
        }
        throw err;
      }
    });
  }

  async softDisable(id: string, actorUserId: string | null): Promise<MilestoneConfigDto> {
    const tenantId = requireTenantId();
    return this.prisma.withTenant(tenantId, async (tx) => {
      const before = await tx.partnerMilestoneConfig.findFirst({
        where: { id, tenantId },
        include: {
          partnerSource: { select: { id: true, displayName: true, partnerCode: true } },
        },
      });
      if (!before) {
        throw new NotFoundException({
          code: 'partner.milestone.not_found',
          message: `Milestone config not found: ${id}`,
        });
      }
      if (!before.isActive) return toDto(before);
      const updated = await tx.partnerMilestoneConfig.update({
        where: { id },
        data: { isActive: false },
        include: {
          partnerSource: { select: { id: true, displayName: true, partnerCode: true } },
        },
      });
      await this.audit.writeInTx(tx, tenantId, {
        action: 'partner.milestone.config.updated',
        entityType: 'partner_milestone_config',
        entityId: updated.id,
        actorUserId,
        payload: {
          partnerSourceId: updated.partnerSourceId,
          action: 'disable',
          before: toDto(before),
          after: toDto(updated),
          changedFields: ['isActive'],
        } as unknown as Prisma.InputJsonValue,
      });
      return toDto(updated);
    });
  }

  /**
   * Service-layer accessor used by the progress service: pull all
   * active configs for a partner source. Ordered by displayName so
   * "the active one" is deterministic when multiple exist.
   */
  async listActiveForSource(partnerSourceId: string): Promise<MilestoneConfigRow[]> {
    const tenantId = requireTenantId();
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.partnerMilestoneConfig.findMany({
        where: { tenantId, partnerSourceId, isActive: true },
        orderBy: { displayName: 'asc' },
      }),
    ) as unknown as Promise<MilestoneConfigRow[]>;
  }
}

// ─── shapes ─────────────────────────────────────────────────────────

export interface MilestoneConfigDto {
  id: string;
  partnerSourceId: string;
  partnerSource: { id: string; displayName: string; partnerCode: string } | null;
  code: string;
  displayName: string;
  windowDays: number;
  milestoneSteps: number[];
  anchor: string;
  riskThresholds: { high: number; medium: number } | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MilestoneConfigRow {
  id: string;
  partnerSourceId: string;
  code: string;
  displayName: string;
  windowDays: number;
  milestoneSteps: unknown;
  anchor: string;
  riskThresholds: unknown;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

type ConfigWithSource = Prisma.PartnerMilestoneConfigGetPayload<{
  include: {
    partnerSource: { select: { id: true; displayName: true; partnerCode: true } };
  };
}>;

function toDto(row: ConfigWithSource): MilestoneConfigDto {
  return {
    id: row.id,
    partnerSourceId: row.partnerSourceId,
    partnerSource: row.partnerSource
      ? {
          id: row.partnerSource.id,
          displayName: row.partnerSource.displayName,
          partnerCode: row.partnerSource.partnerCode,
        }
      : null,
    code: row.code,
    displayName: row.displayName,
    windowDays: row.windowDays,
    milestoneSteps: parseSteps(row.milestoneSteps),
    anchor: row.anchor,
    riskThresholds: parseRisk(row.riskThresholds),
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function parseSteps(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0);
}

function parseRisk(raw: unknown): { high: number; medium: number } | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj['high'] !== 'number' || typeof obj['medium'] !== 'number') return null;
  return { high: obj['high'] as number, medium: obj['medium'] as number };
}
