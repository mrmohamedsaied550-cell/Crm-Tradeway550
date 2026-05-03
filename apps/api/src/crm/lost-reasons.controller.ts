import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';

import { JwtAuthGuard } from '../identity/jwt-auth.guard';
import { CapabilityGuard } from '../rbac/capability.guard';
import { RequireCapability } from '../rbac/require-capability.decorator';

import { CreateLostReasonSchema, UpdateLostReasonSchema } from './lost-reasons.dto';
import { LostReasonsService } from './lost-reasons.service';

class CreateLostReasonDto extends createZodDto(CreateLostReasonSchema) {}
class UpdateLostReasonDto extends createZodDto(UpdateLostReasonSchema) {}

/**
 * Phase A — A2: REST surface for the per-tenant lost-reason
 * catalogue.
 *
 * Two access tiers:
 *   • GET  /lost-reasons         → `lead.read` — agent dropdown
 *                                  (active reasons only).
 *   • GET  /admin/lost-reasons   → `tenant.settings.read` — admin
 *                                  list (includes inactive).
 *   • POST/PATCH /admin/lost-reasons → `tenant.settings.write`.
 *
 * The `lead.read`-gated endpoint is what the lost-stage modal
 * loads — every agent who can see a lead can also see the reasons
 * they're allowed to pick from. The admin endpoints sit under
 * /admin so the surface is symmetric with /admin/distribution and
 * /admin/tenant-settings.
 */
@ApiTags('crm')
@Controller()
@UseGuards(JwtAuthGuard, CapabilityGuard)
export class LostReasonsController {
  constructor(private readonly lostReasons: LostReasonsService) {}

  @Get('lost-reasons')
  @RequireCapability('lead.read')
  @ApiOperation({ summary: 'Active lost reasons for the agent picker (ordered)' })
  listActive() {
    return this.lostReasons.listActive();
  }

  @Get('admin/lost-reasons')
  @RequireCapability('tenant.settings.read')
  @ApiOperation({ summary: 'All lost reasons (admin — includes inactive)' })
  listAll() {
    return this.lostReasons.listAll();
  }

  @Post('admin/lost-reasons')
  @RequireCapability('tenant.settings.write')
  @ApiOperation({ summary: 'Create a lost reason' })
  create(@Body() body: CreateLostReasonDto) {
    return this.lostReasons.create(body);
  }

  @Patch('admin/lost-reasons/:id')
  @RequireCapability('tenant.settings.write')
  @ApiOperation({ summary: 'Update label / order / active state' })
  update(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: UpdateLostReasonDto) {
    return this.lostReasons.update(id, body);
  }
}
