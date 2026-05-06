import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';

import { AuditService } from '../audit/audit.service';

import { HIGH_RISK_CAPABILITIES } from './capability-dependencies';
import {
  RbacService,
  type RoleFieldPermissionRow,
  type RoleScopeRow,
  type RoleWithCapabilities,
} from './rbac.service';
import {
  RoleDependencyConfirmationRequiredError,
  RoleDependencyService,
  TYPED_CONFIRMATION_PHRASE,
  type DependencyAnalysis,
} from './role-dependency.service';
import {
  ROLE_TEMPLATE_DEFINITIONS,
  getRoleTemplate,
  type RoleTemplateDef,
  type RoleTemplateRiskTag,
} from './role-templates.registry';

/**
 * Phase D5 — D5.16: Role Templates service.
 *
 * Builds the read surface for the curated template registry +
 * the safe `createFromTemplate` flow that replaces the existing
 * "Duplicate role → strip dangerous capabilities" pattern.
 *
 * Hard rules:
 *
 *   1. Templates are immutable structural data shipped with the
 *      product. The service NEVER writes to the registry.
 *
 *   2. `createFromTemplate` flows through the SAME write path
 *      the regular role builder uses:
 *        a. Run D5.14 dependency analysis on the template's
 *           capability set against the actor's claims; throw
 *           `role.dependency.confirmation_required` if the
 *           template carries critical-severity warnings AND the
 *           caller didn't echo the typed phrase.
 *        b. Call `RbacService.createRole` with the template's
 *           caps / scopes / field perms. That call already:
 *              - validates every cap against the global
 *                catalogue,
 *              - writes a `role.create` audit row,
 *              - appends a `triggerAction='create'` version row
 *                via the D5.15-B recorder,
 *              - invalidates the resolver cache.
 *        c. Emit `rbac.role.created_from_template` (best-effort
 *           audit row that links the new role id back to the
 *           template).
 *
 *   3. Preview is read-only — `previewTemplate` returns the
 *      template data + the dependency analysis so the picker UI
 *      can render the same warnings the create endpoint will
 *      enforce. Optionally writes a `rbac.role.template_previewed`
 *      audit row so admins can audit "who probed templates".
 *
 *   4. NEVER auto-grant dependencies that aren't in the
 *      template. The dependency analyser surfaces missing
 *      pairs as warnings; the admin sees them in the picker
 *      and either accepts or asks for a different template.
 */

export interface RoleTemplateSummary {
  readonly code: string;
  readonly nameEn: string;
  readonly nameAr: string;
  readonly descriptionEn: string;
  readonly descriptionAr: string;
  readonly category: RoleTemplateDef['category'];
  readonly suggestedLevel: number;
  readonly capabilityCount: number;
  readonly scopeCount: number;
  readonly fieldPermissionCount: number;
  readonly riskTags: readonly RoleTemplateRiskTag[];
}

export interface RoleTemplateDetail extends RoleTemplateSummary {
  readonly capabilities: readonly string[];
  readonly scopes: readonly RoleScopeRow[];
  readonly fieldPermissions: readonly RoleFieldPermissionRow[];
}

export interface RoleTemplatePreviewResult {
  readonly template: RoleTemplateDetail;
  readonly dependencyAnalysis: DependencyAnalysis;
  readonly highRiskCapabilities: readonly string[];
  readonly typedConfirmationPhrase: string;
}

export interface CreateFromTemplateInput {
  readonly templateCode: string;
  /** New role's machine identifier — admin-supplied, snake_case. */
  readonly code: string;
  readonly nameEn: string;
  readonly nameAr: string;
  readonly descriptionEn?: string | null;
  readonly descriptionAr?: string | null;
  /** Echoed back when the template's caps trigger a critical D5.14 warning. */
  readonly confirmation?: string;
  /**
   * Optional admin overrides at create time. The role editor's
   * subsequent capability / scope / field tabs cover deeper
   * customisation; these two slots let the picker pre-tweak
   * scope and field-perm rows without a second round-trip.
   */
  readonly initialScopeOverrides?: readonly RoleScopeRow[];
  readonly initialFieldPermissionOverrides?: readonly RoleFieldPermissionRow[];
  readonly actor: { readonly userId: string; readonly roleId: string };
}

@Injectable()
export class RoleTemplateService {
  constructor(
    private readonly rbac: RbacService,
    private readonly dependencies: RoleDependencyService,
    @Optional() private readonly audit?: AuditService,
  ) {}

