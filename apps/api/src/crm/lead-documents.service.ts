import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import type { Readable } from 'node:stream';

import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import type { ScopeUserClaims } from '../rbac/scope-context.service';
import {
  ALLOWED_DOCUMENT_MIMES,
  readUploadLimit,
  sanitizeFileName,
  StorageService,
} from '../storage/storage.service';
import { requireTenantId } from '../tenants/tenant-context';

import { LeadsService } from './leads.service';
import {
  LEAD_DOCUMENT_NEGATIVE_STATUSES,
  type CreateLeadDocumentDto,
  type LeadDocumentStatus,
  type ListLeadDocumentsQueryDto,
  type UpdateLeadDocumentDto,
} from './lead-documents.dto';

/**
 * Sprint 12 (D12) — Lead Documents service.
 *
 * Metadata-only on Sprint 12. The operator records that a document
 * exists (file name + mime + size from a WhatsApp / email
 * receipt) and reviews it through accept / reject / needs_resubmission.
 * A future sprint adds the binary storage backend.
 *
 * Permission model:
 *   - The controller gates each route with the appropriate
 *     `lead.document.*` capability. The service additionally
 *     enforces lead scope via `LeadsService.findByIdInScopeOrThrow`
 *     so a user with `lead.document.write` but no `lead.read` for
 *     this lead never reaches the row.
 *   - Status flips to `accepted` require `lead.document.accept` —
 *     enforced at the controller. Flips to `rejected` /
 *     `needs_resubmission` require `lead.document.reject`.
 *
 * Audit:
 *   - Every write emits an `audit_event` (lead.document.created /
 *     updated / accepted / rejected / needs_resubmission) inside
 *     the same transaction as the document write, and a
 *     `lead_activity` row (type='system') so the Lead Detail
 *     timeline picks the event up without an extra fetch.
 *
 * Notifications:
 *   - On reject + needs_resubmission, ship a generic notification
 *     to the lead's assignee. The body is intentionally
 *     content-free ("A document was rejected. Open the lead for
 *     details.") so we don't leak file content via the notification.
 */
