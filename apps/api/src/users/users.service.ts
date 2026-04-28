import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RbacService, type RoleWithCapabilities } from '../rbac/rbac.service';
import { requireTenantId } from '../tenants/tenant-context';
import { verifyPassword } from '../identity/password.util';

/**
 * Public user view — never includes the password hash or MFA secret.
 *
 * The shape is deliberately stable: any future additions to the `User`
 * model (vacation_dates, weights, etc. in later sprints) must be opt-in
 * via dedicated mappers so that `passwordHash` / `mfaSecret` cannot leak
 * by accident.
 */
export interface SafeUser {
  id: string;
  tenantId: string;
  email: string;
  name: string;
  phone: string | null;
  language: string;
  roleId: string;
  status: string;
  mfaEnabled: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const SAFE_USER_SELECT = {
  id: true,
  tenantId: true,
  email: true,
  name: true,
  phone: true,
  language: true,
  roleId: true,
  status: true,
  mfaEnabled: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * UsersService — read helpers for the tenant-scoped `users` table.
 *
 * All queries pass through `PrismaService.withTenant(requireTenantId(), ...)`
 * so the database itself enforces isolation via RLS. The service can never
 * accidentally leak data across tenants.
 *
 * The internal `findByEmailWithSecrets` is the ONLY method that returns the
 * password hash. It exists for the login flow that lands in C9 — no other
 * caller may use it.
 */
@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
  ) {}

  /** Public lookups — never expose the password hash. */
  async findById(id: string): Promise<SafeUser | null> {
    return this.prisma.withTenant(requireTenantId(), (tx) =>
      tx.user.findUnique({ where: { id }, select: SAFE_USER_SELECT }),
    );
  }

  async findByEmail(email: string): Promise<SafeUser | null> {
    const normalized = normalizeEmail(email);
    return this.prisma.withTenant(requireTenantId(), (tx) =>
      tx.user.findUnique({
        where: { tenantId_email: { tenantId: requireTenantId(), email: normalized } },
        select: SAFE_USER_SELECT,
      }),
    );
  }

  /**
   * INTERNAL — returns the user *plus* the bcrypt hash so the login flow
   * can verify the password. NOT exposed via any controller. Keep this
   * the only function in the codebase that selects `passwordHash`.
   */
  async findByEmailWithSecrets(
    email: string,
  ): Promise<(SafeUser & { passwordHash: string }) | null> {
    const normalized = normalizeEmail(email);
    const tenantId = requireTenantId();
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.user.findUnique({
        where: { tenantId_email: { tenantId, email: normalized } },
        select: { ...SAFE_USER_SELECT, passwordHash: true },
      }),
    );
  }

  /**
   * Verify a plaintext password against the stored hash for a given user id.
   * Returns false on any failure (unknown user, wrong password, missing
   * hash) — callers don't need to special-case the reasons.
   */
  async verifyPasswordById(userId: string, plain: string): Promise<boolean> {
    const tenantId = requireTenantId();
    const row = await this.prisma.withTenant(tenantId, (tx) =>
      tx.user.findUnique({ where: { id: userId }, select: { passwordHash: true } }),
    );
    if (!row) return false;
    return verifyPassword(plain, row.passwordHash);
  }

  /** Look up the user's role and the capability codes it grants. */
  async getRoleWithCapabilities(userId: string): Promise<RoleWithCapabilities | null> {
    const user = await this.findById(userId);
    if (!user) return null;
    const roles = await this.rbac.listRoles();
    return roles.find((r) => r.id === user.roleId) ?? null;
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
