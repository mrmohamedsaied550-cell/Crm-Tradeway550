import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { requireTenantId } from '../tenants/tenant-context';
import type { CreateBonusRuleDto, UpdateBonusRuleDto } from './bonus.dto';

/**
 * C32 — BonusRules CRUD. Pure tenant-scoped storage, no payout engine.
 * C40 — every mutation appends a row to audit_events via AuditService.
 */
@Injectable()
export class BonusesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  list() {
    const tenantId = requireTenantId();
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.bonusRule.findMany({
        orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
      }),
    );
  }

  async findByIdOrThrow(id: string) {
    const tenantId = requireTenantId();
    const row = await this.prisma.withTenant(tenantId, (tx) =>
      tx.bonusRule.findUnique({ where: { id } }),
    );
    if (!row) {
      throw new NotFoundException({
        code: 'bonus.not_found',
        message: `Bonus rule ${id} not found in active tenant`,
      });
    }
    return row;
  }

  async create(dto: CreateBonusRuleDto, actorUserId: string | null = null) {
    const tenantId = requireTenantId();
    return this.prisma.withTenant(tenantId, async (tx) => {
      const row = await tx.bonusRule.create({
        data: {
          tenantId,
          companyId: dto.companyId,
          countryId: dto.countryId,
          teamId: dto.teamId ?? null,
          roleId: dto.roleId ?? null,
          bonusType: dto.bonusType,
          trigger: dto.trigger,
          amount: new Prisma.Decimal(dto.amount),
          isActive: dto.isActive ?? true,
        },
      });
      await this.audit.writeInTx(tx, tenantId, {
        action: 'bonus.create',
        entityType: 'bonus_rule',
        entityId: row.id,
        actorUserId,
        payload: { bonusType: row.bonusType, amount: row.amount.toString() },
      });
      return row;
    });
  }

  async update(id: string, dto: UpdateBonusRuleDto, actorUserId: string | null = null) {
    await this.findByIdOrThrow(id); // 404 cross-tenant
    const tenantId = requireTenantId();
    return this.prisma.withTenant(tenantId, async (tx) => {
      const row = await tx.bonusRule.update({
        where: { id },
        data: {
          ...(dto.companyId !== undefined && { companyId: dto.companyId }),
          ...(dto.countryId !== undefined && { countryId: dto.countryId }),
          ...(dto.teamId !== undefined && { teamId: dto.teamId }),
          ...(dto.roleId !== undefined && { roleId: dto.roleId }),
          ...(dto.bonusType !== undefined && { bonusType: dto.bonusType }),
          ...(dto.trigger !== undefined && { trigger: dto.trigger }),
          ...(dto.amount !== undefined && { amount: new Prisma.Decimal(dto.amount) }),
          ...(dto.isActive !== undefined && { isActive: dto.isActive }),
        },
      });
      await this.audit.writeInTx(tx, tenantId, {
        action: 'bonus.update',
        entityType: 'bonus_rule',
        entityId: id,
        actorUserId,
        payload: dto as unknown as Prisma.InputJsonValue,
      });
      return row;
    });
  }

  async setActive(id: string, isActive: boolean, actorUserId: string | null = null) {
    await this.findByIdOrThrow(id);
    const tenantId = requireTenantId();
    return this.prisma.withTenant(tenantId, async (tx) => {
      const row = await tx.bonusRule.update({ where: { id }, data: { isActive } });
      await this.audit.writeInTx(tx, tenantId, {
        action: isActive ? 'bonus.enable' : 'bonus.disable',
        entityType: 'bonus_rule',
        entityId: id,
        actorUserId,
      });
      return row;
    });
  }

  async remove(id: string, actorUserId: string | null = null) {
    await this.findByIdOrThrow(id);
    const tenantId = requireTenantId();
    await this.prisma.withTenant(tenantId, async (tx) => {
      await tx.bonusRule.delete({ where: { id } });
      await this.audit.writeInTx(tx, tenantId, {
        action: 'bonus.delete',
        entityType: 'bonus_rule',
        entityId: id,
        actorUserId,
      });
    });
  }
}
