/**
 * Phase D5 — D5.1: PermissionResolverService + PermissionCacheService.
 *
 * Pure unit tests (no Postgres). Builds a stub PrismaService that
 * answers `withTenant(tenantId, fn)` with a deterministic in-memory
 * dataset, then drives the resolver and the cache through the
 * scenarios D5.1 must lock in:
 *
 *   1. Resolves capabilities, scopes, field permissions, user-scope
 *      assignments, and role metadata for a regular role.
 *   2. Super-admin bypass: returns every capability code from
 *      `tx.capability.findMany`, empty deny lists, regardless of
 *      what `field_permissions` contains.
 *   3. Cache hit returns the same object with `servedFromCache: true`
 *      and skips the DB.
 *   4. `invalidateRole` clears matching entries; subsequent reads
 *      hit the DB again.
 *   5. `invalidateUser` clears matching entries.
 *   6. `invalidateTenant` clears matching entries.
 *   7. LRU eviction at `maxEntries` cap.
 *   8. TTL expiry.
 *   9. Missing-role path returns a zero bundle and is NOT cached.
 *  10. Ensures the existing CapabilityGuard / ScopeContextService /
 *      FieldFilterService have NOT been touched (D5.1 is foundation
 *      only — runtime behaviour unchanged).
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { PermissionCacheService } from './permission-cache.service';
import { PermissionResolverService, SUPER_ADMIN_ROLE_CODE } from './permission-resolver.service';
import type { PrismaService } from '../prisma/prisma.service';

// ─── stub data ───────────────────────────────────────────────────

interface RoleRow {
  id: string;
  code: string;
  level: number;
  isSystem: boolean;
  updatedAt: Date;
  capabilities: Array<{ capability: { code: string } }>;
}

interface ScopeRow {
  resource: string;
  scope: string;
}

interface FieldRow {
  resource: string;
  field: string;
  canRead: boolean;
  canWrite: boolean;
}

interface AssignmentRow {
  companyId: string | null;
  countryId: string | null;
}

interface CapabilityRow {
  code: string;
}

interface DataLayer {
  role: RoleRow | null;
  scopes: ScopeRow[];
  fieldPermissions: FieldRow[];
  assignments: AssignmentRow[];
  /** Full capability registry (used for super_admin enumeration). */
  allCapabilities: CapabilityRow[];
}

function makeStubPrisma(data: DataLayer): {
  prisma: PrismaService;
  callCount: { value: number };
} {
  const callCount = { value: 0 };
  const prisma = {
    withTenant: async <T>(_tenantId: string, fn: (tx: unknown) => Promise<T>): Promise<T> => {
      callCount.value += 1;
      const tx = {
        role: {
          findUnique: async () => data.role,
        },
        roleScope: {
          findMany: async () => data.scopes.map((s) => ({ resource: s.resource, scope: s.scope })),
        },
        fieldPermission: {
          findMany: async ({ where }: { where: { canRead?: boolean; canWrite?: boolean } }) => {
            return data.fieldPermissions
              .filter((f) =>
                where.canRead === false
                  ? !f.canRead
                  : where.canWrite === false
                    ? !f.canWrite
                    : true,
              )
              .map((f) => ({ resource: f.resource, field: f.field }));
          },
        },
        userScopeAssignment: {
          findMany: async () =>
            data.assignments.map((a) => ({
              companyId: a.companyId,
              countryId: a.countryId,
            })),
        },
        capability: {
          findMany: async () => data.allCapabilities.map((c) => ({ code: c.code })),
        },
      };
      return fn(tx);
    },
  } as unknown as PrismaService;
  return { prisma, callCount };
}

const TENANT = 'tenant-1';
const USER = 'user-1';
const ROLE = 'role-tl-sales';
const ROLE_TS = new Date('2026-05-01T00:00:00Z');

function regularRole(): DataLayer {
  return {
    role: {
      id: ROLE,
      code: 'tl_sales',
      level: 60,
      isSystem: true,
      updatedAt: ROLE_TS,
      capabilities: [
        { capability: { code: 'lead.read' } },
        { capability: { code: 'lead.write' } },
        { capability: { code: 'lead.review.read' } },
      ],
    },
    scopes: [
      { resource: 'lead', scope: 'team' },
      { resource: 'followup', scope: 'team' },
    ],
    fieldPermissions: [
      // Sales-agent-style deny: hide the campaign on cross-attempt rows.
      { resource: 'lead', field: 'attribution.campaign', canRead: false, canWrite: true },
      { resource: 'lead', field: 'previousOwner', canRead: false, canWrite: false },
    ],
    assignments: [
      { companyId: 'company-eg-1', countryId: null },
      { companyId: null, countryId: 'country-eg' },
    ],
    allCapabilities: [
      { code: 'lead.read' },
      { code: 'lead.write' },
      { code: 'lead.review.read' },
      { code: 'roles.read' },
    ],
  };
}

