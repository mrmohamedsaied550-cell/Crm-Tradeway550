import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
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

import {
  CreateCaptainDocumentSchema,
  ListCaptainDocumentsQuerySchema,
  ReviewCaptainDocumentSchema,
} from './captain-documents.dto';
import { CaptainDocumentsService } from './captain-documents.service';
import { RecordTripSchema } from './captain-trips.dto';
import { CaptainTripsService } from './captain-trips.service';

class CreateDocumentDto extends createZodDto(CreateCaptainDocumentSchema) {}
class ReviewDocumentDto extends createZodDto(ReviewCaptainDocumentSchema) {}
class ListDocumentsQueryDto extends createZodDto(ListCaptainDocumentsQuerySchema) {}
class RecordTripDto extends createZodDto(RecordTripSchema) {}

/**
 * /api/v1/captains/:id/documents (P2-09) and
 * /api/v1/captain-documents/:id/review.
 *
 * Read is gated by `captain.read` (every CRM-touching role can see
 * a captain's paperwork). Upload by `captain.document.write` (the
 * agent who's driving the captain through onboarding). Review by
 * `captain.document.review` (admins + QA). Delete is admin-only via
 * `captain.document.review` (re-using the higher-trust capability).
 *
 * Trip ingest lives at /api/v1/captains/:id/trips and is gated by
 * `captain.trip.write` — only ops_manager / account_manager have it.
 */
@ApiTags('crm')
@Controller()
@UseGuards(JwtAuthGuard, CapabilityGuard)
export class CaptainDocumentsController {
  constructor(
    private readonly documents: CaptainDocumentsService,
    private readonly trips: CaptainTripsService,
  ) {}

  // ─── documents ───

  @Get('captains/:id/documents')
  @RequireCapability('captain.read')
  @ApiOperation({ summary: 'List documents for a captain' })
  list(@Param('id', new ParseUUIDPipe()) id: string, @Query() query: ListDocumentsQueryDto) {
    return this.documents.listForCaptain(id, query);
  }

  @Post('captains/:id/documents')
  @RequireCapability('captain.document.write')
  @ApiOperation({ summary: 'Record a captain document (metadata only — caller hosts the file)' })
  upload(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: CreateDocumentDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    return this.documents.upload(id, body, user.sub);
  }

  @Get('captain-documents/:docId')
  @RequireCapability('captain.read')
  @ApiOperation({ summary: 'Get a single captain document by id' })
  findOne(@Param('docId', new ParseUUIDPipe()) docId: string) {
    return this.documents.findByIdOrThrow(docId);
  }

  @Post('captain-documents/:docId/review')
  @RequireCapability('captain.document.review')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve or reject a captain document' })
  review(
    @Param('docId', new ParseUUIDPipe()) docId: string,
    @Body() body: ReviewDocumentDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    return this.documents.review(docId, body, user.sub);
  }

  @Delete('captain-documents/:docId')
  @RequireCapability('captain.document.review')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a captain document' })
  async remove(
    @Param('docId', new ParseUUIDPipe()) docId: string,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<void> {
    await this.documents.delete(docId, user.sub);
  }

  // ─── trips ───

  @Get('captains/:id/trips')
  @RequireCapability('captain.read')
  @ApiOperation({ summary: 'List recorded trips for a captain (latest 100)' })
  listTrips(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.trips.listForCaptain(id);
  }

  @Post('captains/:id/trips')
  @RequireCapability('captain.trip.write')
  @ApiOperation({
    summary: 'Record a captain trip — idempotent on (captainId, tripId)',
    description:
      'First trip per captain sets `firstTripAt` and fires `BonusEngine.onFirstTrip`. ' +
      'Subsequent trips bump `tripCount` only.',
  })
  recordTrip(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: RecordTripDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    return this.trips.recordTrip(id, body, user.sub);
  }
}
