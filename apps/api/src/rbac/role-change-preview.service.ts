import { Injectable, NotFoundException, Optional } from '@nestjs/common';

import { AuditService } from '../audit/audit.service';

import { HIGH_RISK_CAPABILITIES } from './capability-dependencies';
import {
  RbacService,
  type RoleFieldPermissionRow,
  type RoleScopeRow,
  type RoleWithCapabilities,
} from './rbac.service';
import {
  RoleDependencyService,
  TYPED_CONFIRMATION_PHRASE,
  type DependencyAnalysis,
} from './role-dependency.service';
import type { RoleScopeResource, RoleScopeValue } from './rbac.dto';

/**
 * Phase D5 — D5.15-A: structural change-set preview for the role
 * builder.
 *
 * D5.14 adds dependency / lockout warnings BEFORE save; D5.15-A
 * adds a structured "what is actually changing?" answer so admins
 * can review the diff in plain language before committing. The
 * service is read-only — it never mutates a row, never touches
 * the resolver cache, and never calls the write surface.
 *
 * Output shape:
 *
 *   • `role` — minimal target identity (id / code / name) so the
 *     UI can re-render with the right header without a second
 *     round-trip.
 *
 *   • `changes.capabilities` — granted / revoked / unchangedCount.
 *     Codes are dot.separated and stable; the frontend looks up
 *     the catalogue label via `capabilitiesApi`.
 *
 *   • `changes.fieldPermissions` — read / write deny additions +
 *     removals. "Denied" means a row with `canRead=false` (or
 *     `canWrite=false`). Absent rows mean the runtime default
 *     applies. Pairs are returned as `{ resource, field }` —
 *     the frontend resolves the label via the catalogue mirror.
 *
 *   • `changes.scopes` — three flavours (added / removed /
 *     changed) so the renderer can group naturally. Scope values
 *     ride as plain strings ('own' / 'team' / 'company' /
 *     'country' / 'global').
 *
 *   • `warnings` — D5.14 dependency analysis on the proposed
 *     capability set, threaded through verbatim. The frontend
 *     reuses `<DependencyWarningsPanel>` to render them.
 *
 *   • `requiresTypedConfirmation` — same gate as D5.14, exposed
 *     here so the review modal can decide whether to render the
 *     typed-confirmation field inline.
 *
 *   • `riskSummary` — boolean flags the UI uses to highlight
 *     "this change touches export / owner-history / audit /
 *     backup / permission-admin / partner-merge". The flags are
 *     derived from BOTH the capability diff AND the field-perm
 *     diff so a change to `audit.payload` field perms surfaces
 *     `auditVisibilityChanged` even if `audit.read` itself is
 *     unchanged.
 *
 *   • `hasChanges` — convenience boolean for the "no changes to
 *     save" state. The frontend uses it to short-circuit the save
 *     flow without calling the update endpoint.
 *
 * Constraint: the service never returns sensitive VALUES — only
 * structural identifiers (capability codes, resource + field
 * names, scope strings). The same rule the role-preview service
 * (D5.10) follows.
 */

export interface RoleChangePreviewInput {
  readonly roleId: string;
  /** When omitted, the capability set is treated as unchanged. */
  readonly proposedCapabilities?: readonly string[];
  /** When omitted, the scope set is treated as unchanged. */
  readonly proposedScopes?: readonly RoleScopeRow[];
  /** When omitted, the field-permission set is treated as unchanged. */
  readonly proposedFieldPermissions?: readonly RoleFieldPermissionRow[];
  readonly actor: { readonly userId: string; readonly roleId: string };
}

export interface FieldPermissionPair {
  readonly resource: string;
  readonly field: string;
}

export interface ScopeChangeRow {
  readonly resource: RoleScopeResource;
  readonly from: RoleScopeValue;
  readonly to: RoleScopeValue;
}

export interface RoleChangePreviewResult {
  readonly role: {
    readonly id: string;
    readonly code: string;
    readonly nameEn: string;
    readonly nameAr: string;
    readonly isSystem: boolean;
  };
  readonly changes: {
    readonly capabilities: {
      readonly granted: readonly string[];
      readonly revoked: readonly string[];
      readonly unchangedCount: number;
    };
    readonly fieldPermissions: {
      readonly readDeniedAdded: readonly FieldPermissionPair[];
      readonly readDeniedRemoved: readonly FieldPermissionPair[];
      readonly writeDeniedAdded: readonly FieldPermissionPair[];
      readonly writeDeniedRemoved: readonly FieldPermissionPair[];
    };
    readonly scopes: {
      readonly changed: readonly ScopeChangeRow[];
      readonly added: readonly RoleScopeRow[];
      readonly removed: readonly RoleScopeRow[];
    };
  };
  readonly warnings: DependencyAnalysis['warnings'];
  readonly severityCounts: DependencyAnalysis['severityCounts'];
  readonly requiresTypedConfirmation: boolean;
  readonly typedConfirmationPhrase: string;
  readonly riskSummary: {
    readonly exportCapabilityAdded: boolean;
    readonly exportCapabilityRevoked: boolean;
    readonly ownerHistoryVisibilityChanged: boolean;
    readonly auditVisibilityChanged: boolean;
    readonly backupExportChanged: boolean;
    readonly permissionAdminChanged: boolean;
    readonly partnerMergeChanged: boolean;
  };
  readonly hasChanges: boolean;
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

@Injectable()
export class RoleChangePreviewService {
  constructor(
    private readonly rbac: RbacService,
    private readonly dependencies: RoleDependencyService,
    /** Best-effort audit emit for the `rbac.role.change_previewed` verb. */
    @Optional() private readonly audit?: AuditService,
  ) {}

