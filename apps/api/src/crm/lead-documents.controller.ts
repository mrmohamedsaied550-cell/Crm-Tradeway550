import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';

/**
 * Sprint 16 (D16) — local shape for multer's uploaded-file payload.
 * Sidesteps the `Express.Multer.File` global namespace which is only
 * registered when `@types/multer` is forced into the project's
 * `types` field. Keeps the controller self-contained.
 */
interface UploadedDocumentFile {
  buffer: Buffer;
  mimetype: string;
  originalname?: string;
  size: number;
}

import { ALLOWED_DOCUMENT_MIMES, readUploadLimit } from '../storage/storage.service';

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

  /**
   * Sprint 16 (D16) — accept a multipart upload, persist to private
   * storage, update the document row.
   *
   * Multer enforces `fileSize` and `files = 1` as the first guard;
   * the service rechecks size + MIME so a custom upload path can't
   * bypass the interceptor. The `fileFilter` rejects unsupported
   * MIMEs at parse time so we don't allocate a large buffer for a
   * file we'd reject anyway.
   */
  @Post(':documentId/upload')
  @HttpCode(HttpStatus.OK)
  @RequireCapability('lead.document.write')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: readUploadLimit(), files: 1 },
      fileFilter: (_req, file, cb) => {
        if (!ALLOWED_DOCUMENT_MIMES.has(file.mimetype)) {
          cb(
            new BadRequestException({
              code: 'lead.document.unsupported_type',
              message: `MIME type ${file.mimetype} is not allowed.`,
            }),
            false,
          );
          return;
        }
        cb(null, true);
      },
    }),
  )
  @ApiOperation({ summary: 'Upload (or replace) the file backing this document' })
  async upload(
    @Param('leadId', new ParseUUIDPipe()) leadId: string,
    @Param('documentId', new ParseUUIDPipe()) documentId: string,
    @UploadedFile() file: UploadedDocumentFile | undefined,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    if (!file) {
      throw new BadRequestException({
        code: 'lead.document.missing_file',
        message: 'No file part named "file" in the multipart payload.',
      });
    }
    return this.documents.uploadFile(
      leadId,
      documentId,
      {
        buffer: file.buffer,
        mimeType: file.mimetype,
        originalName: file.originalname ?? null,
      },
      this.claimsToScope(user),
    );
  }

  /**
   * Sprint 16 (D16) — stream the document's stored file back to the
   * browser. Capability gate is `lead.document.read`; lead-scope is
   * re-checked in the service. Image / PDF MIMEs render inline so
   * the UI can show a preview; other allowed MIMEs would render
   * inline too but the allow-list is image+pdf only.
   *
   * Returns 404 when the row exists but no file has been uploaded
   * (storage key NULL) so the client can distinguish "row missing"
   * from "row has no file yet" via the error code.
   */
  @Get(':documentId/file')
  @RequireCapability('lead.document.read')
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({ summary: "Stream the document's stored file" })
  async download(
    @Param('leadId', new ParseUUIDPipe()) leadId: string,
    @Param('documentId', new ParseUUIDPipe()) documentId: string,
    @CurrentUser() user: AccessTokenClaims,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { stream, fileName, mimeType, sizeBytes } = await this.documents.openFileForDownload(
      leadId,
      documentId,
      this.claimsToScope(user),
    );
    // Inline-display the curated allow-list (jpeg/png/webp/pdf); the
    // browser sandbox handles these safely. Anything else (which the
    // upload allow-list would already have rejected) defaults to
    // attachment for a download prompt.
    const disposition =
      mimeType.startsWith('image/') || mimeType === 'application/pdf' ? 'inline' : 'attachment';
    // Escape the filename per RFC 6266 so a quote / non-ASCII char
    // doesn't break the header. Browsers prefer `filename*` for
    // UTF-8 payloads.
    const asciiFallback = fileName.replace(/[^\x20-\x7e]/gu, '_').replace(/["\\]/gu, '_');
    const encoded = encodeURIComponent(fileName);
    res.setHeader(
      'Content-Disposition',
      `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`,
    );
    res.setHeader('Content-Type', mimeType);
    if (sizeBytes > 0) {
      res.setHeader('Content-Length', String(sizeBytes));
    }
    return new StreamableFile(stream);
  }
}
