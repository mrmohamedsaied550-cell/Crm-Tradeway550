import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { requireTenantId } from '../tenants/tenant-context';
import { CountriesService } from './countries.service';
import type { CreateTeamDto, ListTeamsQueryDto, UpdateTeamDto } from './org.dto';

const TEAM_SELECT = {
  id: true,
  tenantId: true,
  countryId: true,
  name: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * TeamsService — tenant-scoped CRUD on team rows.
 *
 * `countryId` is validated through CountriesService under the active GUC,
 * so a cross-tenant FK is rejected as 404. Uniqueness is on
 * `(tenant, country, name)` — same team name (e.g. "Sales") may live under
 * different (Company × Country) units in one tenant.
 */
@Injectable()
export class TeamsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly countries: CountriesService,
  ) {}

  list(query: ListTeamsQueryDto = {}) {
    return this.prisma.withTenant(requireTenantId(), (tx) =>
      tx.team.findMany({
        where: { ...(query.countryId && { countryId: query.countryId }) },
        select: TEAM_SELECT,
        orderBy: [{ countryId: 'asc' }, { name: 'asc' }],
      }),
    );
  }

  findById(id: string) {
    return this.prisma.withTenant(requireTenantId(), (tx) =>
      tx.team.findUnique({ where: { id }, select: TEAM_SELECT }),
    );
  }

  async findByIdOrThrow(id: string) {
    const row = await this.findById(id);
    if (!row) {
      throw new NotFoundException({ code: 'team.not_found', message: `Team not found: ${id}` });
    }
    return row;
  }

  async create(dto: CreateTeamDto) {
    const tenantId = requireTenantId();
    await this.countries.findByIdOrThrow(dto.countryId);
    try {
      return await this.prisma.withTenant(tenantId, (tx) =>
        tx.team.create({
          data: {
            tenantId,
            countryId: dto.countryId,
            name: dto.name,
            isActive: dto.isActive ?? true,
          },
          select: TEAM_SELECT,
        }),
      );
    } catch (err) {
      throw remapUniqueViolation(err, dto.name);
    }
  }

  async update(id: string, dto: UpdateTeamDto) {
    const tenantId = requireTenantId();
    await this.findByIdOrThrow(id);
    try {
      return await this.prisma.withTenant(tenantId, (tx) =>
        tx.team.update({
          where: { id },
          data: {
            ...(dto.name !== undefined && { name: dto.name }),
            ...(dto.isActive !== undefined && { isActive: dto.isActive }),
          },
          select: TEAM_SELECT,
        }),
      );
    } catch (err) {
      throw remapUniqueViolation(err, dto.name ?? id);
    }
  }

  async delete(id: string) {
    const tenantId = requireTenantId();
    await this.findByIdOrThrow(id);
    // Users in this team get team_id NULLed out via the FK ON DELETE SET NULL.
    await this.prisma.withTenant(tenantId, (tx) => tx.team.delete({ where: { id } }));
  }
}

function remapUniqueViolation(err: unknown, name: string): unknown {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    return new ConflictException({
      code: 'team.duplicate_name',
      message: `A team named "${name}" already exists under this country`,
    });
  }
  return err;
}