  /**
   * Build the change-set preview for the target role. Throws
   * `role.not_found` when the role is outside the active tenant.
   * Never mutates the role.
   */
  async preview(input: RoleChangePreviewInput): Promise<RoleChangePreviewResult> {
    const role = await this.rbac.findRoleById(input.roleId);
    if (!role) {
      throw new NotFoundException({
        code: 'role.not_found',
        message: `Role ${input.roleId} not found in this tenant.`,
      });
    }

    const capabilityChanges = diffCapabilities(role, input.proposedCapabilities);
    const fieldChanges = diffFieldPermissions(role, input.proposedFieldPermissions);
    const scopeChanges = diffScopes(role, input.proposedScopes);

    // Reuse the D5.14 dependency analyser. When the caller did
    // NOT propose new capabilities, analyse the role's CURRENT
    // capabilities — the warnings may still surface (e.g. a
    // pre-existing missing-dependency that the role builder
    // wants to highlight on every preview). When the caller DID
    // propose, analyse THAT set so the warnings reflect the
    // saved-state shape the operator is about to commit.
    const proposedCaps =
      input.proposedCapabilities !== undefined
        ? input.proposedCapabilities
        : [...role.capabilities];
    const analysis = await this.dependencies.analyseProposal({
      roleId: role.id,
      proposedCapabilities: proposedCaps,
      actor: input.actor,
    });

    const riskSummary = computeRiskSummary({
      capabilityChanges,
      fieldChanges,
    });

    const hasChanges =
      capabilityChanges.granted.length > 0 ||
      capabilityChanges.revoked.length > 0 ||
      fieldChanges.readDeniedAdded.length > 0 ||
      fieldChanges.readDeniedRemoved.length > 0 ||
      fieldChanges.writeDeniedAdded.length > 0 ||
      fieldChanges.writeDeniedRemoved.length > 0 ||
      scopeChanges.changed.length > 0 ||
      scopeChanges.added.length > 0 ||
      scopeChanges.removed.length > 0;

    return {
      role: {
        id: role.id,
        code: role.code,
        nameEn: role.nameEn,
        nameAr: role.nameAr,
        isSystem: role.isSystem,
      },
      changes: {
        capabilities: capabilityChanges,
        fieldPermissions: fieldChanges,
        scopes: scopeChanges,
      },
      warnings: analysis.warnings,
      severityCounts: analysis.severityCounts,
      requiresTypedConfirmation: analysis.requiresTypedConfirmation,
      typedConfirmationPhrase: TYPED_CONFIRMATION_PHRASE,
      riskSummary,
      hasChanges,
    };
  }

