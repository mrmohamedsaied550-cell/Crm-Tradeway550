import { Injectable, NotFoundException, Optional } from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { requireTenantId } from '../tenants/tenant-context';

import {
  SELF_LOCKOUT_CAPABILITIES,
  TENANT_LAST_KEEPER_CAPABILITIES,
  analyseCapabilitySet,
  type RoleDependencyWarning,
  type RoleDependencyWarningSeverity,
} from './capability-dependencies';
import { RbacService } from './rbac.service';
import { SUPER_ADMIN_ROLE_CODE } from './permission-resolver.service';

/**
 * Phase D5 — D5.14: dependency-aware role guards + lockout safety.
 *
 * Admins now have a powerful role builder (D5.1 → D5.13 wired the
 * field permissions, scopes, capabilities, and visibility surfaces
 * that consume them). D5.14 closes the corresponding UX safety gap:
 *
 *   • show structural warnings BEFORE save, not silently;
 *   • require typed confirmation for changes that could lock the
 *     actor out of the role builder;
 *   • surface the analysis through a dedicated endpoint so the
 *     frontend can render inline hints + group warnings by
 *     severity.
 *
 * The service is split deliberately:
 *
 *   1. `analyseCapabilitySet(proposed)` (pure helper in
 *      `capability-dependencies.ts`) — the dependency / high-risk
 *      core. Same shape regardless of tenant context.
 *
 *   2. `RoleDependencyService.analyseProposal({ roleId, proposedCapabilities,
 *      actor })` — wraps the pure helper with the tenant-scoped
 *      context the lockout / last-keeper / system-role checks need.
 *      Returns the full `DependencyAnalysis`.
 *
 *   3. `RoleDependencyService.assertConfirmationOk({ analysis,
 *      confirmation })` — the chokepoint that the rbac.service.ts
 *      `updateRole` consults. Throws
 *      `BadRequestException({ code: 'role.dependency.confirmation_required' })`
 *      with the warnings list so the client can render the typed-
 *      confirmation modal. Idempotent: re-calling with the right
 *      phrase passes silently.
 *
 * Constraint: dependency analysis is NEVER a write path. The
 * service ONLY reads; the caller writes. Audit emission for the
 * `dependency_check` verb sits in the controller (the endpoint
 * handler) so the service stays testable as a pure function +
 * read-only DB consumer.
 */

/**
 * The phrase the client must echo back to confirm a critical
 * lockout-bearing change. Constant lives here so the service +
 * controller + frontend share one source of truth (the frontend
 * mirror is in `apps/web/lib/api-types.ts`).
 */
export const TYPED_CONFIRMATION_PHRASE = 'CONFIRM ROLE CHANGE';

export interface DependencyAnalysis {
  readonly warnings: readonly RoleDependencyWarning[];
  readonly severityCounts: Readonly<Record<RoleDependencyWarningSeverity, number>>;
  /**
   * `true` when at least one critical warning is present. The
   * client must render the typed-confirmation modal before save;
   * the API enforces the modal at the service layer regardless.
   */
  readonly requiresTypedConfirmation: boolean;
  /** The (echoed) phrase the typed-confirmation modal should ask for. */
  readonly typedConfirmationPhrase: string;
}

export interface AnalyseProposalInput {
  readonly roleId: string;
  /** The proposed capability set after save (deduped by the caller). */
  readonly proposedCapabilities: readonly string[];
  readonly actor: { readonly userId: string; readonly roleId: string };
}

