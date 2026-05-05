import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';

import { EscalationRulesSchema } from '../crm/escalation-rules.dto';
import { DuplicateRulesSchema } from '../duplicates/duplicate-rules.dto';
import { CurrentUser } from '../identity/current-user.decorator';
import { JwtAuthGuard } from '../identity/jwt-auth.guard';
import type { AccessTokenClaims } from '../identity/jwt.types';
import { CapabilityGuard } from '../rbac/capability.guard';
import { RequireCapability } from '../rbac/require-capability.decorator';
import { UpdateTenantSettingsSchema } from './tenant-settings.dto';
import { TenantSettingsService } from './tenant-settings.service';

class UpdateTenantSettingsDto extends createZodDto(UpdateTenantSettingsSchema) {}
class UpdateDuplicateRulesDto extends createZodDto(DuplicateRulesSchema) {}
class UpdateEscalationRulesDto extends createZodDto(EscalationRulesSchema) {}

/**
 * /api/v1/tenant/settings (P2-08)
 *
 * GET   — visible to anyone with `tenant.settings.read` (every CRM
 *         role; the active tenant's SLA / timezone / dial-code show
 *         up in admin "header" surfaces).
 * PATCH — `tenant.settings.write` (ops_manager / account_manager).
 */
@ApiTags('tenants')
@Controller('tenant/settings')
@UseGuards(JwtAuthGuard, CapabilityGuard)
export class TenantSettingsController {
  constructor(private readonly settings: TenantSettingsService) {}

  @Get()
  @RequireCapability('tenant.settings.read')
  @ApiOperation({ summary: 'Read settings for the active tenant' })
  get() {
    return this.settings.getCurrent();
  }

  @Patch()
  @RequireCapability('tenant.settings.write')
  @ApiOperation({ summary: 'Update settings for the active tenant' })
  update(@Body() body: UpdateTenantSettingsDto, @CurrentUser() user: AccessTokenClaims) {
    return this.settings.update(body, user.sub);
  }

  /**
   * Phase D2 — D2.4: per-tenant duplicate / reactivation rules.
   *
   * Reads piggy-back on `tenant.settings.read` so any role that can
   * already see the SLA / dial code can also see the duplicate
   * policy (TLs may want to confirm rules without being able to
   * change them — read-only mode in the admin panel).
   *
   * Writes are gated separately on `tenant.duplicate_rules.write`
   * (D2.2 capability) so an Account Manager cannot accidentally
   * (or maliciously) flip cool-off cohorts via the broader
   * `tenant.settings.write` route.
   */
  @Get('duplicate-rules')
  @RequireCapability('tenant.settings.read')
  @ApiOperation({ summary: 'Read the duplicate / reactivation rules for the active tenant' })
  getDuplicateRules() {
    return this.settings.getDuplicateRules();
  }

  @Patch('duplicate-rules')
  @RequireCapability('tenant.duplicate_rules.write')
  @ApiOperation({ summary: 'Update the duplicate / reactivation rules for the active tenant' })
  updateDuplicateRules(
    @Body() body: UpdateDuplicateRulesDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    return this.settings.updateDuplicateRules(body, user.sub);
  }

  /**
   * Phase D3 — D3.7: per-tenant SLA escalation rules.
   *
   * Reads piggy-back on `tenant.settings.read` (TLs that already see
   * SLA / dial-code can also see the policy in read-only mode).
   * Writes go through `tenant.settings.write` — no dedicated
   * capability today; we reuse the existing tenant-write gate to
   * keep the role grants simple. The locked role matrix already
   * maps Ops Manager / Account Manager to that capability.
   */
  @Get('escalation-rules')
  @RequireCapability('tenant.settings.read')
  @ApiOperation({ summary: 'Read the SLA escalation rules for the active tenant' })
  getEscalationRules() {
    return this.settings.getEscalationRules();
  }

  @Patch('escalation-rules')
  @RequireCapability('tenant.settings.write')
  @ApiOperation({ summary: 'Update the SLA escalation rules for the active tenant' })
  updateEscalationRules(
    @Body() body: UpdateEscalationRulesDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    return this.settings.updateEscalationRules(body, user.sub);
  }
}