@Injectable()
export class LeadDocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly leads: LeadsService,
    private readonly audit: AuditService,
    /**
     * Sprint 16 (D16) — private storage. Optional in the constructor
     * so legacy test fixtures (Sprint 12) keep compiling without
     * wiring a temp storage root; production module always provides
     * the global StorageService.
     */
    @Optional() private readonly storage?: StorageService,
    @Optional() private readonly notifications?: NotificationsService,
  ) {}

  // ─────────────────── reads ───────────────────

  async listForLead(leadId: string, userClaims: ScopeUserClaims, opts: ListLeadDocumentsQueryDto) {
    const tenantId = requireTenantId();
    // Lead scope gate — throws 404 with `lead.not_found` if the
    // caller can't see this lead, identical contract to every
    // other lead-scoped read.
    await this.leads.findByIdInScopeOrThrow(leadId, userClaims);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.leadDocument.findMany({
        where: {
          leadId,
          ...(opts.status && { status: opts.status }),
          ...(opts.type && { type: opts.type }),
        },
        orderBy: [{ createdAt: 'desc' }],
        include: {
          uploadedBy: { select: { id: true, name: true, email: true } },
          reviewedBy: { select: { id: true, name: true, email: true } },
        },
      });
      return rows;
    });
  }

  // ─────────────────── writes ───────────────────

  async create(
    leadId: string,
    dto: CreateLeadDocumentDto,
    userClaims: ScopeUserClaims,
  ): Promise<{ id: string }> {
    const tenantId = requireTenantId();
    const lead = await this.leads.findByIdInScopeOrThrow(leadId, userClaims);
    const status: LeadDocumentStatus = dto.status ?? 'uploaded';

    // The negative statuses cannot be set at creation — they imply
    // a reviewer + reason that the create payload doesn't carry.
    if (status === 'accepted' || status === 'rejected' || status === 'needs_resubmission') {
      throw new BadRequestException({
        code: 'lead.document.status.invalid_on_create',
        message:
          'Create with status "missing" or "uploaded" only; reviewer status must be set via PATCH.',
      });
    }

    return this.prisma.withTenant(tenantId, async (tx) => {
      const row = await tx.leadDocument.create({
        data: {
          tenantId,
          leadId,
          type: dto.type,
          label: dto.label ?? null,
          status,
          fileName: dto.fileName ?? null,
          fileUrl: dto.fileUrl ?? null,
          mimeType: dto.mimeType ?? null,
          sizeBytes: dto.sizeBytes ?? null,
          note: dto.note ?? null,
          uploadedById: userClaims.userId,
        },
        select: { id: true },
      });

      // Audit + lead activity in the same tx.
      await this.audit.writeInTx(tx, tenantId, {
        action: 'lead.document.created',
        entityType: 'lead_document',
        entityId: row.id,
        actorUserId: userClaims.userId,
        payload: {
          leadId,
          documentId: row.id,
          type: dto.type,
          status,
        } as Prisma.InputJsonValue,
      });
      await tx.leadActivity.create({
        data: {
          tenantId,
          leadId,
          type: 'system',
          body: `Document ${dto.type} recorded (${status}).`,
          createdById: userClaims.userId,
          payload: {
            kind: 'document',
            documentId: row.id,
            documentType: dto.type,
            status,
          } as Prisma.InputJsonValue,
        },
      });

      // Note: we read `lead` only to enforce scope; the audit
      // payload above already names the lead id. Nothing else
      // depends on the lead row right now, but keeping the
      // reference here prevents a future refactor from dropping
      // the scope check by accident.
      void lead;
      return row;
    });
  }

  async update(
    leadId: string,
    documentId: string,
    dto: UpdateLeadDocumentDto,
    userClaims: ScopeUserClaims,
    grants: { canAccept: boolean; canReject: boolean },
  ): Promise<{ id: string }> {
    const tenantId = requireTenantId();
    await this.leads.findByIdInScopeOrThrow(leadId, userClaims);

    return this.prisma.withTenant(tenantId, async (tx) => {
      const existing = await tx.leadDocument.findFirst({
        where: { id: documentId, leadId },
        select: {
          id: true,
          status: true,
          rejectionReason: true,
          type: true,
        },
      });
      if (!existing) {
        throw new NotFoundException({
          code: 'lead.document.not_found',
          message: `Lead document ${documentId} not found for lead ${leadId}`,
        });
      }

      const newStatus: LeadDocumentStatus | undefined = dto.status ?? undefined;
      const isNegative =
        newStatus !== undefined &&
        (LEAD_DOCUMENT_NEGATIVE_STATUSES as readonly string[]).includes(newStatus);
      const isAccept = newStatus === 'accepted';

      // Capability gates above the DB CHECK so error codes are
      // clean for the UI to branch on.
      if (isAccept && !grants.canAccept) {
        throw new ForbiddenException({
          code: 'lead.document.accept.forbidden',
          message: 'You need `lead.document.accept` to accept a document.',
        });
      }
      if (isNegative && !grants.canReject) {
        throw new ForbiddenException({
          code: 'lead.document.reject.forbidden',
          message:
            'You need `lead.document.reject` to reject a document or mark it needs_resubmission.',
        });
      }
      if (isNegative) {
        const reason = (dto.rejectionReason ?? '').trim();
        if (reason.length === 0) {
          throw new BadRequestException({
            code: 'lead.document.reason_required',
            message: 'Reject / needs_resubmission requires a non-empty rejection reason.',
          });
        }
      }

      // Build the data patch.
      const data: Prisma.LeadDocumentUpdateInput = {};
      if (dto.label !== undefined) data.label = dto.label;
      if (dto.fileName !== undefined) data.fileName = dto.fileName;
      if (dto.fileUrl !== undefined) data.fileUrl = dto.fileUrl;
      if (dto.mimeType !== undefined) data.mimeType = dto.mimeType;
      if (dto.sizeBytes !== undefined) data.sizeBytes = dto.sizeBytes;
      if (dto.note !== undefined) data.note = dto.note;
      if (newStatus !== undefined) {
        data.status = newStatus;
        if (isAccept) {
          data.reviewedBy = { connect: { id: userClaims.userId } };
          data.reviewedAt = new Date();
          // Clearing any stale rejection text when an accept lands.
          data.rejectionReason = null;
        } else if (isNegative) {
          data.reviewedBy = { connect: { id: userClaims.userId } };
          data.reviewedAt = new Date();
          data.rejectionReason = dto.rejectionReason!.trim();
        }
      } else if (dto.rejectionReason !== undefined) {
        // Caller only updated the reason text on an already-
        // rejected row — allow it as a write action.
        data.rejectionReason = dto.rejectionReason;
      }

      await tx.leadDocument.update({ where: { id: documentId }, data });

      // Audit + activity. The action code distinguishes accept /
      // reject / needs_resubmission so audit listeners can chip-
      // filter without parsing the payload.
      const auditAction = isAccept
        ? 'lead.document.accepted'
        : newStatus === 'rejected'
          ? 'lead.document.rejected'
          : newStatus === 'needs_resubmission'
            ? 'lead.document.needs_resubmission'
            : 'lead.document.updated';
      await this.audit.writeInTx(tx, tenantId, {
        action: auditAction,
        entityType: 'lead_document',
        entityId: documentId,
        actorUserId: userClaims.userId,
        payload: {
          leadId,
          documentId,
          type: existing.type,
          from: existing.status,
          to: newStatus ?? existing.status,
        } as Prisma.InputJsonValue,
      });
      await tx.leadActivity.create({
        data: {
          tenantId,
          leadId,
          type: 'system',
          body: this.activityBody(
            existing.type,
            (newStatus ?? existing.status) as LeadDocumentStatus,
            isAccept,
            isNegative,
          ),
          createdById: userClaims.userId,
          payload: {
            kind: 'document',
            documentId,
            documentType: existing.type,
            from: existing.status,
            to: newStatus ?? existing.status,
          } as Prisma.InputJsonValue,
        },
      });

      // Best-effort notification on negative review → the lead's
      // assignee. Failures swallow (presence/notification outage
      // must not break document review). We pull the assignee in
      // a follow-up read instead of carrying it through the call
      // chain so the existing scope query stays cheap.
      if ((isNegative || isAccept) && this.notifications) {
        const leadRow = await tx.lead.findUnique({
          where: { id: leadId },
          select: { assignedToId: true },
        });
        if (leadRow?.assignedToId && leadRow.assignedToId !== userClaims.userId) {
          await this.notifications
            .createInTx(tx, tenantId, {
              recipientUserId: leadRow.assignedToId,
              kind: auditAction,
              title: isAccept
                ? 'Document accepted'
                : newStatus === 'rejected'
                  ? 'Document rejected'
                  : 'Document needs resubmission',
              body: 'Open the lead for the document details.',
              severity: isAccept ? 'success' : 'warning',
              actionUrl: `/admin/leads/${leadId}`,
              payload: {
                leadId,
                documentId,
                type: existing.type,
              } as Prisma.InputJsonValue,
            })
            .catch(() => {
              /* swallow */
            });
        }
      }

      return { id: documentId };
    });
  }

  // ─────────────────── Sprint 16 (D16) — binary upload / download ───────────────────

  /**
   * Accept the uploaded bytes and persist them under the active
   * StorageService. The caller (controller) has already verified
   * `lead.document.write` and resolved the multipart file. This
   * method:
   *
   *   1. re-checks lead scope so a user with the capability but no
   *      lead visibility cannot upload,
   *   2. resolves the existing document row (404 on cross-tenant),
   *   3. enforces the server-side MIME allow-list + size cap a
   *      second time (multer's checks are first-line; this is
   *      defence-in-depth),
   *   4. writes the bytes to the storage provider,
   *   5. updates the row with storage refs + metadata + status,
   *   6. emits an audit row + a LeadActivity row in the same tx,
   *   7. returns the safe row projection used by the read paths.
   *
   * Replacement semantics: if the document already has a `storageKey`
   * the new file replaces the metadata; the old key is left in
   * storage. A future sprint can add a tombstone sweeper — for now
   * the audit row records the replaced hash so ops can reconcile.
   */
  async uploadFile(
    leadId: string,
    documentId: string,
    file: { buffer: Buffer; mimeType: string; originalName: string | null },
    userClaims: ScopeUserClaims,
  ): Promise<{ id: string }> {
    if (!this.storage) {
      throw new BadRequestException({
        code: 'lead.document.storage_unavailable',
        message: 'Document storage is not configured on this deploy.',
      });
    }
    const tenantId = requireTenantId();
    await this.leads.findByIdInScopeOrThrow(leadId, userClaims);

    // MIME allow-list + size cap. Multer's `limits.fileSize` is the
    // first guard; rechecking here covers the case where a custom
    // upload path bypasses the interceptor's limit.
    if (!ALLOWED_DOCUMENT_MIMES.has(file.mimeType)) {
      throw new BadRequestException({
        code: 'lead.document.unsupported_type',
        message: `MIME type ${file.mimeType} is not allowed.`,
      });
    }
    const limit = readUploadLimit();
    if (file.buffer.byteLength > limit) {
      throw new BadRequestException({
        code: 'lead.document.too_large',
        message: `File exceeds the ${limit}-byte limit.`,
      });
    }
    if (file.buffer.byteLength === 0) {
      throw new BadRequestException({
        code: 'lead.document.empty',
        message: 'Uploaded file is empty.',
      });
    }

    // Resolve the row first (under the tenant context) so we can
    // 404 cleanly before touching the disk. The row + scope gate
    // above guarantee tenant isolation.
    const existing = await this.prisma.withTenant(tenantId, (tx) =>
      tx.leadDocument.findFirst({
        where: { id: documentId, leadId },
        select: { id: true, type: true, storageKey: true, fileHash: true },
      }),
    );
    if (!existing) {
      throw new NotFoundException({
        code: 'lead.document.not_found',
        message: 'Document not found for this lead.',
      });
    }
    const previousKey = existing.storageKey;
    const previousHash = existing.fileHash;

    // Persist bytes BEFORE the row update so a transient FS failure
    // doesn't leave the DB pointing at a missing key. The storage
    // key encodes (tenantId, leadId, documentId) so a same-tenant
    // collision is impossible.
    const stored = await this.storage.save(
      { tenantId, leadId, documentId },
      file.buffer,
      file.mimeType,
    );

    const safeFileName = sanitizeFileName(file.originalName);

    return this.prisma.withTenant(tenantId, async (tx) => {
      const updated = await tx.leadDocument.update({
        where: { id: documentId },
        data: {
          status: 'uploaded',
          fileName: safeFileName,
          mimeType: file.mimeType,
          sizeBytes: stored.sizeBytes,
          storageKey: stored.key,
          storageProvider: stored.provider,
          fileHash: stored.fileHash,
          uploadedById: userClaims.userId,
        },
        select: { id: true },
      });

      const isReplacement = previousKey !== null;
      await this.audit.writeInTx(tx, tenantId, {
        action: isReplacement ? 'lead.document.file_replaced' : 'lead.document.file_uploaded',
        entityType: 'lead_document',
        entityId: documentId,
        actorUserId: userClaims.userId,
        payload: {
          leadId,
          documentId,
          type: existing.type,
          fileName: safeFileName,
          mimeType: file.mimeType,
          sizeBytes: stored.sizeBytes,
          fileHash: stored.fileHash,
          provider: stored.provider,
          ...(isReplacement && { previousFileHash: previousHash }),
        } as Prisma.InputJsonValue,
      });
      await tx.leadActivity.create({
        data: {
          tenantId,
          leadId,
          type: 'system',
          body: isReplacement
            ? `Document ${existing.type} file replaced (${safeFileName}).`
            : `Document ${existing.type} file uploaded (${safeFileName}).`,
          createdById: userClaims.userId,
          payload: {
            kind: 'document',
            documentId,
            documentType: existing.type,
            event: isReplacement ? 'file_replaced' : 'file_uploaded',
            fileName: safeFileName,
            mimeType: file.mimeType,
            sizeBytes: stored.sizeBytes,
          } as Prisma.InputJsonValue,
        },
      });
      return updated;
    });
  }

  /**
   * Resolve the row + open a read stream for the controller to pipe
   * into the HTTP response. Returns the file metadata alongside the
   * stream so the controller can set Content-Type / Content-Length /
   * Content-Disposition.
   *
   * Throws NotFoundException when:
   *   - the lead is out of the caller's scope, OR
   *   - the document row doesn't exist in the tenant, OR
   *   - the row exists but has never been uploaded (no storageKey).
   *
   * The caller must already hold `lead.document.read`.
   */
  async openFileForDownload(
    leadId: string,
    documentId: string,
    userClaims: ScopeUserClaims,
  ): Promise<{
    stream: Readable;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
  }> {
    if (!this.storage) {
      throw new NotFoundException({
        code: 'lead.document.storage_unavailable',
        message: 'Document storage is not configured on this deploy.',
      });
    }
    const tenantId = requireTenantId();
    await this.leads.findByIdInScopeOrThrow(leadId, userClaims);

    const row = await this.prisma.withTenant(tenantId, (tx) =>
      tx.leadDocument.findFirst({
        where: { id: documentId, leadId },
        select: {
          storageKey: true,
          storageProvider: true,
          fileName: true,
          mimeType: true,
          sizeBytes: true,
        },
      }),
    );
    if (!row) {
      throw new NotFoundException({
        code: 'lead.document.not_found',
        message: 'Document not found for this lead.',
      });
    }
    if (!row.storageKey) {
      throw new NotFoundException({
        code: 'lead.document.file_missing',
        message: 'No file has been uploaded for this document yet.',
      });
    }

    const stream = await this.storage.openStream(row.storageKey);
    return {
      stream,
      fileName: row.fileName ?? 'document',
      mimeType: row.mimeType ?? 'application/octet-stream',
      sizeBytes: row.sizeBytes ?? 0,
    };
  }

  // ─────────────────── helpers ───────────────────

  private activityBody(
    type: string,
    status: LeadDocumentStatus,
    isAccept: boolean,
    isNegative: boolean,
  ): string {
    if (isAccept) return `Document ${type} accepted.`;
    if (status === 'rejected') return `Document ${type} rejected.`;
    if (status === 'needs_resubmission') return `Document ${type} needs resubmission.`;
    if (status === 'uploaded') return `Document ${type} marked uploaded.`;
    void isNegative;
    return `Document ${type} updated.`;
  }
}