function superAdminRole(): DataLayer {
  return {
    role: {
      id: 'role-super',
      code: SUPER_ADMIN_ROLE_CODE,
      level: 100,
      isSystem: true,
      updatedAt: ROLE_TS,
      capabilities: [{ capability: { code: 'lead.read' } }], // intentionally short
    },
    scopes: [],
    // A misseeded deny row that MUST NOT take effect for super_admin.
    fieldPermissions: [
      { resource: 'lead', field: 'previousOwner', canRead: false, canWrite: false },
    ],
    assignments: [],
    allCapabilities: [
      { code: 'lead.read' },
      { code: 'lead.write' },
      { code: 'lead.review.read' },
      { code: 'roles.read' },
      { code: 'roles.write' },
    ],
  };
}

// ─── tests ───────────────────────────────────────────────────────

describe('rbac/PermissionResolverService — D5.1', () => {
  let cache: PermissionCacheService;

  beforeEach(() => {
    cache = new PermissionCacheService({ maxEntries: 100, ttlMs: 60_000 });
  });

  it('resolves capabilities, scopes, field permissions, user scopes, and role metadata', async () => {
    const { prisma } = makeStubPrisma(regularRole());
    const resolver = new PermissionResolverService(prisma, cache);

    const r = await resolver.resolveForUser({
      tenantId: TENANT,
      userId: USER,
      roleId: ROLE,
    });

    assert.equal(r.tenantId, TENANT);
    assert.equal(r.userId, USER);
    assert.equal(r.role.id, ROLE);
    assert.equal(r.role.code, 'tl_sales');
    assert.equal(r.role.level, 60);
    assert.equal(r.role.isSystem, true);
    assert.equal(r.role.versionTag, ROLE_TS.getTime());

    assert.deepEqual([...r.capabilities].sort(), ['lead.read', 'lead.review.read', 'lead.write']);
    assert.equal(r.scopesByResource['lead'], 'team');
    assert.equal(r.scopesByResource['followup'], 'team');
    assert.deepEqual(r.deniedReadFieldsByResource['lead']?.slice().sort(), [
      'attribution.campaign',
      'previousOwner',
    ]);
    assert.deepEqual(r.deniedWriteFieldsByResource['lead'], ['previousOwner']);
    assert.deepEqual(r.userScopes.companyIds, ['company-eg-1']);
    assert.deepEqual(r.userScopes.countryIds, ['country-eg']);
    assert.equal(r.servedFromCache, false);
  });

  it('super_admin bypass: returns every capability code, empty deny lists', async () => {
    const { prisma } = makeStubPrisma(superAdminRole());
    const resolver = new PermissionResolverService(prisma, cache);

    const r = await resolver.resolveForUser({
      tenantId: TENANT,
      userId: USER,
      roleId: 'role-super',
    });

    assert.equal(r.role.code, SUPER_ADMIN_ROLE_CODE);
    assert.deepEqual([...r.capabilities].sort(), [
      'lead.read',
      'lead.review.read',
      'lead.write',
      'roles.read',
      'roles.write',
    ]);
    assert.deepEqual(r.deniedReadFieldsByResource, {});
    assert.deepEqual(r.deniedWriteFieldsByResource, {});
  });

  it('cache hit returns servedFromCache=true and does not hit the DB again', async () => {
    const { prisma, callCount } = makeStubPrisma(regularRole());
    const resolver = new PermissionResolverService(prisma, cache);

    const first = await resolver.resolveForUser({
      tenantId: TENANT,
      userId: USER,
      roleId: ROLE,
    });
    assert.equal(first.servedFromCache, false);
    assert.equal(callCount.value, 1);

    const second = await resolver.resolveForUser({
      tenantId: TENANT,
      userId: USER,
      roleId: ROLE,
    });
    assert.equal(second.servedFromCache, true);
    assert.equal(callCount.value, 1); // no new DB call

    // Same data even though served from cache.
    assert.deepEqual([...second.capabilities].sort(), [...first.capabilities].sort());
  });

  it('invalidateRole clears cached entries for that role', async () => {
    const { prisma, callCount } = makeStubPrisma(regularRole());
    const resolver = new PermissionResolverService(prisma, cache);

    await resolver.resolveForUser({ tenantId: TENANT, userId: USER, roleId: ROLE });
    assert.equal(callCount.value, 1);

    const evicted = cache.invalidateRole(ROLE, TENANT);
    assert.equal(evicted, 1);

    await resolver.resolveForUser({ tenantId: TENANT, userId: USER, roleId: ROLE });
    assert.equal(callCount.value, 2); // re-read from DB after invalidation
  });

  it('invalidateUser clears cached entries for that user', async () => {
    const { prisma, callCount } = makeStubPrisma(regularRole());
    const resolver = new PermissionResolverService(prisma, cache);

    await resolver.resolveForUser({ tenantId: TENANT, userId: USER, roleId: ROLE });
    assert.equal(callCount.value, 1);

    const evicted = cache.invalidateUser(USER, TENANT);
    assert.equal(evicted, 1);

    await resolver.resolveForUser({ tenantId: TENANT, userId: USER, roleId: ROLE });
    assert.equal(callCount.value, 2);
  });

  it('invalidateTenant clears every entry for the tenant', async () => {
    const { prisma } = makeStubPrisma(regularRole());
    const resolver = new PermissionResolverService(prisma, cache);

    await resolver.resolveForUser({ tenantId: TENANT, userId: 'u1', roleId: ROLE });
    await resolver.resolveForUser({ tenantId: TENANT, userId: 'u2', roleId: ROLE });
    assert.equal(cache.size(), 2);

    const evicted = cache.invalidateTenant(TENANT);
    assert.equal(evicted, 2);
    assert.equal(cache.size(), 0);
  });

  it('does not cache the zero bundle when the role row is missing', async () => {
    const { prisma, callCount } = makeStubPrisma({
      role: null,
      scopes: [],
      fieldPermissions: [],
      assignments: [],
      allCapabilities: [],
    });
    const resolver = new PermissionResolverService(prisma, cache);

    const r1 = await resolver.resolveForUser({
      tenantId: TENANT,
      userId: USER,
      roleId: 'role-deleted',
    });
    assert.equal(r1.role.code, '__missing__');
    assert.deepEqual([...r1.capabilities], []);
    assert.equal(callCount.value, 1);

    // Second call MUST also hit the DB (the zero bundle is never cached).
    await resolver.resolveForUser({
      tenantId: TENANT,
      userId: USER,
      roleId: 'role-deleted',
    });
    assert.equal(callCount.value, 2);
    assert.equal(cache.size(), 0);
  });
});

