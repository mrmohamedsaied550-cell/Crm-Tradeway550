import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { requireTenantId } from '../tenants/tenant-context';
import { hashPassword } from '../identity/password.util';
import { TeamsService } from './teams.service';
import type { CreateUserDto, ListUsersQueryDto, UpdateUserDto } from './org.dto';

const SAFE_USER_SELECT = {
  id: true,
  tenantId: true,
  email: true,
  name: true,
  phone: true,
  language: true,
  roleId: true,
  teamId: true,
  status: true,
  mfaEnabled: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * AdminUsersService — admin-level CRUD on the tenant-scoped users table.
 *
 * Distinct from the read-only `UsersService` in src/users/. That one is
 * the auth-flow helper (findByEmail / verifyPassword); this one is the
 * write surface used by org admins. Both go through the same SafeUser
 * projection so the password hash never leaves the persistence layer.
 *
 * Validation rules:
 *   - The role must exist in the active tenant (RBAC catalogue).
 *   - When `teamId` is supplied, the team must exist in the active tenant.
 *   - Setting status='disabled' here is the one-shot deactivation path;
 *     it does NOT revoke active sessions (that lives in the auth module).
 */
@Injectable()
export class AdminUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly teams: TeamsService,
  ) {}

  async list(query: ListUsersQueryDto) {
    const tenantId = requireTenantId();
    const where: Prisma.UserWhereInput = {
      ...(query.teamId && { teamId: query.teamId }),
      ...(query.roleId && { roleId: query.roleId }),
      ...(query.status && { status: query.status }),
      ...(query.q && {
        OR: [
          { name: { contains: query.q, mode: 'insensitive' } },
          { email: { contains: query.q, mode: 'insensitive' } },
        ],
      }),
    };

    return this.prisma.withTenant(tenantId, async (tx) => {
      const [items, total] = await Promise.all([
        tx.user.findMany({
          where,
          select: SAFE_USER_SELECT,
          orderBy: { createdAt: 'desc' },
          take: query.limit,
          skip: query.offset,
        }),
        tx.user.count({ where }),
      ]);
      return { items, total, limit: query.limit, offset: query.offset };
    });
  }

  findById(id: string) {
    return this.prisma.withTenant(requireTenantId(), (tx) =>
      tx.user.findUnique({ where: { id }, select: SAFE_USER_SELECT }),
    );
  }

  async findByIdOrThrow(id: string) {
    const row = await this.findById(id);
    if (!row) {
      throw new NotFoundException({ code: 'user.not_found', message: `User not found: ${id}` });
    }
    return row;
  }

  async create(dto: CreateUserDto) {
    const tenantId = requireTenantId();
    await this.assertRoleInTenant(dto.roleId);
    if (dto.teamId) {
      await this.teams.findByIdOrThrow(dto.teamId);
    }
    const passwordHash = await hashPassword(dto.password);
    try {
      return await this.prisma.withTenant(tenantId, (tx) =>
        tx.user.create({
          data: {
            tenantId,
            email: dto.email,
            name: dto.name,
            passwordHash,
            roleId: dto.roleId,
            teamId: dto.teamId ?? null,
            phone: dto.phone ?? null,
            language: dto.language ?? 'en',
            status: dto.status ?? 'active',
          },
          select: SAFE_USER_SELECT,
        }),
      );
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException({
          code: 'user.duplicate_email',
          message: `A user with email "${dto.email}" already exists in this tenant`,
        });
      }
      throw err;
    }
  }

  async update(id: string, dto: UpdateUserDto) {
    const tenantId = requireTenantId();
    await this.findByIdOrThrow(id);
    if (dto.roleId !== undefined) {
      await this.assertRoleInTenant(dto.roleId);
    }
    if (dto.teamId) {
      await this.teams.findByIdOrThrow(dto.teamId);
    }

    return this.prisma.withTenant(tenantId, (tx) =>
      tx.user.update({
        where: { id },
        data: {
          ...(dto.name !== undefined && { name: dto.name }),
          ...(dto.roleId !== undefined && { roleId: dto.roleId }),
          // teamId === undefined → leave alone; null → clear.
          ...(dto.teamId !== undefined && { teamId: dto.teamId }),
          ...(dto.phone !== undefined && { phone: dto.phone }),
          ...(dto.language !== undefined && { language: dto.language }),
          ...(dto.status !== undefined && { status: dto.status }),
        },
        select: SAFE_USER_SELECT,
      }),
    );
  }

  async disable(id: string) {
    const tenantId = requireTenantId();
    await this.findByIdOrThrow(id);
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.user.update({
        where: { id },
        data: { status: 'disabled' },
        select: SAFE_USER_SELECT,
      }),
    );
  }

  async delete(id: string) {
    const tenantId = requireTenantId();
    await this.findByIdOrThrow(id);
    await this.prisma.withTenant(tenantId, (tx) => tx.user.delete({ where: { id } }));
  }

  private async assertRoleInTenant(roleId: string): Promise<void> {
    const tenantId = requireTenantId();
    const row = await this.prisma.withTenant(tenantId, (tx) =>
      tx.role.findUnique({ where: { id: roleId }, select: { id: true, isActive: true } }),
    );
    if (!row) {
      throw new BadRequestException({
        code: 'role.not_in_tenant',
        message: `Role ${roleId} is not defined in the active tenant`,
      });
    }
    if (!row.isActive) {
      throw new BadRequestException({
        code: 'role.inactive',
        message: `Role ${roleId} is not active`,
      });
    }
  }
}