@Injectable()
export class RoleDependencyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
    /**
     * Audit dependency-check + warning-confirmation events. Optional
     * so the unit-test fixture (which exercises pure analysis) can
     * construct the service without wiring the audit chain. Production
     * wiring (RbacModule) provides the real instance.
     */
    @Optional() private readonly audit?: AuditService,
  ) {}

  /**
   * Run the full analysis (pure helper + tenant-scoped checks).
   * Throws `role.not_found` when the target role is outside the
   * caller's tenant.
   */
  async analyseProposal(input: AnalyseProposalInput): Promise<DependencyAnalysis> {
    const role = await this.rbac.findRoleById(input.roleId);
    if (!role) {
      throw new NotFoundException({
        code: 'role.not_found',
        message: `Role ${input.roleId} not found in this tenant.`,
      });
    }

    const baseWarnings = analyseCapabilitySet(input.proposedCapabilities);
    const warnings: RoleDependencyWarning[] = [...baseWarnings];

    // System-role attempt: surfacing the warning preemptively means
    // the client can disable save before the server throws
    // `role.system_immutable`. The controller still rejects the
    // PATCH downstream — this is UX guidance, not a gate.
    if (role.isSystem) {
      warnings.push({
        code: 'role.system_immutable_attempt',
        severity: 'critical',
        capability: null,
        dependsOn: [],
        messageKey: 'admin.roles.dependency.warnings.systemImmutable',
        meta: { roleCode: role.code, isSuperAdmin: role.code === SUPER_ADMIN_ROLE_CODE },
      });
    }

    // Self-lockout: actor is editing their OWN role and the diff
    // removes a capability the SELF_LOCKOUT_CAPABILITIES set
    // protects.
    if (input.actor.roleId === role.id) {
      const before = new Set(role.capabilities);
      const after = new Set(input.proposedCapabilities);
      for (const cap of SELF_LOCKOUT_CAPABILITIES) {
        if (before.has(cap) && !after.has(cap)) {
          warnings.push({
            code: 'capability.lockout.self_required',
            severity: 'critical',
            capability: cap,
            dependsOn: [],
            messageKey: 'admin.roles.dependency.warnings.selfLockout',
            meta: { capability: cap },
          });
        }
      }
    }

    // Last-keeper: removing a TENANT_LAST_KEEPER cap from the only
    // tenant role that holds it. Conservative — the count includes
    // the role being edited if its proposed set still contains the
    // cap.
    for (const cap of TENANT_LAST_KEEPER_CAPABILITIES) {
      const before = new Set(role.capabilities);
      const after = new Set(input.proposedCapabilities);
      if (!before.has(cap) || after.has(cap)) continue;
      const otherKeepers = await this.countOtherRolesHoldingCapability({
        excludeRoleId: role.id,
        capabilityCode: cap,
      });
      if (otherKeepers === 0) {
        warnings.push({
          code: 'capability.lockout.last_admin',
          severity: 'critical',
          capability: cap,
          dependsOn: [],
          messageKey: 'admin.roles.dependency.warnings.lastAdmin',
          meta: { capability: cap, otherKeepers: 0 },
        });
      }
    }

    return buildAnalysis(warnings);
  }

  /**
   * Gate that `updateRole` consults. Throws
   * `BadRequestException({ code: 'role.dependency.confirmation_required',
   * warnings, requiredPhrase })` when the analysis carries any
   * critical warning AND `confirmation` does not exactly equal
   * `TYPED_CONFIRMATION_PHRASE`. Returns silently otherwise so the
   * write proceeds.
   */
  assertConfirmationOk(analysis: DependencyAnalysis, confirmation: string | undefined): void {
    if (!analysis.requiresTypedConfirmation) return;
    if (confirmation === TYPED_CONFIRMATION_PHRASE) return;
    throw new RoleDependencyConfirmationRequiredError(analysis);
  }

  /**
   * Best-effort audit emit for the `rbac.role.dependency_check`
   * verb. Called from the dedicated endpoint after a successful
   * analysis. Payload is metadata-only (warning codes + counts)
   * so the audit feed never echoes raw row data.
   */
  async writeDependencyCheckAudit(input: {
    actorUserId: string;
    targetRoleId: string;
    targetRoleCode: string;
    analysis: DependencyAnalysis;
  }): Promise<void> {
    if (!this.audit) return;
    try {
      await this.audit.writeEvent({
        action: 'rbac.role.dependency_check',
        entityType: 'role',
        entityId: input.targetRoleId,
        actorUserId: input.actorUserId,
        payload: {
          targetRoleId: input.targetRoleId,
          targetRoleCode: input.targetRoleCode,
          warningCodes: input.analysis.warnings.map((w) => w.code),
          severityCounts: input.analysis.severityCounts,
          requiresTypedConfirmation: input.analysis.requiresTypedConfirmation,
        },
      });
    } catch {
      // Audit is best-effort — never block the analysis response.
    }
  }

  /**
   * Best-effort audit emit when an actor confirmed a critical
   * change with the typed-confirmation phrase. Called from
   * `RbacService.updateRole` AFTER the write succeeds (so the row
   * sits between the role.update + role.capability.update verbs).
   * Payload mirrors `dependency_check` but adds an explicit
   * `confirmedCriticals` field so audit consumers can spot
   * confirmed-vs-blocked rows.
   */
  async writeConfirmationAudit(input: {
    actorUserId: string;
    targetRoleId: string;
    targetRoleCode: string;
    analysis: DependencyAnalysis;
  }): Promise<void> {
    if (!this.audit) return;
    if (!input.analysis.requiresTypedConfirmation) return;
    try {
      await this.audit.writeEvent({
        action: 'rbac.role.dependency_warning_confirmed',
        entityType: 'role',
        entityId: input.targetRoleId,
        actorUserId: input.actorUserId,
        payload: {
          targetRoleId: input.targetRoleId,
          targetRoleCode: input.targetRoleCode,
          warningCodes: input.analysis.warnings.map((w) => w.code),
          severityCounts: input.analysis.severityCounts,
          confirmedCriticals: input.analysis.severityCounts.critical,
        },
      });
    } catch {
      /* swallow — audit is best-effort */
    }
  }

  /**
   * Tenant-scoped read: how many other ACTIVE roles in the active
   * tenant grant this capability? The "active" filter mirrors the
   * runtime CapabilityGuard which only consults active roles.
   */
  private async countOtherRolesHoldingCapability(input: {
    excludeRoleId: string;
    capabilityCode: string;
  }): Promise<number> {
    const tenantId = requireTenantId();
    return this.prisma.withTenant(tenantId, async (tx) => {
      return tx.roleCapability.count({
        where: {
          roleId: { not: input.excludeRoleId },
          role: { isActive: true },
          capability: { code: input.capabilityCode },
        },
      });
    });
  }
}

