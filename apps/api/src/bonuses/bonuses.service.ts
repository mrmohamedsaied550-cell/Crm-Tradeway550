import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { requireTenantId } from '../tenants/tenant-context';
import type { CreateBonusRuleDto, UpdateBonusRuleDto } from './bonus.dto';

/**
 * C32 — BonusRules CRUD. Pure tenant-scoped storage, no payout engine.
 */
@Injectable()
export class BonusesService {
  constructor(private readonly prisma: PrismaService) {}

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

  async create(dto: CreateBonusRuleDto) {
    const tenantId = requireTenantId();
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.bonusRule.create({
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
      }),
    );
  }

  async update(id: string, dto: UpdateBonusRuleDto) {
    await this.findByIdOrThrow(id); // 404 cross-tenant
    const tenantId = requireTenantId();
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.bonusRule.update({
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
      }),
    );
  }

  async setActive(id: string, isActive: boolean) {
    await this.findByIdOrThrow(id);
    const tenantId = requireTenantId();
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.bonusRule.update({ where: { id }, data: { isActive } }),
    );
  }

  async remove(id: string) {
    await this.findByIdOrThrow(id);
    const tenantId = requireTenantId();
    await this.prisma.withTenant(tenantId, (tx) => tx.bonusRule.delete({ where: { id } }));
  }
}
