import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { requireTenantId } from '../tenants/tenant-context';
import type { CreateCompanyDto, UpdateCompanyDto } from './org.dto';

const COMPANY_SELECT = {
  id: true,
  tenantId: true,
  code: true,
  name: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * CompaniesService — tenant-scoped CRUD on the partner-company catalogue.
 *
 * Every read/write is wrapped in `prisma.withTenant(...)` so the database's
 * RLS policy enforces isolation. The unique `(tenantId, code)` constraint is
 * surfaced as a typed `ConflictException` so the controller can return a
 * 409 with a stable error code without re-checking the DB.
 */
@Injectable()
export class CompaniesService {
  constructor(private readonly prisma: PrismaService) {}

  list() {
    return this.prisma.withTenant(requireTenantId(), (tx) =>
      tx.company.findMany({
        select: COMPANY_SELECT,
        orderBy: [{ isActive: 'desc' }, { code: 'asc' }],
      }),
    );
  }

  findById(id: string) {
    return this.prisma.withTenant(requireTenantId(), (tx) =>
      tx.company.findUnique({ where: { id }, select: COMPANY_SELECT }),
    );
  }

  async findByIdOrThrow(id: string) {
    const row = await this.findById(id);
    if (!row) {
      throw new NotFoundException({
        code: 'company.not_found',
        message: `Company not found: ${id}`,
      });
    }
    return row;
  }

  async create(dto: CreateCompanyDto) {
    const tenantId = requireTenantId();
    try {
      return await this.prisma.withTenant(tenantId, (tx) =>
        tx.company.create({
          data: {
            tenantId,
            code: dto.code,
            name: dto.name,
            isActive: dto.isActive ?? true,
          },
          select: COMPANY_SELECT,
        }),
      );
    } catch (err) {
      throw remapUniqueViolation(err, dto.code);
    }
  }

  async update(id: string, dto: UpdateCompanyDto) {
    const tenantId = requireTenantId();
    await this.findByIdOrThrow(id);
    try {
      return await this.prisma.withTenant(tenantId, (tx) =>
        tx.company.update({
          where: { id },
          data: {
            ...(dto.code !== undefined && { code: dto.code }),
            ...(dto.name !== undefined && { name: dto.name }),
            ...(dto.isActive !== undefined && { isActive: dto.isActive }),
          },
          select: COMPANY_SELECT,
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
      await this.prisma.withTenant(tenantId, (tx) => tx.company.delete({ where: { id } }));
    } catch (err) {
      // Postgres FK violation: the company still has countries hanging off it.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003') {
        throw new ConflictException({
          code: 'company.in_use',
          message: 'Cannot delete a company that still has countries; deactivate it instead',
        });
      }
      throw err;
    }
  }
}

function remapUniqueViolation(err: unknown, code: string): unknown {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    return new ConflictException({
      code: 'company.duplicate_code',
      message: `A company with code "${code}" already exists in this tenant`,
    });
  }
  return err;
}
