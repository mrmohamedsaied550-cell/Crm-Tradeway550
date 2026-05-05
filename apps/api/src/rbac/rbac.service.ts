import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { requireTenantId } from '../tenants/tenant-context';

import type { CapabilityCode } from './capabilities.registry';
import { PermissionCacheService } from './permission-cache.service';
import { ROLE_DEFINITIONS, type RoleCode, ALL_ROLE_CODES } from './roles.registry';
import type {
  CreateRoleDto,
  DuplicateRoleDto,
  PutRoleFieldPermissionsDto,
  PutRoleScopesDto,
  RoleScopeResource,
  RoleScopeValue,
  UpdateRoleDto,
} from './rbac.dto';
import { ROLE_SCOPE_RESOURCES } from './rbac.dto';

/** The 11 system role codes — reserved at create + duplicate time. */
const SYSTEM_ROLE_CODES: ReadonlySet<string> = new Set(ALL_ROLE_CODES);

/** Phase C — C1 default scope for newly-created roles when not specified. */
const DEFAULT_SCOPE: RoleScopeValue = 'global';

export interface RoleScopeRow {
  resource: RoleScopeResource;
  scope: RoleScopeValue;
}

export interface RoleFieldPermissionRow {
  resource: string;
  field: string;
  canRead: boolean;
  canWrite: boolean;
}

export interface RoleWithCapabilities {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  level: number;
  isActive: boolean;
  isSystem: boolean;
  description: string | null;
  capabilities: readonly string[];
  scopes: readonly RoleScopeRow[];
  fieldPermissions: readonly RoleFieldPermissionRow[];
}

/**
 * Lightweight role view returned by `GET /rbac/roles` (C14).
 * Carries only what the admin UI's role picker needs — the full
 * capabilities list is not embedded so the response stays small for
 * tenants with many capabilities.
 */
export interface RoleSummary {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  level: number;
  isSystem: boolean;
  description: string | null;
  capabilitiesCount: number;
}

/**
 * Read-side RBAC helpers + Phase C — C2 write surface.
 *
 * Reads pass through PrismaService.withTenant() so RLS gates every
 * fetch. Writes go through the same chokepoint and emit AuditEvent
 * rows for every role / capability / scope / field-permission
 * mutation. Immutability of the 11 system roles is enforced here at
 * the service layer — the migration's `is_system = true` flag is
 * the source of truth; controllers don't get a chance to bypass.
 */
@Injectable()
export class RbacService {
  constructor(
    private readonly prisma: PrismaService,
    /**
     * Phase C — C2: audit emission for every role/scope/field
     * mutation. @Optional so the existing rbac.test.ts fixture
     * (`new RbacService(new PrismaService())`) keeps compiling for
     * read-only checks. Write paths throw a clear error when the
     * dependency is missing.
     */
    @Optional() private readonly audit?: AuditService,
    /**
     * Phase D5 — D5.1: permission cache invalidator. @Optional so
     * existing test fixtures (which build RbacService directly)
     * keep compiling without wiring it. When provided, every
     * mutation that affects a role's resolved permissions calls
     * `permissionCache.invalidateRole(...)` so the next
     * resolver lookup sees fresh data.
     */
    @Optional() private readonly permissionCache?: PermissionCacheService,
  ) {}

  /**
   * Convenience accessor — write paths require AuditService. Throws
   * a clear error when a test fixture forgot to wire it instead of
   * silently skipping the audit row.
   */
  private requireAudit(): AuditService {
    if (!this.audit) {
      throw new Error(
        'RbacService write paths require AuditService — production wiring (RbacModule) provides it; tests for write paths must construct with `new RbacService(prisma, audit)`.',
      );
    }
    return this.audit;
  }

  // ───────────────────────────────────────────────────────────────────
  // Read helpers (existing surface preserved)
  // ───────────────────────────────────────────────────────────────────

  /** All roles in the active tenant context (active only). */
  async listRoles(): Promise<RoleWithCapabilities[]> {
    return this.prisma.withTenant(requireTenantId(), async (tx) => {
      const rows = await tx.role.findMany({
        where: { isActive: true },
        orderBy: [{ level: 'desc' }, { code: 'asc' }],
        include: {
          capabilities: { include: { capability: { select: { code: true } } } },
          scopes: { select: { resource: true, scope: true } },
          fieldPermissions: {
            select: { resource: true, field: true, canRead: true, canWrite: true },
          },
        },
      });
      return rows.map((r) => this.shapeRole(r));
    });
  }