  /**
   * Read-only — returns the curated registry summary. Capability
   * codes / field-permission rows / scope rows ride on the detail
   * endpoint, not here.
   */
  list(): readonly RoleTemplateSummary[] {
    return ROLE_TEMPLATE_DEFINITIONS.map((t) => this.summarise(t));
  }

  get(code: string): RoleTemplateDetail {
    const t = getRoleTemplate(code);
    if (!t) {
      throw new NotFoundException({
        code: 'role_template.not_found',
        message: `Role template '${code}' is not in the registry.`,
      });
    }
    return this.detail(t);
  }

  /**
   * Run the full dependency analysis on the template's capability
   * set so the picker UI can render the same warnings the create
   * endpoint will enforce. The analysis runs against an empty
   * "current role" baseline (the role doesn't exist yet) — only
   * structural warnings (missing-dependency, high-risk) and the
   * actor's own-role lockout / last-keeper checks fire. For a
   * fresh-create, neither lockout case applies (the new role is
   * never the actor's role; granting roles.write to a NEW role
   * doesn't drop the keeper count below the existing total), so
   * critical warnings are unusual but possible if the template
   * targets a system-role-like persona — the gate stays in place.
   */
  async preview(
    code: string,
    actor: { readonly userId: string; readonly roleId: string },
  ): Promise<RoleTemplatePreviewResult> {
    const detail = this.get(code);
    // Use the actor's own role as the "target role" for the
    // dependency analyser — that's the closest legitimate role
    // we can analyse against (the new role has no id yet). The
    // self-lockout check therefore won't fire (the actor's
    // current capabilities + scopes ARE the analyser's input,
    // not the template's), but every OTHER warning the analyser
    // emits about the proposed cap set still surfaces.
    //
    // Note: the create endpoint runs a fresh analysis against
    // the same input + the same actor; the picker's preview is
    // a read-only preview, the create call is the chokepoint.
    const analysis = await this.dependencies.analyseProposal({
      roleId: actor.roleId,
      proposedCapabilities: detail.capabilities,
      actor,
    });

    const highRiskCapabilities = detail.capabilities.filter(
      (c) => HIGH_RISK_CAPABILITIES[c] !== undefined,
    );

    if (this.audit) {
      try {
        await this.audit.writeEvent({
          action: 'rbac.role.template_previewed',
          entityType: 'role_template',
          entityId: detail.code,
          actorUserId: actor.userId,
          payload: {
            templateCode: detail.code,
            category: detail.category,
            capabilityCount: detail.capabilities.length,
            highRiskCount: highRiskCapabilities.length,
            riskTags: detail.riskTags,
            warningCount: analysis.warnings.length,
            requiresTypedConfirmation: analysis.requiresTypedConfirmation,
          },
        });
      } catch {
        /* best-effort */
      }
    }

    return {
      template: detail,
      dependencyAnalysis: analysis,
      highRiskCapabilities,
      typedConfirmationPhrase: TYPED_CONFIRMATION_PHRASE,
    };
  }

