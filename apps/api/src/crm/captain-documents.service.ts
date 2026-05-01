import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { requireTenantId } from '../tenants/tenant-context';
import type {
  CreateCaptainDocumentDto,
  ListCaptainDocumentsQueryDto,
  ReviewCaptainDocumentDto,
} from './captain-documents.dto';

export type CaptainDocumentStatus = 'pending' | 'approved' | 'rejected' | 'expired';

/**
 * P2-09 — captain document lifecycle.
 *
 * Storage policy: the CRM stores metadata only — the actual file
 * lives wherever the operator put it (S3, GCS, local disk). The
 * caller passes `storageRef`; we don't open / validate the bytes.
 *
 * Status transitions:
 *   - new uploads land as `pending`,
 *   - review flips to `approved` or `rejected` (with reviewer trail),
 *   - lazy expiration: every read clamps a row's status to `expired`
 *     when `expiresAt < now`. We don't run a sweep job — the next
 *     read does it. A scheduled sweep can land in Phase 3 if the
 *     volume warrants it.
 *
 * Onboarding flag sync: when an `id_card` / `license` /
 * `vehicle_registration` document flips to `approved`, we set the
 * matching boolean on `captains` (`hasIdCard`, etc) so the existing
 * onboarding-status logic keeps working. Rejecting a document does
 * NOT clear the flag — admins can replace the document and a fresh
 * approval will re-set.
 */