  /**
   * Lightweight roles list for the admin UI's role picker.
   *
   * Returns active roles ordered by `level DESC, code ASC` (highest rank
   * first), each with a capability count instead of the full capability
   * code list to keep the payload small.
   */
  async listRoleSummaries(): Promise<RoleSummary[]> {
    return this.prisma.withTenant(requireTenantId(), async (tx) => {
      const rows = await tx.role.findMany({
        where: { isActive: true },
        orderBy: [{ level: 'desc' }, { code: 'asc' }],
        select: {
          id: true,
          code: true,
          nameAr: true,
          nameEn: true,
          level: true,
          isSystem: true,
          description: true,
          _count: { select: { capabilities: true } },
        },
      });
      return rows.map((r) => ({
        id: r.id,
        code: r.code,
        nameAr: r.nameAr,
        nameEn: r.nameEn,
        level: r.level,
        isSystem: r.isSystem,
        description: r.description,
        capabilitiesCount: r._count.capabilities,
      }));
    });
  }

  /** A single role by code in the active tenant context. */
  async getRoleByCode(code: RoleCode): Promise<RoleWithCapabilities | null> {
    return this.prisma.withTenant(requireTenantId(), async (tx) => {
      const r = await tx.role.findFirst({
        where: { code, isActive: true },
        include: {
          capabilities: { include: { capability: { select: { code: true } } } },
          scopes: { select: { resource: true, scope: true } },
          fieldPermissions: {
            select: { resource: true, field: true, canRead: true, canWrite: true },
          },
        },
      });
      if (!r) return null;
      return this.shapeRole(r);
    });
  }

