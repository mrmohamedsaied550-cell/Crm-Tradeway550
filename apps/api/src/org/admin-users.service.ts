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
import type { CreateUserDto, ListUsersQueryDto, UpdateUserDto, UserStatus } from './org.dto';

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
 * Tenant safety:
 *   - Every read/write goes through `prisma.withTenant(...)` so RLS catches
 *     cross-tenant attempts as a side-effect.
 *   - `roleId` and `teamId` writes pass through `assertRoleInTenant` and
 *     `assertTeamInTenant` first — both lookups run under the active GUC
 *     so a foreign id surfaces as a typed BadRequest / NotFound instead
 *     of leaking via a raw FK insert.
 *   - `enable` and `disable` are idempotent — calling them twice never
 *     errors and never writes a no-op activity log (we don't have a user
 *     activity log yet anyway).
 */
@Injectable()
export class AdminUsersService {
  constructor(private readonly prisma: PrismaService) {}

  // ───────────────────────────────────────────────────────────────────────
  // read / list
  // ───────────────────────────────────────────────────────────────────────

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

  // ───────────────────────────────────────────────────────────────────────
  // create / update / delete
  // ───────────────────────────────────────────────────────────────────────

  async create(dto: CreateUserDto) {
    const tenantId = requireTenantId();
    await this.assertRoleInTenant(dto.roleId);
    if (dto.teamId) {
      await this.assertTeamInTenant(dto.teamId);
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
    // teamId === undefined → unchanged; null → clear (no validation needed);
    // string → must resolve to a team in the active tenant.
    if (typeof dto.teamId === 'string') {
      await this.assertTeamInTenant(dto.teamId);
    }

    return this.prisma.withTenant(tenantId, (tx) =>
      tx.user.update({
        where: { id },
        data: {
          ...(dto.name !== undefined && { name: dto.name }),
          ...(dto.roleId !== undefined && { roleId: dto.roleId }),
          ...(dto.teamId !== undefined && { teamId: dto.teamId }),
          ...(dto.phone !== undefined && { phone: dto.phone }),
          ...(dto.language !== undefined && { language: dto.language }),
          ...(dto.status !== undefined && { status: dto.status }),
        },
        select: SAFE_USER_SELECT,
      }),
    );
  }

  async delete(id: string) {
    const tenantId = requireTenantId();
    await this.findByIdOrThrow(id);
    await this.prisma.withTenant(tenantId, (tx) => tx.user.delete({ where: { id } }));
  }

  // ───────────────────────────────────────────────────────────────────────
  // focused mutations — used by the admin UI's per-row action menu
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Set the user's role. Validates the new role belongs to the active
   * tenant before writing; surfaces `role.not_in_tenant` BadRequest on
   * cross-tenant attempts (RLS would also reject, but the typed error is
   * nicer for the UI).
   */
  async setRole(id: string, roleId: string) {
    const tenantId = requireTenantId();
    await this.findByIdOrThrow(id);
    await this.assertRoleInTenant(roleId);
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.user.update({
        where: { id },
        data: { roleId },
        select: SAFE_USER_SELECT,
      }),
    );
  }

  /**
   * Set or clear the user's team. Pass `null` to detach. Validates the
   * new team belongs to the active tenant; cross-tenant ids surface as
   * `team.not_in_tenant` NotFound.
   */
  async setTeam(id: string, teamId: string | null) {
    const tenantId = requireTenantId();
    await this.findByIdOrThrow(id);
    if (teamId !== null) {
      await this.assertTeamInTenant(teamId);
    }
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.user.update({
        where: { id },
        data: { teamId },
        select: SAFE_USER_SELECT,
      }),
    );
  }

  /** Set the user's status to one of `active | invited | disabled`. Idempotent. */
  async setStatus(id: string, status: UserStatus) {
    const tenantId = requireTenantId();
    await this.findByIdOrThrow(id);
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.user.update({
        where: { id },
        data: { status },
        select: SAFE_USER_SELECT,
      }),
    );
  }

  /** Set status='disabled'. Does NOT revoke active sessions (handled elsewhere). */
  disable(id: string) {
    return this.setStatus(id, 'disabled');
  }

  /** Set status='active'. Useful for re-enabling a previously disabled user. */
  enable(id: string) {
    return this.setStatus(id, 'active');
  }

  // ───────────────────────────────────────────────────────────────────────
  // private guards
  // ───────────────────────────────────────────────────────────────────────

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

  /**
   * Cross-tenant guard for team writes. Mirrors `assertRoleInTenant` so the
   * UI sees a stable shape (`{code,message}`) for both kinds of foreign-id
   * rejection.
   */
  private async assertTeamInTenant(teamId: string): Promise<void> {
    const tenantId = requireTenantId();
    const row = await this.prisma.withTenant(tenantId, (tx) =>
      tx.team.findUnique({ where: { id: teamId }, select: { id: true, isActive: true } }),
    );
    if (!row) {
      throw new NotFoundException({
        code: 'team.not_in_tenant',
        message: `Team ${teamId} is not defined in the active tenant`,
      });
    }
    if (!row.isActive) {
      throw new BadRequestException({
        code: 'team.inactive',
        message: `Team ${teamId} is not active`,
      });
    }
  }
}
