import {
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
  CreateRoleSchema,
  DuplicateRoleSchema,
  PutRoleFieldPermissionsSchema,
  PutRoleScopesSchema,
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
import { RolePreviewService, type RolePreviewResult } from './role-preview.service';

class CreateRoleDto extends createZodDto(CreateRoleSchema) {}
class UpdateRoleDto extends createZodDto(UpdateRoleSchema) {}
class DuplicateRoleDto extends createZodDto(DuplicateRoleSchema) {}
class PutRoleScopesDto extends createZodDto(PutRoleScopesSchema) {}
class PutRoleFieldPermissionsDto extends createZodDto(PutRoleFieldPermissionsSchema) {}

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
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateRoleDto,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<RoleWithCapabilities> {
    return this.rbac.updateRole(id, body, user.sub);
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
}
