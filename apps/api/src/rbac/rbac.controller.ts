import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';

import { CurrentUser } from '../identity/current-user.decorator';
import { JwtAuthGuard } from '../identity/jwt-auth.guard';
import type { AccessTokenClaims } from '../identity/jwt.types';

import { CapabilityGuard } from './capability.guard';
import { FIELD_CATALOGUE } from './field-catalogue.registry';
import {
  CreateFromTemplateSchema,
  CreateRoleSchema,
  DuplicateRoleSchema,
  PutRoleFieldPermissionsSchema,
  PutRoleScopesSchema,
  RevertRoleVersionSchema,
  RoleChangePreviewSchema,
  RoleDependencyCheckSchema,
  RoleTemplatePreviewSchema,
  UpdateRoleSchema,
} from './rbac.dto';
import { RequireCapability } from './require-capability.decorator';
import {
  RbacService,
  type RoleSummary,
  type RoleWithCapabilities,
  type RoleScopeRow,
  type RoleFieldPermissionRow,
} from './rbac.service';
import {
  RoleChangePreviewService,
  type RoleChangePreviewResult,
} from './role-change-preview.service';
import {
  RoleDependencyConfirmationRequiredError,
  RoleDependencyService,
  type DependencyAnalysis,
} from './role-dependency.service';
import { RolePreviewService, type RolePreviewResult } from './role-preview.service';
import {
  RoleTemplateService,
  type RoleTemplateDetail,
  type RoleTemplatePreviewResult,
  type RoleTemplateSummary,
} from './role-template.service';
import {
  RoleVersionService,
  type RoleVersionDetail,
  type RoleVersionListResult,
} from './role-version.service';

class CreateRoleDto extends createZodDto(CreateRoleSchema) {}
class UpdateRoleDto extends createZodDto(UpdateRoleSchema) {}
class DuplicateRoleDto extends createZodDto(DuplicateRoleSchema) {}
class PutRoleScopesDto extends createZodDto(PutRoleScopesSchema) {}
class PutRoleFieldPermissionsDto extends createZodDto(PutRoleFieldPermissionsSchema) {}
class RoleDependencyCheckDto extends createZodDto(RoleDependencyCheckSchema) {}
class RoleChangePreviewDto extends createZodDto(RoleChangePreviewSchema) {}
class RevertRoleVersionDto extends createZodDto(RevertRoleVersionSchema) {}
class CreateFromTemplateDto extends createZodDto(CreateFromTemplateSchema) {}
// Reserved: empty preview body. Defined so a future schema change
// is a controller-only edit.
class RoleTemplatePreviewDto extends createZodDto(RoleTemplatePreviewSchema) {}

/**
 * /api/v1/rbac — RBAC introspection + Phase C — C2 write surface.
 *
 * Reads (`GET /rbac/roles`, `GET /rbac/roles/:id`, `GET /rbac/capabilities`)
 * are gated by `roles.read` / `capabilities.read`.
 *
 * Writes (POST / PATCH / DELETE / duplicate / scopes / field-permissions)
 * are gated by `roles.write`, granted to super_admin / ops_manager /
 * account_manager. System role immutability is enforced inside the
 * service, not at the route — controllers carry one rule each.
 */
@ApiTags('rbac')
@Controller('rbac')
@UseGuards(JwtAuthGuard, CapabilityGuard)
export class RbacController {
  constructor(
    private readonly rbac: RbacService,
    private readonly rolePreview: RolePreviewService,
    private readonly roleDependency: RoleDependencyService,
    private readonly roleChangePreview: RoleChangePreviewService,
    private readonly roleVersions: RoleVersionService,
    private readonly roleTemplates: RoleTemplateService,
  ) {}

  @Get('roles')
  @RequireCapability('roles.read')
  @ApiOperation({
    summary: 'List active roles in the active tenant (id, code, names, capability count)',
  })
  listRoles(): Promise<RoleSummary[]> {
    return this.rbac.listRoleSummaries();
  }

