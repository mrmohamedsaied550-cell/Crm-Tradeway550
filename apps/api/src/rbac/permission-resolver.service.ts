import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

import { PermissionCacheService } from './permission-cache.service';
import type { ScopeUserClaims } from './scope-context.service';

/**
 * Phase D5 — D5.1: PermissionResolverService.
 *
 * Single chokepoint that resolves, in one DB-bound call, the full
 * permission picture for an authenticated user:
 *
 *   • capability codes           (RoleCapability ⨝ Capability)
 *   • per-resource role scope    (RoleScope)
 *   • per-(resource, field) read denials  (FieldPermission, canRead = false)
 *   • per-(resource, field) write denials (FieldPermission, canWrite = false)
 *   • user-level scope assignments        (UserScopeAssignment)
 *   • role metadata             (id / code / level / isSystem / version-tag)
 *
 * D5.1 IS A FOUNDATION ONLY:
 *   - No existing service consults this resolver yet. CapabilityGuard,
 *     ScopeContextService, and FieldFilterService keep their per-
 *     request DB lookups exactly as-is.
 *   - Later D5.x chunks will gradually migrate call-sites onto the
 *     resolver. Until they do, runtime behaviour is unchanged from
 *     D4.
 *
 * Caching:
 *   - Backed by `PermissionCacheService` keyed by
 *     `(tenantId, userId, roleId)`.
 *   - On a mutation (role or user), the wiring in RbacService /
 *     AdminUsersService / UserScopeAssignmentsService calls
 *     `cache.invalidateRole(...)` or `cache.invalidateUser(...)`
 *     so the next resolution re-reads from the DB.
 *   - The Role.updatedAt timestamp is recorded on the cached
 *     entry as `roleVersion` so a future strict-mode check can
 *     verify the cache against the live row before trusting it.
 *     D5.1 itself does NOT verify — invalidation is the source
 *     of freshness.
 *
 * Super-admin bypass:
 *   - Mirrors `ScopeContextService` / `FieldFilterService`.
 *     When `role.code === 'super_admin'`:
 *       • `capabilities` is the full set of codes from
 *         `Capability` (every code the system knows about),
 *       • every `scopesByResource` entry is `'global'`,
 *       • `deniedReadFieldsByResource` and
 *         `deniedWriteFieldsByResource` are empty everywhere.
 *   - This mirrors the runtime behaviour today; the resolver
 *     never lies about what super-admin can do.
 *
 * No public endpoint:
 *   - The resolver is consumed in-process by future interceptors.
 *     D5.1 deliberately does NOT expose a controller — a "what
 *     does my role see?" endpoint lands in D5.10 (preview-as-role)
 *     with its own capability gate.
 */

export const SUPER_ADMIN_ROLE_CODE = 'super_admin';

/**
 * Stable string set of role-scope values. Mirrors the union in
 * ScopeContextService; kept here as a const so the resolver can
 * type its return without importing the alias from a service that
 * doesn't export it as a value.
 */
export type RoleScopeValue = 'own' | 'team' | 'company' | 'country' | 'global';

export interface ResolvedRoleMeta {
  id: string;
  code: string;
  level: number;
  isSystem: boolean;
  /**
   * Role.updatedAt as ms epoch — used as a version tag. Not
   * authoritative for cache freshness on its own (explicit
   * invalidation is the source of truth). Surfaced so a future
   * strict-mode resolver can detect a stale cache without
   * trusting the in-process invalidation chain alone.
   */
  versionTag: number;
}

export interface ResolvedUserScopes {
  /** Company ids the user is bound to (empty for unassigned). */
  companyIds: readonly string[];
  /** Country ids the user is bound to (empty for unassigned). */
  countryIds: readonly string[];
}

export interface ResolvedPermissions {
  tenantId: string;
  userId: string;
  role: ResolvedRoleMeta;
  /** Capability codes the user holds. */
  capabilities: readonly string[];
  /**
   * Per-resource role scope. Resources without an explicit row
   * default to `'global'` (mirrors ScopeContextService line 275).
   */
  scopesByResource: Readonly<Record<string, RoleScopeValue>>;
  /**
   * Per-resource list of dot-paths that MUST NOT be returned to
   * the caller. Empty array per resource when the role has no
   * deny rows for that resource OR when super-admin bypass kicks
   * in.
   */
  deniedReadFieldsByResource: Readonly<Record<string, readonly string[]>>;
  /** Mirror of `deniedReadFieldsByResource` for canWrite=false. */
  deniedWriteFieldsByResource: Readonly<Record<string, readonly string[]>>;
  /** User-level scope assignments — company / country bindings. */
  userScopes: ResolvedUserScopes;
  /** Set when this resolution was served from the cache. Useful for tests. */
  servedFromCache: boolean;
}

