import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

import type { ScopeUserClaims } from './scope-context.service';

/**
 * Phase C — C4: read-side field filter.
 *
 * Translates the per-(role × resource × field) `field_permissions`
 * rows into a list of dot-paths to delete from a response payload.
 * Service-layer chokepoint:
 *   1. caller (LeadsService) computes the role's denied-fields list
 *      ONCE per request via `listDeniedReadFields`,
 *   2. then runs every returned row through `filterRead(payload, denied)`
 *      before handing it to the controller.
 *
 * SUPER ADMIN BYPASS:
 *   Mirrors ScopeContextService's bypass — when role.code ===
 *   'super_admin' the denied-fields list is empty regardless of
 *   what `field_permissions` says. Defence in depth: system roles
 *   are immutable (C2) so this path stays correct even if a future
 *   migration accidentally writes a deny row for super_admin.
 *
 * Defaults:
 *   Absence of a `field_permissions` row = read=TRUE / write=TRUE.
 *   Restrictions are explicit denials. Today only `canRead = false`
 *   rows drive the read filter; C5 will add the write-side analog.
 *
 * No-frontend rule (C4):
 *   This service is server-side only. The frontend reads the same
 *   per-(role × resource × field) rows via the extended `/auth/me`
 *   payload (also in C4) so it can hide the same fields, but the
 *   server is the source of truth and the filter applied here is
 *   what actually leaves the API.
 */

export interface DeniedReadFields {
  /** role.code — set when the lookup short-circuited via super_admin. */
  bypassed: boolean;
  /** Dot-paths to delete from a response payload. */
  paths: readonly string[];
}