/**
 * Typed exception so `RbacService.updateRole` can re-throw it
 * verbatim (the BadRequestException response carries the warnings
 * payload the client renders in the typed-confirmation modal).
 */
export class RoleDependencyConfirmationRequiredError extends Error {
  readonly code = 'role.dependency.confirmation_required';
  readonly status = 400;
  constructor(public readonly analysis: DependencyAnalysis) {
    super('typed confirmation required for critical role change');
    this.name = 'RoleDependencyConfirmationRequiredError';
  }

  toResponse() {
    return {
      code: this.code,
      message:
        'This change includes critical warnings. Type the confirmation phrase exactly to proceed.',
      requiredPhrase: TYPED_CONFIRMATION_PHRASE,
      analysis: this.analysis,
    };
  }
}

// ─── helpers (pure) ──────────────────────────────────────────────

function buildAnalysis(warnings: readonly RoleDependencyWarning[]): DependencyAnalysis {
  let info = 0;
  let warning = 0;
  let critical = 0;
  for (const w of warnings) {
    if (w.severity === 'info') info += 1;
    else if (w.severity === 'warning') warning += 1;
    else critical += 1;
  }
  return {
    warnings,
    severityCounts: { info, warning, critical },
    requiresTypedConfirmation: critical > 0,
    typedConfirmationPhrase: TYPED_CONFIRMATION_PHRASE,
  };
}

/**
 * Exported for use by `RbacService.updateRole` so it can re-throw
 * the `BadRequestException` shape the controller already serialises.
 * Keeping the conversion here avoids leaking the internal error
 * class through the rbac.service public surface.
 */
export function toBadRequestResponse(err: RoleDependencyConfirmationRequiredError): {
  code: string;
  message: string;
  requiredPhrase: string;
  analysis: DependencyAnalysis;
} {
  return err.toResponse();
}
