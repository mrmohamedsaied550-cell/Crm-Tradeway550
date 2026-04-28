import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../identity/jwt-auth.guard';
import { RbacService, type RoleSummary } from './rbac.service';

/**
 * /api/v1/rbac — read-only RBAC introspection (C14).
 *
 * Today: a single `GET /rbac/roles` endpoint that powers the admin UI's
 * role picker. The full capability mapping (and any write surface) stays
 * inside the registry until a future capability-management chunk needs it.
 *
 * Tenant scope flows from the JWT's `tid` claim via the existing
 * tenant-context middleware; the underlying service uses `withTenant()`
 * so RLS catches any cross-tenant leak as a side-effect.
 */
@ApiTags('rbac')
@Controller('rbac')
@UseGuards(JwtAuthGuard)
export class RbacController {
  constructor(private readonly rbac: RbacService) {}

  @Get('roles')
  @ApiOperation({
    summary: 'List active roles in the active tenant (id, code, names, capability count)',
  })
  listRoles(): Promise<RoleSummary[]> {
    return this.rbac.listRoleSummaries();
  }
}