@Injectable()
export class FieldFilterService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolve the dot-paths the caller's role MUST NOT see for the
   * requested resource. Super-admin always returns `paths: []`.
   *
   * One DB read: the `field_permissions` lookup. Cheap; the table
   * is keyed on `(role_id, resource, field)` and returns at most
   * the catalogue size in rows (~ 20 entries today).
   */
  async listDeniedReadFields(claims: ScopeUserClaims, resource: string): Promise<DeniedReadFields> {
    return this.prisma.withTenant(claims.tenantId, async (tx) => {
      const role = await tx.role.findUnique({
        where: { id: claims.roleId },
        select: { code: true },
      });
      if (role?.code === 'super_admin') {
        return { bypassed: true, paths: [] };
      }
      const rows = await tx.fieldPermission.findMany({
        where: { roleId: claims.roleId, resource, canRead: false },
        select: { field: true },
      });
      return { bypassed: false, paths: rows.map((r) => r.field) };
    });
  }

  /**
   * Phase C — C5: write-side equivalent of `listDeniedReadFields`.
   * Returns the dot-paths the caller's role MUST NOT WRITE for the
   * requested resource. Super-admin bypass mirrors the read path.
   *
   * Used by service-layer write paths (LeadsService.create / update
   * / assign) to strip forbidden keys from incoming DTOs before
   * persistence — so the API silently drops fields the role can't
   * change without raising an error (per the C5 spec, rule 7).
   */
  async listDeniedWriteFields(
    claims: ScopeUserClaims,
    resource: string,
  ): Promise<DeniedReadFields> {
    return this.prisma.withTenant(claims.tenantId, async (tx) => {
      const role = await tx.role.findUnique({
        where: { id: claims.roleId },
        select: { code: true },
      });
      if (role?.code === 'super_admin') {
        return { bypassed: true, paths: [] };
      }
      const rows = await tx.fieldPermission.findMany({
        where: { roleId: claims.roleId, resource, canWrite: false },
        select: { field: true },
      });
      return { bypassed: false, paths: rows.map((r) => r.field) };
    });
  }

  /**
   * Phase C — C5: strip forbidden write keys from an incoming DTO.
   * Identical to `filterRead` operationally (delete every `paths`
   * entry from a payload), but exposed under a separate name so
   * write call-sites read clearly. Use `listDeniedWriteFields` to
   * resolve `paths`.
   */
  stripForbiddenWrites<T>(payload: T, paths: readonly string[]): T {
    return this.filterRead(payload, paths);
  }

  /**
   * Phase C — C5.5: structured strip that ALSO reports which paths
   * were actually present in the input. Callers (LeadsService)
   * use the `denied` list to emit `field_write_denied` audit events
   * naming only the fields involved (no values, per C5.5 rule 3).
   *
   * The returned `dto` is a deep clone of `payload` with every
   * `paths` entry removed; siblings are preserved. `denied` lists
   * each path that existed in `payload` BEFORE stripping — i.e. the
   * subset of `paths` whose deletion was a real change, not a
   * no-op. An empty `denied` array means the operation didn't
   * actually drop anything (no audit needed).
   */
  stripWithReport<T>(payload: T, paths: readonly string[]): { dto: T; denied: string[] } {
    if (paths.length === 0 || payload == null || typeof payload !== 'object') {
      return { dto: payload, denied: [] };
    }
    const denied = paths.filter((p) => this.hasPath(payload, p));
    const dto = this.filterRead(payload, paths);
    return { dto, denied };
  }

  /**
   * Phase C — C5.5: returns true iff `payload` carries a value at
   * the given dot-path. Mirrors `deleteAtPath`'s walk semantics so
   * `stripWithReport` can detect actual presence (vs. always-empty
   * defaults at deeper levels).
   */
  hasPath(payload: unknown, path: string): boolean {
    if (payload == null || typeof payload !== 'object') return false;
    const parts = path.split('.');
    let cursor = payload as Record<string, unknown>;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const next = cursor[parts[i]!];
      if (next == null || typeof next !== 'object' || Array.isArray(next)) return false;
      cursor = next as Record<string, unknown>;
    }
    return Object.prototype.hasOwnProperty.call(cursor, parts[parts.length - 1]!);
  }

  /**
   * Strip every `paths` entry from `payload`. Returns a new object
   * — the caller's reference is untouched, so concurrent code paths
   * can safely re-use the source row (e.g. a list call enumerating
   * rows fetched from a single Prisma query). Dot-paths walk
   * down the object; missing intermediates are no-ops.
   *
   * Behaviour notes:
   *   • `null` / `undefined` payload → returned as-is.
   *   • Arrays at non-leaf positions are skipped (we don't iterate
   *     into array members). This keeps the filter predictable for
   *     the JSON shapes Lead and LeadActivity actually emit.
   *   • Top-level paths (`'id'`) and nested paths
   *     (`'attribution.campaign'`) both work.
   */
  filterRead<T>(payload: T, paths: readonly string[]): T {
    if (paths.length === 0 || payload == null || typeof payload !== 'object') {
      return payload;
    }
    // Deep clone — payload may be a Prisma row; mutating its
    // descendants would corrupt the same reference if the parent
    // value is reused (e.g. a list iteration sharing the query
    // result). JSON round-trip is enough for plain Lead/Activity
    // shapes (no Date instances at deny-eligible paths today; even
    // if a Date appeared, JSON.stringify produces ISO strings which
    // is the wire format anyway).
    const cloned: T = structuredCloneSafe(payload);
    for (const path of paths) {
      deleteAtPath(cloned, path);
    }
    return cloned;
  }

  /**
   * Convenience wrapper: filters a list of rows in O(rows × paths).
   * The denied-paths list is resolved ONCE by the caller so this is
   * pure CPU.
   */
  filterReadMany<T>(rows: readonly T[], paths: readonly string[]): T[] {
    if (paths.length === 0) return [...rows];
    return rows.map((r) => this.filterRead(r, paths));
  }
}

// ─── helpers ──────────────────────────────────────────────────────

/**
 * Deletes a value at a dot-path. The path's leaf is removed via
 * `delete`; intermediate non-objects short-circuit silently so a
 * payload that happens not to carry the field stays intact.
 */
function deleteAtPath(obj: unknown, path: string): void {
  if (obj == null || typeof obj !== 'object') return;
  const parts = path.split('.');
  let cursor: Record<string, unknown> = obj as Record<string, unknown>;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const k = parts[i]!;
    const next = cursor[k];
    if (next == null || typeof next !== 'object' || Array.isArray(next)) return;
    cursor = next as Record<string, unknown>;
  }
  delete cursor[parts[parts.length - 1]!];
}

/**
 * Structured clone fallback for environments without a global
 * `structuredClone` (older Node test runners). The JSON round-trip
 * is sufficient for Prisma row shapes — no functions, no cycles,
 * Dates serialize to strings (which is the wire format anyway).
 */
function structuredCloneSafe<T>(v: T): T {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(v);
    } catch {
      // structuredClone refuses non-cloneable values (functions,
      // class instances). Fall through to JSON.
    }
  }
  return JSON.parse(JSON.stringify(v)) as T;
}
