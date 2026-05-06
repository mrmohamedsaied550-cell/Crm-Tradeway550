import { Injectable } from '@nestjs/common';

/**
 * Phase D5 — D5.1: in-process LRU cache for resolved permission
 * bundles.
 *
 * The cache stores the output of `PermissionResolverService.resolveForUser`
 * (capabilities + scopes + denied fields + user scope assignments)
 * keyed by `(tenantId, userId, roleId)`. Entries are invalidated:
 *
 *   1. Explicitly via `invalidateRole(roleId, tenantId)`,
 *      `invalidateUser(userId, tenantId)`, or
 *      `invalidateTenant(tenantId)`. Wired into the RBAC mutation
 *      surface (RbacService.updateRole / putRoleScopes /
 *      putRoleFieldPermissions, AdminUsersService.setRole /
 *      setTeam, UserScopeAssignmentsService.replaceForUser).
 *
 *   2. By LRU eviction when the cache exceeds `maxEntries`.
 *
 *   3. By TTL — entries older than `ttlMs` are treated as expired
 *      on next read. Default 5 min, configurable via constructor
 *      for tests.
 *
 * Why per-process and not Redis (yet):
 *   - D5.1 ships the chokepoint without a new infra dependency.
 *     A future D5.x chunk can swap the storage layer behind this
 *     service for Redis without changing any caller.
 *   - Tenant isolation is enforced by including `tenantId` in
 *     every cache key — there is no shared keyspace across
 *     tenants, so even an in-process LRU is safe.
 *   - Entries are small (Sets + Maps of strings); 5 000 entries
 *     fits in single-digit MB.
 *
 * The store is a Map<string, Entry>. JS Maps preserve insertion
 * order, so LRU is implemented by `delete` + `set` on every read
 * to push the entry to the back; the oldest entry is the first
 * iterator yield.
 *
 * D5.1 NEVER consults this cache from any code path — only the
 * resolver service reads/writes it. Callers always call
 * `permissionResolver.resolveForUser(...)`, never the cache
 * directly.
 */

export interface PermissionCacheEntry<T> {
  /** Cached value. Treated as immutable by readers. */
  value: T;
  /** Stored at this epoch ms. Used for TTL eviction. */
  storedAtMs: number;
  /** Composite key parts kept for prefix invalidation walks. */
  tenantId: string;
  userId: string;
  roleId: string;
}

export interface PermissionCacheOptions {
  /** Hard ceiling on entry count; LRU eviction kicks in at this size. */
  maxEntries?: number;
  /** Soft TTL in ms; reads older than this miss as if not present. */
  ttlMs?: number;
}

export const DEFAULT_MAX_ENTRIES = 5_000;
export const DEFAULT_TTL_MS = 5 * 60 * 1_000;

@Injectable()
export class PermissionCacheService {
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly entries = new Map<string, PermissionCacheEntry<any>>();

  constructor(opts: PermissionCacheOptions = {}) {
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  }

  /**
   * Build the canonical cache key. The (tenantId, userId, roleId)
   * triple is stable for a single user-session; if the user's role
   * changes (`AdminUsersService.setRole`) the new request lands at
   * a different key so the old entry stays consistent for any
   * other workers still mid-flight.
   */
  static keyFor(tenantId: string, userId: string, roleId: string): string {
    return `${tenantId}|${userId}|${roleId}`;
  }

  /**
   * Read a cached entry. Misses on:
   *   • absent key,
   *   • TTL expired (older than `ttlMs`).
   * On hit, the entry is reinserted at the back of the Map so it
   * counts as recently used for the LRU eviction policy.
   */
  get<T>(tenantId: string, userId: string, roleId: string): T | null {
    const key = PermissionCacheService.keyFor(tenantId, userId, roleId);
    const entry = this.entries.get(key) as PermissionCacheEntry<T> | undefined;
    if (!entry) return null;
    const ageMs = Date.now() - entry.storedAtMs;
    if (ageMs > this.ttlMs) {
      this.entries.delete(key);
      return null;
    }
    // LRU bump — re-insert moves the entry to the back of the
    // iteration order so eviction picks the oldest first.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  /**
   * Store a new entry. Triggers LRU eviction if the cache is at
   * capacity AND the key is new. Updating an existing key is free
   * (no eviction needed).
   */
  set<T>(tenantId: string, userId: string, roleId: string, value: T): void {
    const key = PermissionCacheService.keyFor(tenantId, userId, roleId);
    if (!this.entries.has(key) && this.entries.size >= this.maxEntries) {
      // Evict the oldest entry — first one returned by Map's iterator.
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) this.entries.delete(oldestKey);
    }
    this.entries.set(key, {
      value,
      storedAtMs: Date.now(),
      tenantId,
      userId,
      roleId,
    });
  }

  /**
   * Invalidate every cached entry for a role within a tenant.
   * Walks the entry list — O(n) but n ≤ maxEntries (5 000 default)
   * and the operation is rare (only on role-mutation paths).
   *
   * Returns the number of entries evicted (used by tests + future
   * observability).
   */
  invalidateRole(roleId: string, tenantId: string): number {
    let evicted = 0;
    for (const [key, entry] of this.entries) {
      if (entry.tenantId === tenantId && entry.roleId === roleId) {
        this.entries.delete(key);
        evicted += 1;
      }
    }
    return evicted;
  }

  /**
   * Invalidate every cached entry for a user within a tenant.
   * Wired into AdminUsersService.setRole / setTeam and
   * UserScopeAssignmentsService.replaceForUser.
   */
  invalidateUser(userId: string, tenantId: string): number {
    let evicted = 0;
    for (const [key, entry] of this.entries) {
      if (entry.tenantId === tenantId && entry.userId === userId) {
        this.entries.delete(key);
        evicted += 1;
      }
    }
    return evicted;
  }

  /**
   * Nuclear option — clear every entry for a tenant. Reserved for
   * tenant-wide events (a future "rebuild tenant permissions"
   * admin job). NOT wired into any current path.
   */
  invalidateTenant(tenantId: string): number {
    let evicted = 0;
    for (const [key, entry] of this.entries) {
      if (entry.tenantId === tenantId) {
        this.entries.delete(key);
        evicted += 1;
      }
    }
    return evicted;
  }

  /**
   * Drop the whole cache. For tests + container-level events
   * (process restart approximation).
   */
  clear(): void {
    this.entries.clear();
  }

  /** Current entry count — for tests + future metrics. */
  size(): number {
    return this.entries.size;
  }
}
