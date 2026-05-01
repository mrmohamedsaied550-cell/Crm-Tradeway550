import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';

import { CurrentUser } from '../identity/current-user.decorator';
import { JwtAuthGuard } from '../identity/jwt-auth.guard';
import type { AccessTokenClaims } from '../identity/jwt.types';
import { CapabilityGuard } from '../rbac/capability.guard';
import { RequireCapability } from '../rbac/require-capability.decorator';
import { UpdateTenantSettingsSchema } from './tenant-settings.dto';
import { TenantSettingsService } from './tenant-settings.service';

class UpdateTenantSettingsDto extends createZodDto(UpdateTenantSettingsSchema) {}

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
}
