import { ForbiddenException, Injectable, NotFoundException, Optional } from '@nestjs/common';

import { AuditService } from '../audit/audit.service';

import { derivePublicPermissionShape } from '../identity/auth.service';
import { RbacService, type RoleWithCapabilities } from './rbac.service';
import { SUPER_ADMIN_ROLE_CODE } from './permission-resolver.service';

/**
 * Phase D5 — D5.10: role permission preview service.
 *
 * Read-only debugger that returns the effective permission shape
 * of any tenant role to a privileged caller (capability gate
 * `permission.preview`). The preview is a metadata projection
 * built ON TOP of `derivePublicPermissionShape` (D5.9) — it never
 * generates a session, never impersonates a user, never returns
 * row data. Admins can answer "what can role X see?" before
 * assigning it without seeding a test user.
 *
 * Hard rules:
 *
 *   1. Tenant scope — `roleId` must belong to the caller's
 *      tenant. The underlying `RbacService.findRoleById` runs
 *      inside the tenant context; out-of-tenant ids surface as
 *      `role.not_found`.
 *
 *   2. Super-admin sandwich — the SUPER_ADMIN role is the most
 *      privileged surface in the system. Only a caller whose
 *      role.code === 'super_admin' may preview it. Other callers
 *      (ops_manager) receive `role.preview.forbidden` even when
 *      they hold `permission.preview`. The check sits in this
 *      service rather than the controller because the
 *      capability gate alone cannot encode "you may preview
 *      every role except this one".
 *
 *   3. No values, only metadata — every field on the result
 *      describes ROLE STRUCTURE (capability codes, resource +
 *      field names, scope strings). Catalogue labels (labelEn /
 *      labelAr) ship for UI rendering. No row data, no PII, no
 *      cached request payloads enter the projection.
 *
 *   4. Warnings are derived deterministically from the role's
 *      grants — they are pure functions of the projection, with
 *      no clock reads. Replaying the same role through the
 *      service always produces the same warnings list.
 *
 * Audit:
 *   Every preview call writes one `audit_events.rbac.role.previewed`
 *   row carrying `targetRoleId` / `targetRoleCode` /
 *   `actorUserId` / counters / warning codes. The audit row is
 *   metadata-only (matches the D5.6A export-audit pattern).
 *   Audit failures are best-effort — they DO NOT block the
 *   preview response (the service returns the projection even if
 *   the audit write throws).
 */

export interface RolePreviewResult {
  readonly role: {
    readonly id: string;
    readonly code: string;
    readonly nameEn: string;
    readonly nameAr: string;
    readonly level: number;
    readonly isSystem: boolean;
  };
  readonly permissions: {
    readonly capabilities: readonly string[];
    readonly scopesByResource: Readonly<Record<string, string>>;
    readonly deniedReadFieldsByResource: Readonly<Record<string, readonly string[]>>;
    readonly deniedWriteFieldsByResource: Readonly<Record<string, readonly string[]>>;
  };
  readonly uiHints: {
    /**
     * Mirror of `permissions.deniedReadFieldsByResource` named
     * intuitively for the role-editor UI. Frontend binds to this
     * key when listing "fields hidden from this role".
     */
    readonly hiddenFieldsByResource: Readonly<Record<string, readonly string[]>>;
    /**
     * Mirror of `permissions.deniedWriteFieldsByResource` for the
     * write-side equivalent ("fields read-only for this role").
     */
    readonly readOnlyFieldsByResource: Readonly<Record<string, readonly string[]>>;
    /**
     * Subset of `permissions.capabilities` whose `code` ends with
     * `.export` plus the legacy `tenant.export`. Used by the
     * role-editor preview tab to highlight "this role can ship
     * data off-platform".
     */
    readonly exportCapabilities: readonly string[];
    /**
     * `true` when the role lacks `lead.read`. The role-editor
     * surfaces this as the headline "this role cannot see leads"
     * warning so an admin doesn't accidentally give it to someone
     * who needs operational access.
     */
    readonly hasLeadRead: boolean;
  };
  /**
   * Stable warning codes the role-editor renders as plain
   * sentences. Codes (not free-text) so the UI can localise.
   */
  readonly warnings: readonly RolePreviewWarningCode[];
}

export type RolePreviewWarningCode =
  | 'has_export_capabilities'
  | 'has_partner_data_access'
  | 'has_partner_merge_capability'
  | 'has_audit_payload_access'
  | 'no_lead_read_capability'
  | 'has_hidden_owner_history_fields'
  | 'has_super_admin_bypass';

/**
 * Caller claims required by the preview service. The controller
 * passes the JWT-resolved actor + role; the service consults the
 * role to enforce the super-admin-only-previews-super-admin rule.
 */
export interface RolePreviewActor {
  readonly userId: string;
  readonly roleCode: string;
}

@Injectable()
export class RolePreviewService {
  constructor(
    private readonly rbac: RbacService,
    @Optional() private readonly audit?: AuditService,
  ) {}

