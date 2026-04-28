import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { requireTenantId } from '../tenants/tenant-context';
import type { CapabilityCode } from './capabilities.registry';
import type { RoleCode } from './roles.registry';

export interface RoleWithCapabilities {
  id: string;
  code: RoleCode;
  nameAr: string;
  nameEn: string;
  level: number;
  isActive: boolean;
  capabilities: readonly CapabilityCode[];
}

/**
 * Read-side RBAC helpers. Reads pass through PrismaService.withTenant() so
 * the database honours its own RLS — the service does not maintain a
 * separate filter and cannot accidentally leak across tenants.
 *
 * The runtime guard / decorator that consumes these reads lands in C9
 * once authentication is wired and a JWT carries the user's role.
 */
@Injectable()
export class RbacService {
  constructor(private readonly prisma: PrismaService) {}

  /** All roles in the active tenant context. */
  async listRoles(): Promise<RoleWithCapabilities[]> {
    return this.prisma.withTenant(requireTenantId(), async (tx) => {
      const rows = await tx.role.findMany({
        where: { isActive: true },
        orderBy: [{ level: 'desc' }, { code: 'asc' }],
        include: {
          capabilities: {
            include: { capability: { select: { code: true } } },
          },
        },
      });
      return rows.map((r) => ({
        id: r.id,
        code: r.code as RoleCode,
        nameAr: r.nameAr,
        nameEn: r.nameEn,
        level: r.level,
        isActive: r.isActive,
        capabilities: r.capabilities.map((rc) => rc.capability.code as CapabilityCode),
      }));
    });
  }

  /** A single role by code in the active tenant context. */
  async getRoleByCode(code: RoleCode): Promise<RoleWithCapabilities | null> {
    return this.prisma.withTenant(requireTenantId(), async (tx) => {
      const r = await tx.role.findFirst({
        where: { code, isActive: true },
        include: {
          capabilities: {
            include: { capability: { select: { code: true } } },
          },
        },
      });
      if (!r) return null;
      return {
        id: r.id,
        code: r.code as RoleCode,
        nameAr: r.nameAr,
        nameEn: r.nameEn,
        level: r.level,
        isActive: r.isActive,
        capabilities: r.capabilities.map((rc) => rc.capability.code as CapabilityCode),
      };
    });
  }

  /** Capabilities are global — no tenant scope. */
  async listCapabilities() {
    return this.prisma.capability.findMany({
      orderBy: { code: 'asc' },
      select: { id: true, code: true, description: true },
    });
  }

  /** True iff the named role grants the requested capability in the active tenant. */
  async roleHas(roleCode: RoleCode, capability: CapabilityCode): Promise<boolean> {
    const role = await this.getRoleByCode(roleCode);
    return role?.capabilities.includes(capability) ?? false;
  }
}