  /**
   * Best-effort audit emit for a `rbac.role.change_previewed` row.
   * Called by the controller AFTER the preview is built. Payload
   * is metadata-only (counts + risk flags + warning count) — never
   * the proposed capability set itself.
   */
  async writePreviewAudit(input: {
    actorUserId: string;
    targetRoleId: string;
    targetRoleCode: string;
    result: RoleChangePreviewResult;
  }): Promise<void> {
    if (!this.audit) return;
    try {
      await this.audit.writeEvent({
        action: 'rbac.role.change_previewed',
        entityType: 'role',
        entityId: input.targetRoleId,
        actorUserId: input.actorUserId,
        payload: {
          targetRoleId: input.targetRoleId,
          targetRoleCode: input.targetRoleCode,
          grantedCount: input.result.changes.capabilities.granted.length,
          revokedCount: input.result.changes.capabilities.revoked.length,
          fieldChangeCount:
            input.result.changes.fieldPermissions.readDeniedAdded.length +
            input.result.changes.fieldPermissions.readDeniedRemoved.length +
            input.result.changes.fieldPermissions.writeDeniedAdded.length +
            input.result.changes.fieldPermissions.writeDeniedRemoved.length,
          scopeChangeCount:
            input.result.changes.scopes.changed.length +
            input.result.changes.scopes.added.length +
            input.result.changes.scopes.removed.length,
          warningCount: input.result.warnings.length,
          requiresTypedConfirmation: input.result.requiresTypedConfirmation,
          riskFlags: input.result.riskSummary,
        },
      });
    } catch {
      // Audit is best-effort — never block the preview response.
    }
  }
}

// ─── pure helpers ────────────────────────────────────────────────

function diffCapabilities(
  role: RoleWithCapabilities,
  proposed: readonly string[] | undefined,
): RoleChangePreviewResult['changes']['capabilities'] {
  if (proposed === undefined) {
    return { granted: [], revoked: [], unchangedCount: role.capabilities.length };
  }
  const before = new Set(role.capabilities);
  const after = new Set(proposed);
  const granted: string[] = [];
  const revoked: string[] = [];
  for (const c of after) {
    if (!before.has(c)) granted.push(c);
  }
  for (const c of before) {
    if (!after.has(c)) revoked.push(c);
  }
  granted.sort();
  revoked.sort();
  let unchangedCount = 0;
  for (const c of before) {
    if (after.has(c)) unchangedCount += 1;
  }
  return { granted, revoked, unchangedCount };
}

function diffFieldPermissions(
  role: RoleWithCapabilities,
  proposed: readonly RoleFieldPermissionRow[] | undefined,
): RoleChangePreviewResult['changes']['fieldPermissions'] {
  if (proposed === undefined) {
    return {
      readDeniedAdded: [],
      readDeniedRemoved: [],
      writeDeniedAdded: [],
      writeDeniedRemoved: [],
    };
  }
  const beforeReadDenied = collectDenied(role.fieldPermissions, 'read');
  const beforeWriteDenied = collectDenied(role.fieldPermissions, 'write');
  const afterReadDenied = collectDenied(proposed, 'read');
  const afterWriteDenied = collectDenied(proposed, 'write');
  return {
    readDeniedAdded: setDiff(afterReadDenied, beforeReadDenied),
    readDeniedRemoved: setDiff(beforeReadDenied, afterReadDenied),
    writeDeniedAdded: setDiff(afterWriteDenied, beforeWriteDenied),
    writeDeniedRemoved: setDiff(beforeWriteDenied, afterWriteDenied),
  };
}

function collectDenied(
  rows: readonly RoleFieldPermissionRow[],
  axis: 'read' | 'write',
): Map<string, FieldPermissionPair> {
  const m = new Map<string, FieldPermissionPair>();
  for (const r of rows) {
    const denied = axis === 'read' ? !r.canRead : !r.canWrite;
    if (denied) {
      const key = `${r.resource}::${r.field}`;
      if (!m.has(key)) m.set(key, { resource: r.resource, field: r.field });
    }
  }
  return m;
}

function setDiff(
  a: Map<string, FieldPermissionPair>,
  b: Map<string, FieldPermissionPair>,
): FieldPermissionPair[] {
  const out: FieldPermissionPair[] = [];
  for (const [key, pair] of a) {
    if (!b.has(key)) out.push(pair);
  }
  // Stable order — sort by resource, then field.
  out.sort((x, y) =>
    x.resource === y.resource
      ? x.field.localeCompare(y.field)
      : x.resource.localeCompare(y.resource),
  );
  return out;
}

function diffScopes(
  role: RoleWithCapabilities,
  proposed: readonly RoleScopeRow[] | undefined,
): RoleChangePreviewResult['changes']['scopes'] {
  if (proposed === undefined) {
    return { changed: [], added: [], removed: [] };
  }
  const beforeByResource = new Map<string, RoleScopeRow>();
  for (const s of role.scopes) {
    beforeByResource.set(s.resource, s);
  }
  const afterByResource = new Map<string, RoleScopeRow>();
  for (const s of proposed) {
    afterByResource.set(s.resource, s);
  }
  const changed: ScopeChangeRow[] = [];
  const added: RoleScopeRow[] = [];
  const removed: RoleScopeRow[] = [];
  for (const [resource, after] of afterByResource) {
    const before = beforeByResource.get(resource);
    if (!before) {
      added.push(after);
    } else if (before.scope !== after.scope) {
      changed.push({
        resource: after.resource,
        from: before.scope,
        to: after.scope,
      });
    }
  }
  for (const [resource, before] of beforeByResource) {
    if (!afterByResource.has(resource)) removed.push(before);
  }
  changed.sort((a, b) => a.resource.localeCompare(b.resource));
  added.sort((a, b) => a.resource.localeCompare(b.resource));
  removed.sort((a, b) => a.resource.localeCompare(b.resource));
  return { changed, added, removed };
}

function computeRiskSummary(input: {
  capabilityChanges: RoleChangePreviewResult['changes']['capabilities'];
  fieldChanges: RoleChangePreviewResult['changes']['fieldPermissions'];
}): RoleChangePreviewResult['riskSummary'] {
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
  fieldChanges: RoleChangePreviewResult['changes']['fieldPermissions'],
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