  /**
   * Create a custom role from the template. Routes the write
   * through `RbacService.createRole` so:
   *
   *   • capability codes are validated against the global
   *     registry,
   *   • the standard `role.create` audit row is written,
   *   • a `triggerAction='create'` version row is appended via
   *     the D5.15-B recorder,
   *   • the resolver cache is invalidated.
   *
   * Adds D5.16-specific:
   *   • dependency-check + typed-confirmation gate BEFORE the
   *     create (matches the regular `updateRole` chokepoint),
   *   • a dedicated `rbac.role.created_from_template` audit row
   *     written AFTER the create so the audit feed correlates
   *     "this role originated from template X".
   */
  async createFromTemplate(input: CreateFromTemplateInput): Promise<RoleWithCapabilities> {
    const detail = this.get(input.templateCode);

    // 1. Apply admin overrides on top of the template's defaults.
    //    The override sets are merged at the resource / (resource,
    //    field) level so an override for `lead` scope replaces
    //    the template's `lead` row but leaves the other resources
    //    untouched.
    const scopes = mergeScopes(detail.scopes, input.initialScopeOverrides ?? []);
    const fieldPermissions = mergeFieldPermissions(
      detail.fieldPermissions,
      input.initialFieldPermissionOverrides ?? [],
    );

    // 2. Dependency check + critical confirmation gate. Mirrors
    //    the chokepoint in `updateRole` so the create flow can't
    //    bypass D5.14 by going through the template path.
    const analysis = await this.dependencies.analyseProposal({
      roleId: input.actor.roleId, // analyser sees the actor's own role (no new-role id yet)
      proposedCapabilities: detail.capabilities,
      actor: input.actor,
    });
    try {
      this.dependencies.assertConfirmationOk(analysis, input.confirmation);
    } catch (err) {
      if (err instanceof RoleDependencyConfirmationRequiredError) {
        throw new BadRequestException(err.toResponse());
      }
      throw err;
    }

    // 3. Forward to the existing `RbacService.createRole`. That
    //    method handles every safety check (system-code reservation,
    //    capability validation, audit, version capture, cache
    //    invalidation). We pass the merged sets verbatim.
    const created = await this.rbac.createRole(
      {
        code: input.code,
        nameEn: input.nameEn,
        nameAr: input.nameAr,
        level: detail.suggestedLevel,
        description: input.descriptionEn ?? null,
        capabilities: [...detail.capabilities],
        scopes: scopes.map((s) => ({ resource: s.resource, scope: s.scope })),
        fieldPermissions: fieldPermissions.map((p) => ({
          resource: p.resource,
          field: p.field,
          canRead: p.canRead,
          canWrite: p.canWrite,
        })),
      },
      input.actor.userId,
    );

    // 4. Best-effort dedicated audit row. The shared `rbac.`
    //    prefix means the audit governance chip strip already
    //    surfaces it.
    if (this.audit) {
      try {
        await this.audit.writeEvent({
          action: 'rbac.role.created_from_template',
          entityType: 'role',
          entityId: created.id,
          actorUserId: input.actor.userId,
          payload: {
            templateCode: detail.code,
            templateCategory: detail.category,
            templateRiskTags: detail.riskTags,
            targetRoleId: created.id,
            targetRoleCode: created.code,
            capabilityCount: created.capabilities.length,
            scopeCount: scopes.length,
            fieldPermissionCount: fieldPermissions.length,
            warningCount: analysis.warnings.length,
            confirmedCriticals: analysis.severityCounts.critical,
          },
        });
      } catch {
        /* best-effort */
      }
    }

    return created;
  }

  // ─── helpers ──────────────────────────────────────────────────

  private summarise(t: RoleTemplateDef): RoleTemplateSummary {
    return {
      code: t.code,
      nameEn: t.nameEn,
      nameAr: t.nameAr,
      descriptionEn: t.descriptionEn,
      descriptionAr: t.descriptionAr,
      category: t.category,
      suggestedLevel: t.suggestedLevel,
      capabilityCount: t.capabilities.length,
      scopeCount: t.scopes.length,
      fieldPermissionCount: t.fieldPermissions.length,
      riskTags: t.riskTags,
    };
  }

  private detail(t: RoleTemplateDef): RoleTemplateDetail {
    return {
      ...this.summarise(t),
      capabilities: [...t.capabilities],
      scopes: t.scopes.map((s) => ({ resource: s.resource, scope: s.scope })),
      fieldPermissions: t.fieldPermissions.map((p) => ({
        resource: p.resource,
        field: p.field,
        canRead: p.canRead,
        canWrite: p.canWrite,
      })),
    };
  }
}

// ─── pure helpers (exported for unit tests) ─────────────────────

/**
 * Merge admin scope overrides on top of the template's defaults.
 * Overrides REPLACE rows for the same `resource`; resources not
 * mentioned in the override list keep their template default.
 */
export function mergeScopes(
  template: readonly RoleScopeRow[],
  overrides: readonly RoleScopeRow[],
): readonly RoleScopeRow[] {
  const map = new Map<string, RoleScopeRow>(template.map((s) => [s.resource, s]));
  for (const o of overrides) {
    map.set(o.resource, o);
  }
  return Array.from(map.values()).sort((a, b) => a.resource.localeCompare(b.resource));
}

/**
 * Merge admin field-permission overrides on top of the template's
 * defaults. Overrides REPLACE rows for the same `(resource, field)`
 * pair; absent pairs keep the template default.
 */
export function mergeFieldPermissions(
  template: readonly RoleFieldPermissionRow[],
  overrides: readonly RoleFieldPermissionRow[],
): readonly RoleFieldPermissionRow[] {
  const map = new Map<string, RoleFieldPermissionRow>(
    template.map((p) => [`${p.resource}::${p.field}`, p]),
  );
  for (const o of overrides) {
    map.set(`${o.resource}::${o.field}`, o);
  }
  return Array.from(map.values()).sort((a, b) =>
    a.resource === b.resource
      ? a.field.localeCompare(b.field)
      : a.resource.localeCompare(b.resource),
  );
}
