/**
 * Phase C — C6: client-side permission helpers.
 *
 * Mirrors the server's authorization model so the UI can hide /
 * readOnly fields the API would reject anyway. The SERVER is the
 * source of truth (the C3 scope filter + C4/C5 field filters apply
 * at the service boundary regardless of what the UI does); these
 * helpers are UX guidance — never trust them for security
 * decisions.
 *
 * SOURCE OF TRUTH:
 *   `getCachedMe()` returns the cached `/auth/me` payload, which the
 *   server populated with:
 *     - capabilities[]      (C2 — same flat list since P2-01)
 *     - fieldPermissions[]  (C4/C6 — per-(resource × field) toggles)
 *   This module reads from that cache. When the cache is stale or
 *   missing, the helpers return permissive defaults so a transient
 *   cache miss doesn't lock the UI.
 *
 * SCOPE:
 *   `getScope(resource)` is exposed for forward compatibility — the
 *   client architecture proposed in C-plan calls for a `getScope`
 *   accessor so consumers (lists, drawers, kanban) can adjust
 *   their UI hints (e.g. "showing leads from your team only").
 *   The current `/auth/me` payload doesn't ship the per-resource
 *   scope value yet (that lands when the server-side extension
 *   ships in a follow-up under the C-series). Until then this
 *   helper returns `'global'` so callers can rely on the function
 *   existing without conditional checks. The behavior matches the
 *   server's default when no role_scopes row exists.
 */

import { getCachedMe, hasCapability } from './auth';

export type ScopeKind = 'own' | 'team' | 'company' | 'country' | 'global';

/** All resources currently gateable by capability + field permission. */
export type PermissionResource = 'lead';

/** All actions a capability can describe. The list is illustrative —
 *  callers pass any string the server's capability registry knows
 *  about; `can` builds `${resource}.${action}` and delegates to
 *  hasCapability. */
export type CapabilityAction =
  | 'read'
  | 'write'
  | 'assign'
  | 'stage.move'
  | 'activity.write'
  | 'convert'
  | 'import';

/**
 * Capability check. `can('lead', 'write')` returns true iff the
 * cached `me.capabilities` list contains `lead.write`. Falls back
 * to `false` when the cache is missing — same conservative default
 * `hasCapability` uses today.
 *
 * Use for action visibility (buttons, links) — not for field
 * visibility (use `canSeeField` for that).
 */
export function can(resource: string, action: string): boolean {
  return hasCapability(`${resource}.${action}`);
}

/**
 * Field-level READ check. Returns true iff the calling user's role
 * is allowed to SEE the given (resource, field). When no
 * `field_permissions` row exists for the field, default is permissive
 * (read=true). When the cache is missing, also permissive — the
 * server-side filter (C4) is the actual gate; the UI is just a UX
 * guide.
 *
 * Field paths use dot-notation matching the server's
 * `field_permissions.field` column (e.g. `attribution.campaign`).
 */
export function canSeeField(resource: string, field: string): boolean {
  const me = getCachedMe();
  if (!me?.fieldPermissions) return true;
  const row = me.fieldPermissions.find((p) => p.resource === resource && p.field === field);
  if (!row) return true;
  return row.canRead;
}

/**
 * Field-level WRITE check. Mirrors `canSeeField` for the `canWrite`
 * column. When `false`, the UI should disable / make readOnly the
 * relevant input. The server (C5) silently strips forbidden fields
 * either way — this helper just keeps the UI honest about which
 * inputs will actually persist.
 */
export function canEditField(resource: string, field: string): boolean {
  const me = getCachedMe();
  if (!me?.fieldPermissions) return true;
  const row = me.fieldPermissions.find((p) => p.resource === resource && p.field === field);
  if (!row) return true;
  return row.canWrite;
}

/**
 * Returns the calling user's data scope for the given resource.
 * Today: returns `'global'` because the `/auth/me` payload doesn't
 * yet carry per-resource scope values (a future server-side
 * extension under the C-series). Forward-compatible signature so
 * callers can already structure code around the eventual values.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- forward-compatible signature
export function getScope(_resource: string): ScopeKind {
  return 'global';
}