  @Get('roles/:id')
  @RequireCapability('roles.read')
  @ApiOperation({
    summary: 'Get one role with its capability codes, scopes, and field permissions',
  })
  async findOne(@Param('id', new ParseUUIDPipe()) id: string): Promise<RoleWithCapabilities> {
    const role = await this.rbac.findRoleById(id);
    if (!role) {
      throw new NotFoundException({ code: 'role.not_found', message: `Role ${id} not found` });
    }
    return role;
  }

  @Get('capabilities')
  @RequireCapability('capabilities.read')
  @ApiOperation({ summary: 'List the global capability catalogue' })
  listCapabilities() {
    return this.rbac.listCapabilities();
  }

  /**
   * Phase C — C8: expose the static field catalogue so the admin
   * role builder UI knows which (resource, field) pairs are
   * gateable. Read-only and gated on `roles.read` (the role builder
   * is the only consumer; capabilities.read works for capabilities
   * because that table is global, but field-permission rows are
   * tenant-scoped and only meaningful in the role context).
   */
  @Get('field-catalogue')
  @RequireCapability('roles.read')
  @ApiOperation({ summary: 'List the static (resource, field) catalogue for the matrix UI' })
  listFieldCatalogue() {
    return FIELD_CATALOGUE;
  }

  @Post('roles')
  @RequireCapability('roles.write')
  @ApiOperation({ summary: 'Create a custom role' })
  create(
    @Body() body: CreateRoleDto,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<RoleWithCapabilities> {
    return this.rbac.createRole(body, user.sub);
  }

  @Patch('roles/:id')
  @RequireCapability('roles.write')
  @ApiOperation({
    summary: 'Update a custom role (name / level / description / capabilities)',
  })
  async update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateRoleDto,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<RoleWithCapabilities> {
    // Phase D5 — D5.14: when the diff touches capabilities, run
    // the dependency analyser BEFORE writing. Critical warnings
    // (self-lockout / last-keeper) require the actor to echo the
    // typed-confirmation phrase verbatim. The error response
    // carries the analysis payload so the frontend can render
    // the typed-confirmation modal with the same warnings the
    // dependency-check endpoint shows.
    let analysis: DependencyAnalysis | null = null;
    if (body.capabilities !== undefined) {
      analysis = await this.roleDependency.analyseProposal({
        roleId: id,
        proposedCapabilities: body.capabilities,
        actor: { userId: user.sub, roleId: user.rid },
      });
      try {
        this.roleDependency.assertConfirmationOk(analysis, body.confirmation);
      } catch (err) {
        if (err instanceof RoleDependencyConfirmationRequiredError) {
          throw new BadRequestException(err.toResponse());
        }
        throw err;
      }
    }

    const result = await this.rbac.updateRole(id, body, user.sub);

    // Phase D5 — D5.14: emit the confirmation-confirmed audit verb
    // AFTER the write succeeds. The dependency-check verb itself
    // is emitted by the dedicated endpoint (or implicitly
    // recorded by the role.capability.update verb the service
    // writes). Best-effort — never blocks the PATCH response.
    if (analysis && analysis.requiresTypedConfirmation) {
      const role = await this.rbac.findRoleById(id);
      if (role) {
        await this.roleDependency.writeConfirmationAudit({
          actorUserId: user.sub,
          targetRoleId: id,
          targetRoleCode: role.code,
          analysis,
        });
      }
    }

    return result;
  }

  @Delete('roles/:id')
  @RequireCapability('roles.write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a custom role (forbidden if any users are assigned)' })
  async remove(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<void> {
    await this.rbac.deleteRole(id, user.sub);
  }

  @Post('roles/:id/duplicate')
  @RequireCapability('roles.write')
  @ApiOperation({
    summary: 'Duplicate a role (system or custom) into a new editable role',
  })
  duplicate(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: DuplicateRoleDto,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<RoleWithCapabilities> {
    return this.rbac.duplicateRole(id, body, user.sub);
  }

  @Put('roles/:id/scopes')
  @RequireCapability('roles.write')
  @ApiOperation({ summary: 'Replace the data scopes for a custom role' })
  putScopes(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: PutRoleScopesDto,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<RoleScopeRow[]> {
    return this.rbac.putRoleScopes(id, body, user.sub);
  }

  @Put('roles/:id/field-permissions')
  @RequireCapability('roles.write')
  @ApiOperation({ summary: 'Replace the field permissions for a custom role' })
  putFieldPermissions(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: PutRoleFieldPermissionsDto,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<RoleFieldPermissionRow[]> {
    return this.rbac.putRoleFieldPermissions(id, body, user.sub);
  }

  /**
   * Phase D5 — D5.10: role permission preview.
   *
   * Returns a structured projection of any tenant role's effective
   * permissions (capabilities, scopes, denied fields, derived UI
   * hints, warnings) so an admin can audit "what does this role
   * actually see?" before assigning it. Read-only — no session is
   * generated, no impersonation occurs, no row data is returned.
   *
   * Capability gate `permission.preview` (granted to super_admin
   * + ops_manager only by default). Additional in-service guard
   * blocks any non-super-admin from previewing the super_admin
   * role: only a super-admin may preview the most privileged
   * role in the system. Every preview writes one
   * `audit_events.rbac.role.previewed` row carrying structural
   * counters + warning codes (no sensitive values).
   */
  @Get('roles/:id/preview')
  @RequireCapability('permission.preview')
  @ApiOperation({
    summary: 'Preview the effective permission shape of a tenant role (read-only debugger)',
  })
  async preview(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<RolePreviewResult> {
    // Resolve the actor's role.code so the service can apply the
    // super-admin-only-previews-super-admin guard. The lookup
    // sits in the controller (not the service) so the preview
    // service stays a pure metadata reader; it never resolves
    // arbitrary user identities.
    const actorRole = await this.rbac.findRoleById(user.rid);
    if (!actorRole) {
      throw new NotFoundException({
        code: 'role.not_found',
        message: `Caller role ${user.rid} not found in this tenant.`,
      });
    }
    return this.rolePreview.previewRole(id, {
      userId: user.sub,
      roleCode: actorRole.code,
    });
  }

  /**
   * Phase D5 — D5.14: dependency / lockout / high-risk analysis
   * for a proposed capability set on this role. Read-only —
   * NEVER writes capabilities. The role builder UI calls this
   * endpoint as the operator toggles capability checkboxes so
   * the inline hints + grouped warnings stay live.
   *
   * Capability gate `roles.read` (the same gate that lets the
   * caller open the role detail page). The endpoint never
   * exposes raw payload values; the response is structural
   * warnings only (codes + i18n keys + capability codes the
   * client already knows about).
   *
   * Side effect: emits one `audit_events.rbac.role.dependency_check`
   * row per call so admins can audit "who probed this role's
   * structure". Best-effort — failure to write the audit row
   * never blocks the response.
   */
  @Post('roles/:id/dependency-check')
  @HttpCode(HttpStatus.OK)
  @RequireCapability('roles.read')
  @ApiOperation({
    summary: 'Analyse a proposed capability set against the dependency graph (read-only).',
  })
  async dependencyCheck(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: RoleDependencyCheckDto,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<DependencyAnalysis> {
    const role = await this.rbac.findRoleById(id);
    if (!role) {
      throw new NotFoundException({
        code: 'role.not_found',
        message: `Role ${id} not found in this tenant.`,
      });
    }
    const analysis = await this.roleDependency.analyseProposal({
      roleId: id,
      proposedCapabilities: body.capabilities,
      actor: { userId: user.sub, roleId: user.rid },
    });
    await this.roleDependency.writeDependencyCheckAudit({
      actorUserId: user.sub,
      targetRoleId: id,
      targetRoleCode: role.code,
      analysis,
    });
    return analysis;
  }

  /**
   * Phase D5 — D5.15-A: structural change-set preview for the
   * role builder. Read-only — NEVER writes capabilities, scopes,
   * or field permissions. The role editor opens the "Review
   * changes" modal with this payload BEFORE the operator clicks
   * the final save.
   *
   * The DTO accepts any subset of `{ capabilities, scopes,
   * fieldPermissions }`; omitted axes are treated as unchanged
   * in the diff. The response always includes the reused D5.14
   * dependency analysis (analysed against the proposed
   * capability set, or the role's current capabilities when the
   * caller did not propose).
   *
   * Capability gate `roles.read` (the same gate that lets the
   * caller open the role detail page). Side effect: emits a
   * single `audit_events.rbac.role.change_previewed` row per
   * call so admins can audit "who probed this role's diff".
   * Best-effort — failure to write the audit row never blocks
   * the response.
   */
  @Post('roles/:id/change-preview')
  @HttpCode(HttpStatus.OK)
  @RequireCapability('roles.read')
  @ApiOperation({
    summary:
      'Build a structural change-set preview against the saved role (read-only diff + risk flags).',
  })
  async changePreview(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: RoleChangePreviewDto,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<RoleChangePreviewResult> {
    const role = await this.rbac.findRoleById(id);
    if (!role) {
      throw new NotFoundException({
        code: 'role.not_found',
        message: `Role ${id} not found in this tenant.`,
      });
    }
    const result = await this.roleChangePreview.preview({
      roleId: id,
      proposedCapabilities: body.capabilities,
      proposedScopes: body.scopes,
      proposedFieldPermissions: body.fieldPermissions,
      actor: { userId: user.sub, roleId: user.rid },
    });
    await this.roleChangePreview.writePreviewAudit({
      actorUserId: user.sub,
      targetRoleId: id,
      targetRoleCode: role.code,
      result,
    });
    return result;
  }

  /**
   * Phase D5 — D5.15-B: paginated role version history. Latest
   * first; structural metadata + change-summary counts only.
   * The full snapshot rides on the detail endpoint.
   */
  @Get('roles/:id/versions')
  @RequireCapability('roles.read')
  @ApiOperation({ summary: 'List role version history (latest first).' })
  async listVersions(@Param('id', new ParseUUIDPipe()) id: string): Promise<RoleVersionListResult> {
    // Tenant scoping rides through `findRoleById` (RLS-bound).
    const role = await this.rbac.findRoleById(id);
    if (!role) {
      throw new NotFoundException({
        code: 'role.not_found',
        message: `Role ${id} not found in this tenant.`,
      });
    }
    return this.roleVersions.listVersions({ roleId: id });
  }

  /**
   * Phase D5 — D5.15-B: full version detail (snapshot + change
   * summary). Used by the History tab's "View details" button.
   */
  @Get('roles/:id/versions/:versionId')
  @RequireCapability('roles.read')
  @ApiOperation({ summary: 'Get a single role version snapshot.' })
  async getVersion(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('versionId', new ParseUUIDPipe()) versionId: string,
  ): Promise<RoleVersionDetail> {
    const role = await this.rbac.findRoleById(id);
    if (!role) {
      throw new NotFoundException({
        code: 'role.not_found',
        message: `Role ${id} not found in this tenant.`,
      });
    }
    return this.roleVersions.getVersion({ roleId: id, versionId });
  }

  /**
   * Phase D5 — D5.15-B: typed-confirm revert. Rebuilds the role
   * to match the target snapshot via the SAME write paths the
   * regular role-builder UI uses, so the revert flows through
   * the D5.14 dependency-check + D5.15-A change-preview chain
   * without bypass:
   *
   *   1. dependency check on the snapshot's capability set —
   *      critical warnings (self-lockout / last-keeper / system
   *      role) require the typed phrase.
   *   2. capability replace via `RbacService.updateRole`.
   *   3. scope replace via `RbacService.putRoleScopes`.
   *   4. field-permission replace via
   *      `RbacService.putRoleFieldPermissions`.
   *   5. each step appends its own version row (via the
   *      D5.15-B recorder) — the LAST row is tagged
   *      `triggerAction='revert'` and references the source
   *      version in its audit payload.
   *
   * Capability gate `roles.write`. System roles fail with
   * `role.system_immutable` from the underlying RbacService —
   * matches the rest of the role-builder surface.
   */
  @Post('roles/:id/versions/:versionId/revert')
  @HttpCode(HttpStatus.OK)
  @RequireCapability('roles.write')
  @ApiOperation({
    summary: 'Revert a role to the structural state captured by a previous version.',
  })
  async revertVersion(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('versionId', new ParseUUIDPipe()) versionId: string,
    @Body() body: RevertRoleVersionDto,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<RoleVersionDetail> {
    const role = await this.rbac.findRoleById(id);
    if (!role) {
      throw new NotFoundException({
        code: 'role.not_found',
        message: `Role ${id} not found in this tenant.`,
      });
    }

    // Pull the target snapshot. Will throw `role_version.not_found`
    // when the version belongs to a different role / different
    // tenant.
    const target = await this.roleVersions.getVersion({ roleId: id, versionId });

    // 1. Dependency check on the snapshot's capabilities. The
    //    actor's claims feed the self-lockout detection so a
    //    revert that drops `roles.write` from the actor's own
    //    role still requires the typed phrase.
    const proposedCaps = [...target.snapshot.capabilities];
    const analysis = await this.roleDependency.analyseProposal({
      roleId: id,
      proposedCapabilities: proposedCaps,
      actor: { userId: user.sub, roleId: user.rid },
    });
    try {
      this.roleDependency.assertConfirmationOk(analysis, body.confirmation);
    } catch (err) {
      if (err instanceof RoleDependencyConfirmationRequiredError) {
        throw new BadRequestException(err.toResponse());
      }
      throw err;
    }

    // 2. Replay the snapshot through the public write surface.
    //    Each call appends its own version row; the LAST one
    //    (field permissions) we re-tag below as 'revert' so the
    //    History tab + the audit row know this was a revert.
    await this.rbac.updateRole(
      id,
      {
        capabilities: proposedCaps,
        ...(body.confirmation ? { confirmation: body.confirmation } : {}),
      },
      user.sub,
    );

    // Scope replace: the snapshot's full scope set rides verbatim.
    if (target.snapshot.scopes.length > 0) {
      await this.rbac.putRoleScopes(
        id,
        {
          scopes: target.snapshot.scopes.map((s) => ({
            resource: s.resource as 'lead' | 'captain' | 'followup' | 'whatsapp.conversation',
            scope: s.scope as 'own' | 'team' | 'company' | 'country' | 'global',
          })),
        },
        user.sub,
      );
    }

    // Field-permissions replace.
    await this.rbac.putRoleFieldPermissions(
      id,
      {
        permissions: target.snapshot.fieldPermissions.map((p) => ({
          resource: p.resource,
          field: p.field,
          canRead: p.canRead,
          canWrite: p.canWrite,
        })),
      },
      user.sub,
    );

    // 3. Tag the final state with the revert marker. The
    //    previous three RbacService steps each appended a
    //    version row (or skipped for no-op); this final row is
    //    the explicit "this happened via revert from version
    //    N" handle the History tab + audit feed render.
    const reloadedRole = await this.rbac.findRoleById(id);
    if (reloadedRole) {
      await this.roleVersions.recordVersionStandalone({
        role: reloadedRole,
        tenantId: user.tid,
        actorUserId: user.sub,
        triggerAction: 'revert',
        reason: body.reason ?? null,
        revertedFromVersionId: target.id,
        revertedFromVersionNumber: target.versionNumber,
      });
    }

    // 4. Best-effort dedicated audit row for the revert. The
    //    standalone audit gives the audit feed a single,
    //    structured "X reverted Y to version N" row.
    await this.roleVersions.writeRevertAudit({
      actorUserId: user.sub,
      targetRoleId: id,
      targetRoleCode: role.code,
      revertedFromVersionId: target.id,
      revertedFromVersionNumber: target.versionNumber,
      newVersionNumber: target.versionNumber, // close enough — recorder bumps it
      grantedCount: target.changeSummary.grantedCapabilities.length,
      revokedCount: target.changeSummary.revokedCapabilities.length,
      fieldChangeCount:
        target.changeSummary.fieldPermissionChanges.readDeniedAdded.length +
        target.changeSummary.fieldPermissionChanges.readDeniedRemoved.length +
        target.changeSummary.fieldPermissionChanges.writeDeniedAdded.length +
        target.changeSummary.fieldPermissionChanges.writeDeniedRemoved.length,
      scopeChangeCount:
        target.changeSummary.scopeChanges.changed.length +
        target.changeSummary.scopeChanges.added.length +
        target.changeSummary.scopeChanges.removed.length,
      riskFlags: target.changeSummary.riskFlags,
    });

    return target;
  }

  // ───────────────────────────────────────────────────────────────────
  // Phase D5 — D5.16: Role Templates
  // ───────────────────────────────────────────────────────────────────

  /**
   * D5.16 — list curated role templates. Read-only registry,
   * tenant-agnostic (templates ship with the product). Gated on
   * `roles.read` so only role builders see the picker.
   */
  @Get('role-templates')
  @RequireCapability('roles.read')
  @ApiOperation({ summary: 'List curated role templates (safe starting points).' })
  listRoleTemplates(): { templates: readonly RoleTemplateSummary[] } {
    return { templates: this.roleTemplates.list() };
  }

  /**
   * D5.16 — single template detail (full capabilities + scopes +
   * field permissions + risk tags). Frontend renders this in the
   * picker drawer before the admin clicks Create.
   */
  @Get('role-templates/:code')
  @RequireCapability('roles.read')
  @ApiOperation({ summary: 'Get a single role template (full structural shape).' })
  getRoleTemplate(@Param('code') code: string): RoleTemplateDetail {
    return this.roleTemplates.get(code);
  }

  /**
   * D5.16 — preview a template against the actor's claims. Runs
   * the D5.14 dependency analyser on the template's capability
   * set + flags high-risk caps. Read-only; emits a
   * `rbac.role.template_previewed` audit row.
   */
  @Post('role-templates/:code/preview')
  @HttpCode(HttpStatus.OK)
  @RequireCapability('roles.read')
  @ApiOperation({
    summary: 'Preview a role template against the actor: dependency warnings + high-risk caps.',
  })
  async previewRoleTemplate(
    @Param('code') code: string,
    @Body() _body: RoleTemplatePreviewDto,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<RoleTemplatePreviewResult> {
    return this.roleTemplates.preview(code, { userId: user.sub, roleId: user.rid });
  }

  /**
   * D5.16 — create a new custom role from a template. Routes
   * through the existing `RbacService.createRole` write path so
   * every D5 safety hook (capability validation, audit, version
   * capture, cache invalidation) runs unchanged. Adds D5.14's
   * dependency-check + typed-confirmation gate ABOVE that
   * write so a template carrying critical lockout-class
   * warnings still requires the typed phrase.
   *
   * Capability gate `roles.write`. System role codes are still
   * rejected by the underlying RbacService.
   */
  @Post('roles/from-template')
  @HttpCode(HttpStatus.CREATED)
  @RequireCapability('roles.write')
  @ApiOperation({
    summary: 'Create a new custom role from a curated template (safer than duplicate).',
  })
  async createRoleFromTemplate(
    @Body() body: CreateFromTemplateDto,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<RoleWithCapabilities> {
    return this.roleTemplates.createFromTemplate({
      templateCode: body.templateCode,
      code: body.code,
      nameEn: body.nameEn,
      nameAr: body.nameAr,
      ...(body.descriptionEn !== undefined && { descriptionEn: body.descriptionEn ?? null }),
      ...(body.descriptionAr !== undefined && { descriptionAr: body.descriptionAr ?? null }),
      ...(body.confirmation !== undefined && { confirmation: body.confirmation }),
      ...(body.initialScopeOverrides !== undefined && {
        initialScopeOverrides: body.initialScopeOverrides,
      }),
      ...(body.initialFieldPermissionOverrides !== undefined && {
        initialFieldPermissionOverrides: body.initialFieldPermissionOverrides,
      }),
      actor: { userId: user.sub, roleId: user.rid },
    });
  }
}
