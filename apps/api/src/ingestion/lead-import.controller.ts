import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';

import { CurrentUser } from '../identity/current-user.decorator';
import { JwtAuthGuard } from '../identity/jwt-auth.guard';
import type { AccessTokenClaims } from '../identity/jwt.types';
import { CapabilityGuard } from '../rbac/capability.guard';
import { RequireCapability } from '../rbac/require-capability.decorator';

import { CsvImportSchema } from './ingestion.dto';
import { LeadIngestionService } from './lead-ingestion.service';

class CsvImportDto extends createZodDto(CsvImportSchema) {}

/**
 * /api/v1/leads/import (P2-06) — admin CSV upload.
 *
 * The body is JSON: `{ csv, mapping, defaultSource, autoAssign }`. The
 * caller serialises the file as a string before posting; we keep the
 * route multipart-free so the existing JSON-only middleware stack
 * stays uniform.
 */
@ApiTags('crm')
@Controller('leads')
@UseGuards(JwtAuthGuard, CapabilityGuard)
export class LeadImportController {
  constructor(private readonly ingestion: LeadIngestionService) {}

  @Post('import')
  @RequireCapability('lead.import')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Bulk-import leads from a CSV string' })
  importCsv(@Body() body: CsvImportDto, @CurrentUser() user: AccessTokenClaims) {
    return this.ingestion.importCsv(body, user.sub);
  }
}
