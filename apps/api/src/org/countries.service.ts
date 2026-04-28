import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { requireTenantId } from '../tenants/tenant-context';
import { CompaniesService } from './companies.service';
import type { CreateCountryDto, ListCountriesQueryDto, UpdateCountryDto } from './org.dto';

const COUNTRY_SELECT = {
  id: true,
  tenantId: true,
  companyId: true,
  code: true,
  name: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * CountriesService — tenant-scoped CRUD on (Company × Country) operating
 * units.
 *
 * `companyId` is validated through CompaniesService under the active GUC,
 * so a cross-tenant FK insert returns 404 (not 500) and we never accept a
 * row pointing at another tenant's company. Uniqueness is on
 * `(tenant, company, code)` — the same ISO code may exist under multiple
 * companies in one tenant.
 */
@Injectable()
export class CountriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly companies: CompaniesService,
  ) {}

  list(query: ListCountriesQueryDto = {}) {
    return this.prisma.withTenant(requireTenantId(), (tx) =>
      tx.country.findMany({
        where: { ...(query.companyId && { companyId: query.companyId }) },
        select: COUNTRY_SELECT,
        orderBy: [{ companyId: 'asc' }, { code: 'asc' }],
      }),
    );
  }

  findById(id: string) {
    return this.prisma.withTenant(requireTenantId(), (tx) =>
      tx.country.findUnique({ where: { id }, select: COUNTRY_SELECT }),
    );
  }

  async findByIdOrThrow(id: string) {
    const row = await this.findById(id);
    if (!row) {
      throw new NotFoundException({
        code: 'country.not_found',
        message: `Country not found: ${id}`,
      });
    }
    return row;
  }

  async create(dto: CreateCountryDto) {
    const tenantId = requireTenantId();
    // Cross-tenant guard: findByIdOrThrow runs under the active tenant
    // GUC, so a companyId that belongs to another tenant returns 404.
    await this.companies.findByIdOrThrow(dto.companyId);
    try {
      return await this.prisma.withTenant(tenantId, (tx) =>
        tx.country.create({
          data: {
            tenantId,
            companyId: dto.companyId,
            code: dto.code,
            name: dto.name,
            isActive: dto.isActive ?? true,
          },
          select: COUNTRY_SELECT,
        }),
      );
    } catch (err) {
      throw remapUniqueViolation(err, dto.code);
    }
  }

  async update(id: string, dto: UpdateCountryDto) {
    const tenantId = requireTenantId();
    await this.findByIdOrThrow(id);
    try {
      return await this.prisma.withTenant(tenantId, (tx) =>
        tx.country.update({
          where: { id },
          data: {
            ...(dto.code !== undefined && { code: dto.code }),
            ...(dto.name !== undefined && { name: dto.name }),
            ...(dto.isActive !== undefined && { isActive: dto.isActive }),
          },
          select: COUNTRY_SELECT,
        }),
      );
    } catch (err) {
      throw remapUniqueViolation(err, dto.code ?? id);
    }
  }

  async delete(id: string) {
    const tenantId = requireTenantId();
    await this.findByIdOrThrow(id);
    try {
      await this.prisma.withTenant(tenantId, (tx) => tx.country.delete({ where: { id } }));
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003') {
        throw new ConflictException({
          code: 'country.in_use',
          message: 'Cannot delete a country that still has teams; deactivate it instead',
        });
      }
      throw err;
    }
  }
}

function remapUniqueViolation(err: unknown, code: string): unknown {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    return new ConflictException({
      code: 'country.duplicate_code',
      message: `A country with code "${code}" already exists under this company`,
    });
  }
  return err;
}
