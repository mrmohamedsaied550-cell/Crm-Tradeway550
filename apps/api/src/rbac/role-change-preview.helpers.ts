/**
 * Phase D5 — D5.15-A pure helpers, hot-fix-extracted from
 * `role-change-preview.service.ts` to break a module-load cycle.
 *
 * The cycle (closed by D5.15-B + D5.16) was:
 *
 *   rbac.service.ts
 *     → (value) role-version.service.ts
 *         → (value) role-change-preview.service.ts
 *             → (value) role-dependency.service.ts
 *                 → (value) rbac.service.ts          ← cycle
 *
 * `RoleVersionService` only needed the pure `computeRiskSummary`
 * helper + its shape types — but importing them through
 * `role-change-preview.service.ts` pulled the whole class graph,
 * which transitively imports `RoleDependencyService`, which imports
 * `RbacService`. With CJS circular resolution, `rbac.service.ts`
 * was mid-evaluation when `role-dependency.service.ts` finished
 * decoration; Nest captured `RbacService` from `Reflect.getMetadata
 * ('design:paramtypes', ...)` as `undefined`, then crashed on
 * boot with:
 *
 *   Nest can't resolve dependencies of the RoleDependencyService
 *   (PrismaService, ?, AuditService). Please make sure that the
 *   argument dependency at index [1] is available …
 *
 * This file ships ONLY pure functions + types. No class imports,
 * no Nest decorators, no transitive class graph. Safe to import
 * from anywhere in the RBAC layer.
 *
 * Behaviour is byte-identical to the inlined version
 * `role-change-preview.service.ts` shipped — every constant + the
 * `computeRiskSummary` body moved verbatim.
 */

import { HIGH_RISK_CAPABILITIES } from './capability-dependencies';

export interface FieldPermissionPair {
  readonly resource: string;
  readonly field: string;
}

/** Capability-axis change shape (mirrors `RoleChangePreviewResult.changes.capabilities`). */
export interface CapabilityChangeSummary {
  readonly granted: readonly string[];
  readonly revoked: readonly string[];
  readonly unchangedCount: number;
}

/** Field-permission diff shape (mirrors `RoleChangePreviewResult.changes.fieldPermissions`). */
export interface FieldPermissionChangeSummary {
  readonly readDeniedAdded: readonly FieldPermissionPair[];
  readonly readDeniedRemoved: readonly FieldPermissionPair[];
  readonly writeDeniedAdded: readonly FieldPermissionPair[];
  readonly writeDeniedRemoved: readonly FieldPermissionPair[];
}

/**
 * Risk-flag bag the change-preview surface + the version recorder
 * + the audit summariser all consume. Self-contained so callers
 * can import the type without dragging the service file in.
 */
export interface RoleRiskSummary {
  readonly exportCapabilityAdded: boolean;
  readonly exportCapabilityRevoked: boolean;
  readonly ownerHistoryVisibilityChanged: boolean;
  readonly auditVisibilityChanged: boolean;
  readonly backupExportChanged: boolean;
  readonly permissionAdminChanged: boolean;
  readonly partnerMergeChanged: boolean;
}

/**
 * Field-perm pairs that mean "this role's view of operational
 * history changes". Surfaces the `ownerHistoryVisibilityChanged`
 * flag whenever any of these `(resource, field)` entries appears
 * in the read or write deny diff.
 */
const OWNER_HISTORY_FIELDS: ReadonlyArray<FieldPermissionPair> = [
  { resource: 'lead', field: 'previousOwner' },
  { resource: 'lead', field: 'ownerHistory' },
  { resource: 'rotation', field: 'fromUser' },
  { resource: 'rotation', field: 'toUser' },
  { resource: 'rotation', field: 'actor' },
  { resource: 'rotation', field: 'notes' },
  { resource: 'whatsapp.conversation', field: 'priorAgentMessages' },
  { resource: 'whatsapp.conversation', field: 'handoverChain' },
];

/**
 * Audit-visibility-relevant pairs. Toggled when ANY of `audit.read`
 * is granted/revoked or these field rows enter/leave the deny set.
 */
const AUDIT_VISIBILITY_FIELDS: ReadonlyArray<FieldPermissionPair> = [
  { resource: 'audit', field: 'payload' },
  { resource: 'audit', field: 'beforeAfter' },
];

const PERMISSION_ADMIN_CAPS: ReadonlySet<string> = new Set(['roles.write', 'permission.preview']);

const BACKUP_EXPORT_CAPS: ReadonlySet<string> = new Set([
  'tenant.export',
  'lead.export',
  'audit.export',
]);

/**
 * Pure D5.15-A risk-flag derivation. Identical body to the original
 * implementation in `role-change-preview.service.ts`; lives here so
 * `RoleVersionService` (D5.15-B) can re-use it without dragging
 * the whole change-preview class graph through CJS load-time.
 */
export function computeRiskSummary(input: {
  capabilityChanges: CapabilityChangeSummary;
  fieldChanges: FieldPermissionChangeSummary;
}): RoleRiskSummary {
  const grantedSet = new Set(input.capabilityChanges.granted);
  const revokedSet = new Set(input.capabilityChanges.revoked);

  let exportCapabilityAdded = false;
  let exportCapabilityRevoked = false;
  let backupExportChanged = false;
  let permissionAdminChanged = false;
  let partnerMergeChanged = false;
  let auditCapToggled = false;

  for (const c of grantedSet) {
    if (HIGH_RISK_CAPABILITIES[c] === 'export') exportCapabilityAdded = true;
    if (BACKUP_EXPORT_CAPS.has(c)) backupExportChanged = true;
    if (PERMISSION_ADMIN_CAPS.has(c)) permissionAdminChanged = true;
    if (c === 'partner.merge.write') partnerMergeChanged = true;
    if (c === 'audit.read' || c === 'audit.export') auditCapToggled = true;
  }
  for (const c of revokedSet) {
    if (HIGH_RISK_CAPABILITIES[c] === 'export') exportCapabilityRevoked = true;
    if (BACKUP_EXPORT_CAPS.has(c)) backupExportChanged = true;
    if (PERMISSION_ADMIN_CAPS.has(c)) permissionAdminChanged = true;
    if (c === 'partner.merge.write') partnerMergeChanged = true;
    if (c === 'audit.read' || c === 'audit.export') auditCapToggled = true;
  }

  const ownerHistoryVisibilityChanged = touches(input.fieldChanges, OWNER_HISTORY_FIELDS);
  const auditVisibilityChanged =
    auditCapToggled || touches(input.fieldChanges, AUDIT_VISIBILITY_FIELDS);

  return {
    exportCapabilityAdded,
    exportCapabilityRevoked,
    ownerHistoryVisibilityChanged,
    auditVisibilityChanged,
    backupExportChanged,
    permissionAdminChanged,
    partnerMergeChanged,
  };
}

function touches(
  fieldChanges: FieldPermissionChangeSummary,
  pairs: ReadonlyArray<FieldPermissionPair>,
): boolean {
  const set = new Set(pairs.map((p) => `${p.resource}::${p.field}`));
  for (const list of [
    fieldChanges.readDeniedAdded,
    fieldChanges.readDeniedRemoved,
    fieldChanges.writeDeniedAdded,
    fieldChanges.writeDeniedRemoved,
  ]) {
    for (const p of list) {
      if (set.has(`${p.resource}::${p.field}`)) return true;
    }
  }
  return false;
}
