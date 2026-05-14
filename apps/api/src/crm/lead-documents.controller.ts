import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';

import { CurrentUser } from '../identity/current-user.decorator';
import { JwtAuthGuard } from '../identity/jwt-auth.guard';
import type { AccessTokenClaims } from '../identity/jwt.types';
import { CapabilityGuard } from '../rbac/capability.guard';
import { RequireCapability } from '../rbac/require-capability.decorator';
import type { ScopeUserClaims } from '../rbac/scope-context.service';

/**
 * CapabilityGuard caches the user's resolved capability list on the
 * request as `user.capabilities`. The route-level `@RequireCapability`
 * decorator already guarantees the calling user has `lead.document.write`
 * before this controller runs, so the cache is populated by the time
 * we get here. Use the cache to check accept / reject grants without
 * a second DB round-trip.
 */
function userHasCapability(
  user: AccessTokenClaims & { capabilities?: readonly string[] },
  capability: string,
): boolean {
  return user.capabilities?.includes(capability) ?? false;
}

import {
  CreateLeadDocumentSchema,
  ListLeadDocumentsQuerySchema,
  UpdateLeadDocumentSchema,
} from './lead-documents.dto';
import { LeadDocumentsService } from './lead-documents.service';

class CreateLeadDocumentBody extends createZodDto(CreateLeadDocumentSchema) {}
class UpdateLeadDocumentBody extends createZodDto(UpdateLeadDocumentSchema) {}
class ListLeadDocumentsQuery extends createZodDto(ListLeadDocumentsQuerySchema) {}

/**
 * /api/v1/leads/:leadId/documents — Sprint 12 (D12).
 *
 * Three routes; one read + two writes:
 *
 *   GET    /  — list documents for a lead. Requires
 *               `lead.document.read`. Lead scope gates visibility.
 *   POST   /  — create a metadata row (status `missing` /
 *               `uploaded`). Requires `lead.document.write`.
 *   PATCH /:documentId — update metadata + optional status flip.
 *               Status `accepted` requires `lead.document.accept`;
 *               status `rejected` or `needs_resubmission` requires
 *               `lead.document.reject` + a non-empty
 *               `rejectionReason`. Service enforces the gates so
 *               error codes are clean for the UI.
 */
@ApiTags('lead-documents')
@Controller('leads/:leadId/documents')
@UseGuards(JwtAuthGuard, CapabilityGuard)
export class LeadDocumentsController {
  constructor(private readonly documents: LeadDocumentsService) {}

  private claimsToScope(claims: AccessTokenClaims): ScopeUserClaims {
    return { userId: claims.sub, tenantId: claims.tid, roleId: claims.rid };
  }

  @Get()
  @RequireCapability('lead.document.read')
  @ApiOperation({
    summary: 'List document metadata rows for a lead. Lead scope + tenant-isolated.',
  })
  list(
    @Param('leadId', new ParseUUIDPipe()) leadId: string,
    @Query() query: ListLeadDocumentsQuery,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    return this.documents.listForLead(leadId, this.claimsToScope(user), query);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequireCapability('lead.document.write')
  @ApiOperation({
    summary:
      'Create a new lead document metadata row. Status defaults to `uploaded`; pass `missing` to track a known-missing requirement.',
  })
  create(
    @Param('leadId', new ParseUUIDPipe()) leadId: string,
    @Body() body: CreateLeadDocumentBody,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    return this.documents.create(leadId, body, this.claimsToScope(user));
  }

  @Patch(':documentId')
  @RequireCapability('lead.document.write')
  @ApiOperation({
    summary:
      'Update metadata and/or status. Accept requires lead.document.accept; reject / needs_resubmission requires lead.document.reject + reason.',
  })
  update(
    @Param('leadId', new ParseUUIDPipe()) leadId: string,
    @Param('documentId', new ParseUUIDPipe()) documentId: string,
    @Body() body: UpdateLeadDocumentBody,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    // The controller carries the user's grant flags into the
    // service so the service can throw a clean error code (the
    // service can't call CapabilityGuard directly inside a tx).
    const canAccept = userHasCapability(user, 'lead.document.accept');
    const canReject = userHasCapability(user, 'lead.document.reject');
    return this.documents.update(leadId, documentId, body, this.claimsToScope(user), {
      canAccept,
      canReject,
    });
  }
}
