import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';

import { JwtAuthGuard } from '../identity/jwt-auth.guard';
import { CaptainsService } from './captains.service';
import { ListCaptainsQuerySchema } from './leads.dto';

class ListCaptainsQueryDto extends createZodDto(ListCaptainsQuerySchema) {}

/**
 * /api/v1/captains — read-only captain admin surface (C18).
 *
 * Captains are created exclusively via `POST /leads/:id/convert`, so this
 * controller only exposes read endpoints. Tenant scope flows from the
 * JWT's `tid` claim through the standard tenant-context middleware; the
 * service uses `withTenant(...)` so RLS catches any cross-tenant attempt.
 */
@ApiTags('crm')
@Controller('captains')
@UseGuards(JwtAuthGuard)
export class CaptainsController {
  constructor(private readonly captains: CaptainsService) {}

  @Get()
  @ApiOperation({ summary: 'List captains in the active tenant (filterable + paginated)' })
  list(@Query() query: ListCaptainsQueryDto) {
    return this.captains.list(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a captain by id' })
  getOne(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.captains.findByIdOrThrow(id);
  }
}