  /** A single role by id (active-state agnostic). Returns null when not found. */
  async findRoleById(id: string): Promise<RoleWithCapabilities | null> {
    return this.prisma.withTenant(requireTenantId(), async (tx) => {
      const r = await tx.role.findUnique({
        where: { id },
        include: {
          capabilities: { include: { capability: { select: { code: true } } } },
          scopes: { select: { resource: true, scope: true } },
          fieldPermissions: {
            select: { resource: true, field: true, canRead: true, canWrite: true },
          },
        },
      });
      if (!r) return null;
      return this.shapeRole(r);
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

  // ───────────────────────────────────────────────────────────────────
  // Phase C — C2 write surface
  // ───────────────────────────────────────────────────────────────────

  /**
   * POST /rbac/roles — create a custom (non-system) role.
   *
   * Guards:
   *   • code must not collide with the 11 system codes (`role.code_reserved`).
   *   • code must be unique per tenant (`role.code_taken`).
   *   • every supplied capability must exist in the global catalogue
   *     (`role.capability_unknown`).
   *
   * Side-effects:
   *   • role_scopes upsert per resource — supplied entries first, then
   *     'global' default for any resource the caller omitted.
   *   • field_permissions upsert when supplied.
   *   • audit `role.create` with the full materialised payload.
   */
  async createRole(dto: CreateRoleDto, actorUserId: string): Promise<RoleWithCapabilities> {
    const tenantId = requireTenantId();
    if (SYSTEM_ROLE_CODES.has(dto.code)) {
      throw new ConflictException({
        code: 'role.code_reserved',
        message: `code "${dto.code}" is reserved by a system role`,
      });
    }

    return this.prisma.withTenant(tenantId, async (tx) => {
      // Validate every supplied capability up front — better error
      // surface than a foreign-key violation deep in createMany.
      const capCodes = Array.from(new Set(dto.capabilities ?? []));
      const capRows = await this.resolveCapabilityIds(tx, capCodes);

      // Tenant-scoped uniqueness check.
      const dup = await tx.role.findUnique({
        where: { tenantId_code: { tenantId, code: dto.code } },
      });
      if (dup) {
        throw new ConflictException({
          code: 'role.code_taken',
          message: `code "${dto.code}" already exists in this tenant`,
        });
      }

      const created = await tx.role.create({
        data: {
          tenantId,
          code: dto.code,
          nameEn: dto.nameEn,
          nameAr: dto.nameAr,
          level: dto.level,
          description: dto.description ?? null,
          isSystem: false,
          isActive: true,
        },
      });

      if (capRows.length > 0) {
        await tx.roleCapability.createMany({
          data: capRows.map((c) => ({
            tenantId,
            roleId: created.id,
            capabilityId: c.id,
          })),
        });
      }

      // Materialise the scopes — caller-supplied values first; remaining
      // resources fall back to 'global' so every (role × resource) row
      // exists from day one.
      const supplied = new Map<string, RoleScopeValue>(
        (dto.scopes ?? []).map((s) => [s.resource, s.scope]),
      );
      const scopeRows = ROLE_SCOPE_RESOURCES.map((resource) => ({
        tenantId,
        roleId: created.id,
        resource,
        scope: supplied.get(resource) ?? DEFAULT_SCOPE,
      }));
      await tx.roleScope.createMany({ data: scopeRows });

      if ((dto.fieldPermissions ?? []).length > 0) {
        await tx.fieldPermission.createMany({
          data: (dto.fieldPermissions ?? []).map((p) => ({
            tenantId,
            roleId: created.id,
            resource: p.resource,
            field: p.field,
            canRead: p.canRead,
            canWrite: p.canWrite,
          })),
        });
      }

      await this.requireAudit().writeInTx(tx, tenantId, {
        action: 'role.create',
        entityType: 'role',
        entityId: created.id,
        actorUserId,
        payload: {
          code: created.code,
          nameEn: created.nameEn,
          nameAr: created.nameAr,
          level: created.level,
          capabilityCount: capRows.length,
          scopeCount: scopeRows.length,
          fieldPermissionCount: (dto.fieldPermissions ?? []).length,
        },
      });

      const reloaded = await tx.role.findUnique({
        where: { id: created.id },
        include: {
          capabilities: { include: { capability: { select: { code: true } } } },
          scopes: { select: { resource: true, scope: true } },
          fieldPermissions: {
            select: { resource: true, field: true, canRead: true, canWrite: true },
          },
        },
      });
      return this.shapeRole(reloaded!);
    });
  }

  /**
   * PATCH /rbac/roles/:id — metadata + capability replacement.
   *
   * Guards:
   *   • role must exist (`role.not_found`).
   *   • system roles reject every key (`role.system_immutable`).
   *
   * Side-effects:
   *   • metadata audit `role.update` when nameEn/nameAr/level/description change.
   *   • capability audit `role.capability.update` when capabilities change
   *     (granted + revoked sets included in payload).
   */
  async updateRole(
    id: string,
    dto: UpdateRoleDto,
    actorUserId: string,
  ): Promise<RoleWithCapabilities> {
    const tenantId = requireTenantId();

    return this.prisma.withTenant(tenantId, async (tx) => {
      const before = await tx.role.findUnique({
        where: { id },
        include: {
          capabilities: { include: { capability: { select: { code: true } } } },
        },
      });
      if (!before) {
        throw new NotFoundException({ code: 'role.not_found', message: `Role ${id} not found` });
      }
      if (before.isSystem) {
        throw new BadRequestException({
          code: 'role.system_immutable',
          message: 'System roles are immutable; duplicate the role to customise',
        });
      }

      // Metadata patch (only the fields the caller actually sent).
      const metaPatch: Prisma.RoleUncheckedUpdateInput = {};
      if (dto.nameEn !== undefined) metaPatch.nameEn = dto.nameEn;
      if (dto.nameAr !== undefined) metaPatch.nameAr = dto.nameAr;
      if (dto.level !== undefined) metaPatch.level = dto.level;
      if (dto.description !== undefined) metaPatch.description = dto.description ?? null;

      const metaTouched = Object.keys(metaPatch).length > 0;
      if (metaTouched) {
        await tx.role.update({ where: { id }, data: metaPatch });
        await this.requireAudit().writeInTx(tx, tenantId, {
          action: 'role.update',
          entityType: 'role',
          entityId: id,
          actorUserId,
          payload: {
            ...(dto.nameEn !== undefined && { nameEn: dto.nameEn }),
            ...(dto.nameAr !== undefined && { nameAr: dto.nameAr }),
            ...(dto.level !== undefined && { level: dto.level }),
            ...(dto.description !== undefined && { description: dto.description ?? null }),
          },
        });
      }

      if (dto.capabilities !== undefined) {
        const desired = Array.from(new Set(dto.capabilities));
        const desiredRows = await this.resolveCapabilityIds(tx, desired);
        const previous = new Set(before.capabilities.map((rc) => rc.capability.code));
        const next = new Set(desired);
        const granted = desired.filter((c) => !previous.has(c));
        const revoked = Array.from(previous).filter((c) => !next.has(c));

        await tx.roleCapability.deleteMany({ where: { roleId: id } });
        if (desiredRows.length > 0) {
          await tx.roleCapability.createMany({
            data: desiredRows.map((c) => ({
              tenantId,
              roleId: id,
              capabilityId: c.id,
            })),
          });
        }

        await this.requireAudit().writeInTx(tx, tenantId, {
          action: 'role.capability.update',
          entityType: 'role',
          entityId: id,
          actorUserId,
          payload: { granted, revoked, finalCount: desired.length },
        });
      }

      const reloaded = await tx.role.findUnique({
        where: { id },
        include: {
          capabilities: { include: { capability: { select: { code: true } } } },
          scopes: { select: { resource: true, scope: true } },
          fieldPermissions: {
            select: { resource: true, field: true, canRead: true, canWrite: true },
          },
        },
      });
      // Phase D5 — D5.1: invalidate the resolver cache for this role
      // so the next request sees the new bundle. Safe no-op when the
      // cache provider isn't wired (older test fixtures).
      this.permissionCache?.invalidateRole(id, tenantId);
      return this.shapeRole(reloaded!);
    });
  }

  /**
   * DELETE /rbac/roles/:id.
   *
   * Guards:
   *   • role must exist (`role.not_found`).
   *   • system roles cannot be deleted (`role.system_immutable`).
   *   • role must have zero assigned users (`role.has_users`).
   *
   * Cascade: role_capabilities, role_scopes, field_permissions cascade
   * via the FKs (ON DELETE CASCADE in the migration).
   */
  async deleteRole(id: string, actorUserId: string): Promise<void> {
    const tenantId = requireTenantId();

    await this.prisma.withTenant(tenantId, async (tx) => {
      const role = await tx.role.findUnique({
        where: { id },
        select: { id: true, code: true, isSystem: true },
      });
      if (!role) {
        throw new NotFoundException({ code: 'role.not_found', message: `Role ${id} not found` });
      }
      if (role.isSystem) {
        throw new BadRequestException({
          code: 'role.system_immutable',
          message: 'System roles cannot be deleted',
        });
      }
      const userCount = await tx.user.count({ where: { roleId: id } });
      if (userCount > 0) {
        throw new BadRequestException({
          code: 'role.has_users',
          message: `Role has ${userCount} user(s); reassign them before deleting`,
        });
      }

      await tx.role.delete({ where: { id } });
      await this.requireAudit().writeInTx(tx, tenantId, {
        action: 'role.delete',
        entityType: 'role',
        entityId: id,
        actorUserId,
        payload: { code: role.code },
      });
      // Phase D5 — D5.1: drop any cached resolutions for the deleted
      // role. New entries can't be written for it (the resolver's
      // zero-bundle path skips caching) but lingering hits would
      // serve stale capabilities.
      this.permissionCache?.invalidateRole(id, tenantId);
    });
  }

  /**
   * POST /rbac/roles/:id/duplicate — clone a role (system or custom)
   * into a new editable (`isSystem = false`) role.
   *
   * Copies: capabilities, scopes, field permissions. Description
   * defaults to the source's unless overridden in the body.
   *
   * Guards:
   *   • source must exist.
   *   • new code must not collide with system codes / existing tenant codes.
   */
  async duplicateRole(
    sourceId: string,
    dto: DuplicateRoleDto,
    actorUserId: string,
  ): Promise<RoleWithCapabilities> {
    const tenantId = requireTenantId();
    if (SYSTEM_ROLE_CODES.has(dto.code)) {
      throw new ConflictException({
        code: 'role.code_reserved',
        message: `code "${dto.code}" is reserved by a system role`,
      });
    }

    return this.prisma.withTenant(tenantId, async (tx) => {
      const source = await tx.role.findUnique({
        where: { id: sourceId },
        include: {
          capabilities: { select: { capabilityId: true } },
          scopes: { select: { resource: true, scope: true } },
          fieldPermissions: {
            select: { resource: true, field: true, canRead: true, canWrite: true },
          },
        },
      });
      if (!source) {
        throw new NotFoundException({
          code: 'role.not_found',
          message: `Source role ${sourceId} not found`,
        });
      }

      const dup = await tx.role.findUnique({
        where: { tenantId_code: { tenantId, code: dto.code } },
      });
      if (dup) {
        throw new ConflictException({
          code: 'role.code_taken',
          message: `code "${dto.code}" already exists in this tenant`,
        });
      }

      const created = await tx.role.create({
        data: {
          tenantId,
          code: dto.code,
          nameEn: dto.nameEn,
          nameAr: dto.nameAr,
          level: source.level,
          description: dto.description ?? source.description ?? null,
          isSystem: false,
          isActive: true,
        },
      });

      if (source.capabilities.length > 0) {
        await tx.roleCapability.createMany({
          data: source.capabilities.map((c) => ({
            tenantId,
            roleId: created.id,
            capabilityId: c.capabilityId,
          })),
        });
      }
      if (source.scopes.length > 0) {
        await tx.roleScope.createMany({
          data: source.scopes.map((s) => ({
            tenantId,
            roleId: created.id,
            resource: s.resource,
            scope: s.scope,
          })),
        });
      }
      if (source.fieldPermissions.length > 0) {
        await tx.fieldPermission.createMany({
          data: source.fieldPermissions.map((p) => ({
            tenantId,
            roleId: created.id,
            resource: p.resource,
            field: p.field,
            canRead: p.canRead,
            canWrite: p.canWrite,
          })),
        });
      }

      await this.requireAudit().writeInTx(tx, tenantId, {
        action: 'role.duplicate',
        entityType: 'role',
        entityId: created.id,
        actorUserId,
        payload: {
          sourceRoleId: sourceId,
          sourceCode: source.code,
          newCode: created.code,
          capabilityCount: source.capabilities.length,
          scopeCount: source.scopes.length,
          fieldPermissionCount: source.fieldPermissions.length,
        },
      });

      const reloaded = await tx.role.findUnique({
        where: { id: created.id },
        include: {
          capabilities: { include: { capability: { select: { code: true } } } },
          scopes: { select: { resource: true, scope: true } },
          fieldPermissions: {
            select: { resource: true, field: true, canRead: true, canWrite: true },
          },
        },
      });
      return this.shapeRole(reloaded!);
    });
  }

  /**
   * PUT /rbac/roles/:id/scopes — atomic replace of the role's scope set.
   *
   * Each row in the request upserts (resource, scope). Resources not
   * mentioned in the request keep their existing rows — this is a
   * patch, not a full overwrite — but the DTO requires at least one
   * row so callers can't accidentally clear everything.
   *
   * Guards:
   *   • role must exist.
   *   • system roles reject (`role.system_immutable`).
   */
  async putRoleScopes(
    id: string,
    dto: PutRoleScopesDto,
    actorUserId: string,
  ): Promise<RoleScopeRow[]> {
    const tenantId = requireTenantId();

    return this.prisma.withTenant(tenantId, async (tx) => {
      const role = await tx.role.findUnique({
        where: { id },
        select: { id: true, isSystem: true, scopes: { select: { resource: true, scope: true } } },
      });
      if (!role) {
        throw new NotFoundException({ code: 'role.not_found', message: `Role ${id} not found` });
      }
      if (role.isSystem) {
        throw new BadRequestException({
          code: 'role.system_immutable',
          message: 'System roles are immutable; duplicate the role to customise',
        });
      }

      // Compute the diff between the existing rows and the request,
      // for the audit payload.
      const before = new Map(role.scopes.map((s) => [s.resource, s.scope]));
      const changes: Array<{
        resource: string;
        from: string | null;
        to: string;
      }> = [];
      for (const next of dto.scopes) {
        const prev = before.get(next.resource) ?? null;
        if (prev !== next.scope) {
          changes.push({ resource: next.resource, from: prev, to: next.scope });
        }
      }

      // Upsert each (role, resource) row.
      for (const next of dto.scopes) {
        await tx.roleScope.upsert({
          where: { roleId_resource: { roleId: id, resource: next.resource } },
          update: { scope: next.scope },
          create: {
            tenantId,
            roleId: id,
            resource: next.resource,
            scope: next.scope,
          },
        });
      }

      await this.requireAudit().writeInTx(tx, tenantId, {
        action: 'role.scope.update',
        entityType: 'role',
        entityId: id,
        actorUserId,
        payload: { changes, requested: dto.scopes },
      });

      const after = await tx.roleScope.findMany({
        where: { roleId: id },
        select: { resource: true, scope: true },
      });
      // Phase D5 — D5.1: scope changes invalidate every cached
      // resolution for this role.
      this.permissionCache?.invalidateRole(id, tenantId);
      return after.map((r) => ({
        resource: r.resource as RoleScopeResource,
        scope: r.scope as RoleScopeValue,
      }));
    });
  }

  /**
   * PUT /rbac/roles/:id/field-permissions — atomic replace of the
   * role's per-(resource, field) overrides.
   *
   * The full set in the request becomes the new set: any (resource,
   * field) row not present in the request is deleted (default
   * read=true / write=true takes over).
   *
   * Guards:
   *   • role must exist.
   *   • system roles reject (`role.system_immutable`).
   */
  async putRoleFieldPermissions(
    id: string,
    dto: PutRoleFieldPermissionsDto,
    actorUserId: string,
  ): Promise<RoleFieldPermissionRow[]> {
    const tenantId = requireTenantId();

    return this.prisma.withTenant(tenantId, async (tx) => {
      const role = await tx.role.findUnique({
        where: { id },
        select: { id: true, isSystem: true },
      });
      if (!role) {
        throw new NotFoundException({ code: 'role.not_found', message: `Role ${id} not found` });
      }
      if (role.isSystem) {
        throw new BadRequestException({
          code: 'role.system_immutable',
          message: 'System roles are immutable; duplicate the role to customise',
        });
      }

      const before = await tx.fieldPermission.findMany({
        where: { roleId: id },
        select: { resource: true, field: true, canRead: true, canWrite: true },
      });

      // Replace strategy: drop everything and re-create. Atomic inside
      // the tx, simpler than diffing and equally correct because the
      // table is bounded (~ tens of rows max).
      await tx.fieldPermission.deleteMany({ where: { roleId: id } });
      if (dto.permissions.length > 0) {
        await tx.fieldPermission.createMany({
          data: dto.permissions.map((p) => ({
            tenantId,
            roleId: id,
            resource: p.resource,
            field: p.field,
            canRead: p.canRead,
            canWrite: p.canWrite,
          })),
        });
      }

      await this.requireAudit().writeInTx(tx, tenantId, {
        action: 'role.field.update',
        entityType: 'role',
        entityId: id,
        actorUserId,
        payload: {
          before,
          after: dto.permissions,
          beforeCount: before.length,
          afterCount: dto.permissions.length,
        },
      });

      // Phase D5 — D5.1: field-permission changes invalidate every
      // cached resolution for this role.
      this.permissionCache?.invalidateRole(id, tenantId);

      return dto.permissions.map((p) => ({
        resource: p.resource,
        field: p.field,
        canRead: p.canRead,
        canWrite: p.canWrite,
      }));
    });
  }

  // ───────────────────────────────────────────────────────────────────
  // helpers
  // ───────────────────────────────────────────────────────────────────

  /**
   * Resolve capability codes to (id, code) rows. Throws when any code
   * is not found in the global catalogue. Capabilities are global so
   * the lookup runs without tenant context.
   */
  private async resolveCapabilityIds(
    tx: Prisma.TransactionClient,
    codes: ReadonlyArray<string>,
  ): Promise<Array<{ id: string; code: string }>> {
    if (codes.length === 0) return [];
    const rows = await tx.capability.findMany({
      where: { code: { in: codes as string[] } },
      select: { id: true, code: true },
    });
    if (rows.length !== new Set(codes).size) {
      const found = new Set(rows.map((r) => r.code));
      const missing = codes.filter((c) => !found.has(c));
      throw new BadRequestException({
        code: 'role.capability_unknown',
        message: `Unknown capability code(s): ${missing.join(', ')}`,
      });
    }
    return rows;
  }

  private shapeRole(r: {
    id: string;
    code: string;
    nameAr: string;
    nameEn: string;
    level: number;
    isActive: boolean;
    isSystem: boolean;
    description: string | null;
    capabilities: Array<{ capability: { code: string } }>;
    scopes: Array<{ resource: string; scope: string }>;
    fieldPermissions: Array<{
      resource: string;
      field: string;
      canRead: boolean;
      canWrite: boolean;
    }>;
  }): RoleWithCapabilities {
    return {
      id: r.id,
      code: r.code,
      nameAr: r.nameAr,
      nameEn: r.nameEn,
      level: r.level,
      isActive: r.isActive,
      isSystem: r.isSystem,
      description: r.description,
      capabilities: r.capabilities.map((rc) => rc.capability.code),
      scopes: r.scopes.map((s) => ({
        resource: s.resource as RoleScopeResource,
        scope: s.scope as RoleScopeValue,
      })),
      fieldPermissions: r.fieldPermissions.map((p) => ({
        resource: p.resource,
        field: p.field,
        canRead: p.canRead,
        canWrite: p.canWrite,
      })),
    };
  }
}

// re-export for tests + future callers
export { ROLE_DEFINITIONS };
