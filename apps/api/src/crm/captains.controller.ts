import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';

import { JwtAuthGuard } from '../identity/jwt-auth.guard';
import { CapabilityGuard } from '../rbac/capability.guard';
import { RequireCapability } from '../rbac/require-capability.decorator';
import { ResourceFieldGate } from '../rbac/resource-field-gate.decorator';
import { CaptainsService } from './captains.service';
import { ListCaptainsQuerySchema } from './leads.dto';

class ListCaptainsQueryDto extends createZodDto(ListCaptainsQuerySchema) {}

@ApiTags('crm')
@Controller('captains')
@UseGuards(JwtAuthGuard, CapabilityGuard)
export class CaptainsController {
  constructor(private readonly captains: CaptainsService) {}

  @Get()
  @RequireCapability('captain.read')
  @ResourceFieldGate('captain')
  @ApiOperation({ summary: 'List captains in the active tenant (filterable + paginated)' })
  list(@Query() query: ListCaptainsQueryDto) {
    return this.captains.list(query);
  }

  @Get(':id')
  @RequireCapability('captain.read')
  @ResourceFieldGate('captain')
  @ApiOperation({ summary: 'Get a captain by id' })
  getOne(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.captains.findByIdOrThrow(id);
  }
}