  /**
   * Generate the preview projection. Throws:
   *   • `role.not_found` (404)              — role outside tenant.
   *   • `role.preview.forbidden` (403)      — super-admin guard.
   */
  async previewRole(roleId: string, actor: RolePreviewActor): Promise<RolePreviewResult> {
    const role = await this.rbac.findRoleById(roleId);
    if (!role) {
      throw new NotFoundException({
        code: 'role.not_found',
        message: `Role ${roleId} not found in this tenant.`,
      });
    }

    // Super-admin sandwich: only super-admin may preview super-admin.
    if (role.code === SUPER_ADMIN_ROLE_CODE && actor.roleCode !== SUPER_ADMIN_ROLE_CODE) {
      throw new ForbiddenException({
        code: 'role.preview.forbidden',
        message: 'Only a super-admin can preview the super-admin role.',
      });
    }

    const projection = derivePublicPermissionShape(role);
    const uiHints = buildUiHints(role, projection);
    const warnings = buildWarnings(role, projection, uiHints);

    const result: RolePreviewResult = {
      role: {
        id: role.id,
        code: role.code,
        nameEn: role.nameEn,
        nameAr: role.nameAr,
        level: role.level,
        isSystem: role.isSystem,
      },
      permissions: {
        capabilities: [...role.capabilities],
        scopesByResource: projection.scopesByResource,
        deniedReadFieldsByResource: projection.deniedReadFieldsByResource,
        deniedWriteFieldsByResource: projection.deniedWriteFieldsByResource,
      },
      uiHints,
      warnings,
    };

    // Best-effort audit. The preview response ships even if the
    // audit write throws (matches D5.6A export-audit semantics).
    if (this.audit) {
      try {
        await this.audit.writeEvent({
          action: 'rbac.role.previewed',
          entityType: 'role',
          entityId: role.id,
          actorUserId: actor.userId,
          payload: {
            targetRoleId: role.id,
            targetRoleCode: role.code,
            capabilitiesCount: role.capabilities.length,
            deniedReadCount: countAcrossMap(projection.deniedReadFieldsByResource),
            deniedWriteCount: countAcrossMap(projection.deniedWriteFieldsByResource),
            warnings: [...warnings],
          },
        });
      } catch {
        // Swallow — audit write failure must never block the
        // operator from seeing the preview. AuditService itself
        // already swallows DB failures internally; this catch is
        // belt-and-braces for transient errors that escape its
        // own envelope.
      }
    }

    return result;
  }
}

// ─── helpers (pure) ──────────────────────────────────────────────

function buildUiHints(
  role: RoleWithCapabilities,
  projection: ReturnType<typeof derivePublicPermissionShape>,
): RolePreviewResult['uiHints'] {
  const exportCapabilities: string[] = [];
  for (const c of role.capabilities) {
    if (c === 'tenant.export' || c.endsWith('.export')) {
      exportCapabilities.push(c);
    }
  }
  exportCapabilities.sort();

  return {
    hiddenFieldsByResource: projection.deniedReadFieldsByResource,
    readOnlyFieldsByResource: projection.deniedWriteFieldsByResource,
    exportCapabilities,
    hasLeadRead: role.capabilities.includes('lead.read'),
  };
}

const PARTNER_READ_CAPS = new Set([
  'partner.source.read',
  'partner.verification.read',
  'partner.reconciliation.read',
]);

function buildWarnings(
  role: RoleWithCapabilities,
  projection: ReturnType<typeof derivePublicPermissionShape>,
  uiHints: RolePreviewResult['uiHints'],
): readonly RolePreviewWarningCode[] {
  const warnings: RolePreviewWarningCode[] = [];

  if (role.code === SUPER_ADMIN_ROLE_CODE) {
    warnings.push('has_super_admin_bypass');
  }

  if (uiHints.exportCapabilities.length > 0) {
    warnings.push('has_export_capabilities');
  }

  for (const c of role.capabilities) {
    if (PARTNER_READ_CAPS.has(c)) {
      warnings.push('has_partner_data_access');
      break;
    }
  }

  if (role.capabilities.includes('partner.merge.write')) {
    warnings.push('has_partner_merge_capability');
  }

  // Audit payload access — having `audit.read` lets the role view
  // raw audit JSON unless `audit.payload` / `audit.beforeAfter`
  // field-permissions are denied. The preview surfaces the warning
  // when audit.read is granted AND no field-level deny is in place.
  if (role.capabilities.includes('audit.read')) {
    const auditDenies = projection.deniedReadFieldsByResource['audit'] ?? [];
    if (!auditDenies.includes('payload') && !auditDenies.includes('beforeAfter')) {
      warnings.push('has_audit_payload_access');
    }
  }

  if (!uiHints.hasLeadRead) {
    warnings.push('no_lead_read_capability');
  }

  // Hidden owner-history fields (D5.7 surface): if any of
  // rotation.fromUser / rotation.toUser / rotation.actor /
  // rotation.notes / lead.previousOwner / lead.ownerHistory is
  // denied, surface the corresponding warning so the admin
  // understands the role's view of operational history.
  const rotationDenies = new Set(projection.deniedReadFieldsByResource['rotation'] ?? []);
  const leadDenies = new Set(projection.deniedReadFieldsByResource['lead'] ?? []);
  const hiddenOwnerHistory =
    rotationDenies.has('fromUser') ||
    rotationDenies.has('toUser') ||
    rotationDenies.has('actor') ||
    rotationDenies.has('notes') ||
    leadDenies.has('previousOwner') ||
    leadDenies.has('ownerHistory');
  if (hiddenOwnerHistory) {
    warnings.push('has_hidden_owner_history_fields');
  }

  return warnings;
}

function countAcrossMap(map: Readonly<Record<string, readonly string[]>>): number {
  let n = 0;
  for (const v of Object.values(map)) n += v.length;
  return n;
}