@Injectable()
export class PermissionResolverService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: PermissionCacheService,
  ) {}

  /**
   * Resolve the full permission bundle for the calling user.
   *
   * Strategy:
   *   1. Cache hit (tenantId, userId, roleId) → return clone with
   *      `servedFromCache = true`.
   *   2. Cache miss → run a single `withTenant` block that issues
   *      five Prisma queries in parallel:
   *        a) role + capabilities,
   *        b) role scopes,
   *        c) field permissions (canRead = false),
   *        d) field permissions (canWrite = false),
   *        e) user scope assignments.
   *      Super-admin short-circuits (a) by returning the full
   *      capability set and skipping (c)+(d).
   *   3. Compose the `ResolvedPermissions` object and store it.
   *
   * The resolver itself is stateless beyond the cache — every
   * invocation either trusts the cache (if invalidation has not
   * cleared it) or re-reads from Postgres. Tenant isolation
   * follows from the `withTenant` envelope (same RLS guarantees
   * the rest of the surface relies on).
   */
  async resolveForUser(claims: ScopeUserClaims): Promise<ResolvedPermissions> {
    const { tenantId, userId, roleId } = claims;

    const cached = this.cache.get<ResolvedPermissions>(tenantId, userId, roleId);
    if (cached) {
      return { ...cached, servedFromCache: true };
    }

    const resolved = await this.prisma.withTenant(tenantId, async (tx) => {
      // 1. Role + capabilities. Super-admin short-circuits the
      //    field-permission queries to keep the bypass predictable
      //    even if a deny row was somehow persisted for it.
      const role = await tx.role.findUnique({
        where: { id: roleId },
        select: {
          id: true,
          code: true,
          level: true,
          isSystem: true,
          updatedAt: true,
          capabilities: {
            select: { capability: { select: { code: true } } },
          },
        },
      });
      if (!role) {
        // Defensive: a missing role at resolve time means the
        // user's session refers to a deleted role row. Return a
        // zero-permission bundle so downstream callers fail closed.
        return zeroBundle(tenantId, userId, roleId);
      }

      const isSuperAdmin = role.code === SUPER_ADMIN_ROLE_CODE;

      const [scopeRows, deniedReadRows, deniedWriteRows, userAssignments, allCaps] =
        await Promise.all([
          tx.roleScope.findMany({
            where: { roleId },
            select: { resource: true, scope: true },
          }),
          isSuperAdmin
            ? Promise.resolve([] as Array<{ resource: string; field: string }>)
            : tx.fieldPermission.findMany({
                where: { roleId, canRead: false },
                select: { resource: true, field: true },
              }),
          isSuperAdmin
            ? Promise.resolve([] as Array<{ resource: string; field: string }>)
            : tx.fieldPermission.findMany({
                where: { roleId, canWrite: false },
                select: { resource: true, field: true },
              }),
          tx.userScopeAssignment.findMany({
            where: { userId },
            select: { companyId: true, countryId: true },
          }),
          // Super-admin gets every capability code the registry
          // currently knows about. Read from the DB rather than
          // the static registry so a tenant that has lifted a
          // capability sees the live truth.
          isSuperAdmin
            ? tx.capability.findMany({ select: { code: true } })
            : Promise.resolve(role.capabilities.map((rc) => ({ code: rc.capability.code }))),
        ]);

      const capabilities: readonly string[] = isSuperAdmin
        ? Array.from(new Set(allCaps.map((c: { code: string }) => c.code)))
        : Array.from(new Set(role.capabilities.map((rc) => rc.capability.code)));

      const scopesByResource: Record<string, RoleScopeValue> = {};
      for (const r of scopeRows) {
        scopesByResource[r.resource] = (r.scope as RoleScopeValue) ?? 'global';
      }

      const deniedReadFieldsByResource = groupFieldsByResource(deniedReadRows);
      const deniedWriteFieldsByResource = groupFieldsByResource(deniedWriteRows);

      // Super-admin sees everything: empty deny maps + universal
      // 'global' for any resource a future caller asks about.
      // We don't pre-fill scopesByResource for super-admin; the
      // consumer should default to 'global' when a resource isn't
      // present in the map (matches ScopeContextService line 275).

      const companyIds = Array.from(
        new Set(
          userAssignments
            .map((a: { companyId: string | null }) => a.companyId)
            .filter((v: string | null): v is string => typeof v === 'string'),
        ),
      );
      const countryIds = Array.from(
        new Set(
          userAssignments
            .map((a: { countryId: string | null }) => a.countryId)
            .filter((v: string | null): v is string => typeof v === 'string'),
        ),
      );

      const bundle: ResolvedPermissions = {
        tenantId,
        userId,
        role: {
          id: role.id,
          code: role.code,
          level: role.level,
          isSystem: role.isSystem,
          versionTag: role.updatedAt.getTime(),
        },
        capabilities,
        scopesByResource,
        deniedReadFieldsByResource,
        deniedWriteFieldsByResource,
        userScopes: { companyIds, countryIds },
        servedFromCache: false,
      };
      return bundle;
    });

    // Don't cache the zero bundle — it represents a deleted role
    // and we want the next call to confirm the missing row, not
    // serve a poisoned hit. The zero bundle is the only place we
    // emit `role.code === '__missing__'`, so that's the marker.
    if (resolved.role.code !== ZERO_ROLE_CODE) {
      this.cache.set(tenantId, userId, roleId, resolved);
    }
    return resolved;
  }
}

const ZERO_ROLE_CODE = '__missing__';

function groupFieldsByResource(
  rows: ReadonlyArray<{ resource: string; field: string }>,
): Readonly<Record<string, readonly string[]>> {
  const out: Record<string, string[]> = {};
  for (const row of rows) {
    if (!out[row.resource]) out[row.resource] = [];
    out[row.resource]!.push(row.field);
  }
  return out;
}

function zeroBundle(tenantId: string, userId: string, roleId: string): ResolvedPermissions {
  return {
    tenantId,
    userId,
    role: {
      id: roleId,
      code: ZERO_ROLE_CODE,
      level: 0,
      isSystem: false,
      versionTag: 0,
    },
    capabilities: [],
    scopesByResource: {},
    deniedReadFieldsByResource: {},
    deniedWriteFieldsByResource: {},
    userScopes: { companyIds: [], countryIds: [] },
    servedFromCache: false,
  };
}