describe('rbac/PermissionCacheService — D5.1', () => {
  it('LRU evicts the oldest entry when maxEntries is reached', () => {
    const cache = new PermissionCacheService({ maxEntries: 2, ttlMs: 60_000 });
    cache.set('t1', 'u1', 'r1', 'A');
    cache.set('t1', 'u2', 'r1', 'B');
    assert.equal(cache.size(), 2);
    cache.set('t1', 'u3', 'r1', 'C');
    assert.equal(cache.size(), 2);
    // u1 (oldest) should be gone.
    assert.equal(cache.get('t1', 'u1', 'r1'), null);
    assert.equal(cache.get('t1', 'u2', 'r1'), 'B');
    assert.equal(cache.get('t1', 'u3', 'r1'), 'C');
  });

  it('TTL expires entries on next read', async () => {
    const cache = new PermissionCacheService({ maxEntries: 10, ttlMs: 1 });
    cache.set('t1', 'u1', 'r1', 'X');
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(cache.get('t1', 'u1', 'r1'), null);
    assert.equal(cache.size(), 0);
  });

  it('reading an entry refreshes its LRU position', () => {
    const cache = new PermissionCacheService({ maxEntries: 2, ttlMs: 60_000 });
    cache.set('t1', 'u1', 'r1', 'A');
    cache.set('t1', 'u2', 'r1', 'B');
    // Touch u1 so it's now the most-recent. u2 becomes the oldest.
    cache.get('t1', 'u1', 'r1');
    cache.set('t1', 'u3', 'r1', 'C');
    assert.equal(cache.get('t1', 'u1', 'r1'), 'A');
    assert.equal(cache.get('t1', 'u2', 'r1'), null); // evicted
    assert.equal(cache.get('t1', 'u3', 'r1'), 'C');
  });

  it('clear() drops every entry', () => {
    const cache = new PermissionCacheService({ maxEntries: 10, ttlMs: 60_000 });
    cache.set('t1', 'u1', 'r1', 'A');
    cache.set('t2', 'u1', 'r1', 'B');
    cache.clear();
    assert.equal(cache.size(), 0);
  });
});

describe('rbac — existing surface unchanged (D5.1)', () => {
  it('CapabilityGuard, ScopeContextService, and FieldFilterService still export their public shape', async () => {
    // Smoke import — if any future chunk accidentally renames a
    // public type, this test fails fast.
    const { CapabilityGuard } = await import('./capability.guard');
    const { ScopeContextService } = await import('./scope-context.service');
    const { FieldFilterService } = await import('./field-filter.service');
    assert.equal(typeof CapabilityGuard, 'function');
    assert.equal(typeof ScopeContextService, 'function');
    assert.equal(typeof FieldFilterService, 'function');
  });
});