@Injectable()
export class CaptainDocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Optional() private readonly notifications?: NotificationsService,
  ) {}

  // ─────────────────── reads ───────────────────

  async listForCaptain(captainId: string, opts: ListCaptainDocumentsQueryDto) {
    const tenantId = requireTenantId();
    return this.prisma.withTenant(tenantId, async (tx) => {
      const captain = await tx.captain.findUnique({
        where: { id: captainId },
        select: { id: true },
      });
      if (!captain) {
        throw new NotFoundException({
          code: 'captain.not_found',
          message: `Captain ${captainId} not found in active tenant`,
        });
      }
      const rows = await tx.captainDocument.findMany({
        where: { captainId, ...(opts.status && { status: opts.status }) },
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
        include: {
          reviewer: { select: { id: true, name: true, email: true } },
          uploadedBy: { select: { id: true, name: true, email: true } },
        },
      });
      // Lazy expiration: clamp rows whose expiresAt is past.
      const now = new Date();
      return rows.map((r) => this.applyExpired(r, now));
    });
  }

  async findByIdOrThrow(id: string) {
    const tenantId = requireTenantId();
    const row = await this.prisma.withTenant(tenantId, (tx) =>
      tx.captainDocument.findFirst({
        where: { id },
        include: {
          reviewer: { select: { id: true, name: true, email: true } },
          uploadedBy: { select: { id: true, name: true, email: true } },
        },
      }),
    );
    if (!row) {
      throw new NotFoundException({
        code: 'captain.document.not_found',
        message: `Captain document ${id} not found in active tenant`,
      });
    }
    return this.applyExpired(row, new Date());
  }

  // ─────────────────── writes ───────────────────

  async upload(captainId: string, dto: CreateCaptainDocumentDto, actorUserId: string | null) {
    const tenantId = requireTenantId();
    return this.prisma.withTenant(tenantId, async (tx) => {
      const captain = await tx.captain.findUnique({
        where: { id: captainId },
        select: { id: true },
      });
      if (!captain) {
        throw new NotFoundException({
          code: 'captain.not_found',
          message: `Captain ${captainId} not found in active tenant`,
        });
      }
      const expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : null;
      if (expiresAt && Number.isNaN(expiresAt.getTime())) {
        throw new BadRequestException({
          code: 'captain.document.invalid_expiry',
          message: `Invalid expiresAt: ${dto.expiresAt}`,
        });
      }
      const created = await tx.captainDocument.create({
        data: {
          tenantId,
          captainId,
          kind: dto.kind,
          storageRef: dto.storageRef,
          fileName: dto.fileName,
          mimeType: dto.mimeType,
          sizeBytes: dto.sizeBytes,
          status: 'pending',
          expiresAt,
          uploadedById: actorUserId,
        },
        include: {
          reviewer: { select: { id: true, name: true, email: true } },
          uploadedBy: { select: { id: true, name: true, email: true } },
        },
      });
      await this.audit.writeInTx(tx, tenantId, {
        action: 'captain.document.uploaded',
        entityType: 'captain_document',
        entityId: created.id,
        actorUserId,
        payload: {
          captainId,
          kind: dto.kind,
          fileName: dto.fileName,
          sizeBytes: dto.sizeBytes,
          mimeType: dto.mimeType,
        } as Prisma.InputJsonValue,
      });
      return created;
    });
  }

  async review(id: string, dto: ReviewCaptainDocumentDto, reviewerUserId: string) {
    const tenantId = requireTenantId();
    return this.prisma.withTenant(tenantId, async (tx) => {
      const before = await tx.captainDocument.findUnique({ where: { id } });
      if (!before) {
        throw new NotFoundException({
          code: 'captain.document.not_found',
          message: `Captain document ${id} not found in active tenant`,
        });
      }
      // Re-reviewing an already-decided doc is allowed (operator
      // changes their mind), but a `pending`/`expired` doc that's
      // been replaced by a newer one is fair game — we don't look
      // for "latest of kind" here.
      const newStatus: CaptainDocumentStatus = dto.decision === 'approve' ? 'approved' : 'rejected';
      const now = new Date();
      const updated = await tx.captainDocument.update({
        where: { id },
        data: {
          status: newStatus,
          reviewerUserId,
          reviewedAt: now,
          reviewNotes: dto.notes ?? null,
        },
        include: {
          reviewer: { select: { id: true, name: true, email: true } },
          uploadedBy: { select: { id: true, name: true, email: true } },
        },
      });

      // Sync the legacy onboarding flags on the captain row when an
      // approved document covers one of the canonical kinds. We do
      // NOT clear flags on rejection — admins can re-upload and a
      // fresh approval re-sets.
      if (newStatus === 'approved') {
        const flagField = onboardingFlagFor(before.kind);
        if (flagField) {
          await tx.captain.update({
            where: { id: before.captainId },
            data: { [flagField]: true },
          });
        }
      }

      await this.audit.writeInTx(tx, tenantId, {
        action: `captain.document.${newStatus}`,
        entityType: 'captain_document',
        entityId: id,
        actorUserId: reviewerUserId,
        payload: {
          captainId: before.captainId,
          kind: before.kind,
          previousStatus: before.status,
          notes: dto.notes ?? null,
        } as Prisma.InputJsonValue,
      });

      // Light-touch in-app notification for the lead's original
      // assignee (the agent who converted the captain). Best-effort:
      // we look up the captain's lead.assignedToId and bell them.
      if (this.notifications && (newStatus === 'approved' || newStatus === 'rejected')) {
        const lead = await tx.captain.findUnique({
          where: { id: before.captainId },
          select: { lead: { select: { assignedToId: true } } },
        });
        const recipient = lead?.lead?.assignedToId;
        if (recipient && recipient !== reviewerUserId) {
          await this.notifications.createInTx(tx, tenantId, {
            recipientUserId: recipient,
            kind: `captain.document.${newStatus}`,
            title: `Captain document ${newStatus}`,
            body: `${before.kind} on captain ${before.captainId.slice(0, 8)} was ${newStatus}.`,
            payload: {
              captainId: before.captainId,
              documentId: id,
              kind: before.kind,
            },
          });
        }
      }

      return updated;
    });
  }

  async delete(id: string, actorUserId: string | null) {
    const tenantId = requireTenantId();
    return this.prisma.withTenant(tenantId, async (tx) => {
      const before = await tx.captainDocument.findUnique({
        where: { id },
        select: { id: true, captainId: true, kind: true, storageRef: true },
      });
      if (!before) {
        throw new NotFoundException({
          code: 'captain.document.not_found',
          message: `Captain document ${id} not found in active tenant`,
        });
      }
      await tx.captainDocument.delete({ where: { id } });
      await this.audit.writeInTx(tx, tenantId, {
        action: 'captain.document.deleted',
        entityType: 'captain_document',
        entityId: id,
        actorUserId,
        payload: {
          captainId: before.captainId,
          kind: before.kind,
        } as Prisma.InputJsonValue,
      });
    });
  }

  // ─────────────────── helpers ───────────────────

  /**
   * Lazily flip a row's status to "expired" when `expiresAt < now`.
   * Returns the row with the (possibly synthetic) status — we do
   * NOT persist the flip here to keep reads zero-write. A scheduled
   * sweep can persist this in Phase 3.
   */
  private applyExpired<T extends { status: string; expiresAt: Date | null }>(row: T, now: Date): T {
    if (
      row.expiresAt &&
      row.expiresAt.getTime() < now.getTime() &&
      row.status !== 'expired' &&
      row.status !== 'rejected'
    ) {
      return { ...row, status: 'expired' };
    }
    return row;
  }
}

/**
 * Map a document `kind` to the matching boolean column on
 * `captains` so an approved document automatically updates the
 * onboarding flags. Unknown kinds (free-form) return null and the
 * onboarding row is untouched.
 */
function onboardingFlagFor(
  kind: string,
): 'hasIdCard' | 'hasLicense' | 'hasVehicleRegistration' | null {
  switch (kind) {
    case 'id_card':
      return 'hasIdCard';
    case 'license':
      return 'hasLicense';
    case 'vehicle_registration':
      return 'hasVehicleRegistration';
    default:
      return null;
  }
}
