import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { requireTenantId } from '../tenants/tenant-context';

/**
 * Phase D4 — D4.3: PartnerSnapshot read service.
 *
 * Read-only surface over the append-only snapshot + record tables.
 * Snapshots themselves are written exclusively by `PartnerSyncService`;
 * this service exposes them to admin pages.
 *
 * `recordsForSnapshot` paginates `partner_records` rows with the
 * fields the UI actually shows. `rawRow` is intentionally NOT
 * returned in the default projection — it's only available on a
 * dedicated detail-row endpoint (deferred to a follow-up; UI
 * doesn't need it for the snapshot list).
 */
@Injectable()
export class PartnerSnapshotsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(filters: {
    partnerSourceId?: string;
    status?: string;
    from?: Date;
    to?: Date;
    limit: number;
    offset: number;
  }): Promise<{ items: PartnerSnapshotDto[]; total: number }> {
    const tenantId = requireTenantId();
    const where: Prisma.PartnerSnapshotWhereInput = {
      tenantId,
      ...(filters.partnerSourceId && { partnerSourceId: filters.partnerSourceId }),
      ...(filters.status && { status: filters.status }),
      ...((filters.from || filters.to) && {
        startedAt: {
          ...(filters.from && { gte: filters.from }),
          ...(filters.to && { lte: filters.to }),
        },
      }),
    };
    return this.prisma.withTenant(tenantId, async (tx) => {
      const [items, total] = await Promise.all([
        tx.partnerSnapshot.findMany({
          where,
          orderBy: { startedAt: 'desc' },
          take: filters.limit,
          skip: filters.offset,
          include: {
            partnerSource: { select: { id: true, displayName: true, partnerCode: true } },
            triggeredBy: { select: { id: true, name: true } },
          },
        }),
        tx.partnerSnapshot.count({ where }),
      ]);
      return { items: items.map((row) => toSnapshotDto(row)), total };
    });
  }

  async findById(id: string): Promise<PartnerSnapshotDto> {
    const tenantId = requireTenantId();
    const row = await this.prisma.withTenant(tenantId, (tx) =>
      tx.partnerSnapshot.findFirst({
        where: { id, tenantId },
        include: {
          partnerSource: { select: { id: true, displayName: true, partnerCode: true } },
          triggeredBy: { select: { id: true, name: true } },
        },
      }),
    );
    if (!row) {
      throw new NotFoundException({
        code: 'partner.snapshot.not_found',
        message: `Partner snapshot not found: ${id}`,
      });
    }
    return toSnapshotDto(row);
  }

  async recordsForSnapshot(
    snapshotId: string,
    opts: { limit: number; offset: number },
  ): Promise<{ items: PartnerRecordDto[]; total: number }> {
    const tenantId = requireTenantId();
    // Ensure the snapshot is visible (RLS already protects, but the
    // explicit existence check yields a clean 404).
    await this.findById(snapshotId);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const where: Prisma.PartnerRecordWhereInput = { tenantId, snapshotId };
      const [items, total] = await Promise.all([
        tx.partnerRecord.findMany({
          where,
          orderBy: { createdAt: 'asc' },
          take: opts.limit,
          skip: opts.offset,
          select: {
            id: true,
            phone: true,
            partnerStatus: true,
            partnerActiveDate: true,
            partnerDftDate: true,
            tripCount: true,
            lastTripAt: true,
            contactId: true,
            createdAt: true,
          },
        }),
        tx.partnerRecord.count({ where }),
      ]);
      return {
        items: items.map((r) => ({
          id: r.id,
          phone: r.phone,
          partnerStatus: r.partnerStatus,
          partnerActiveDate: r.partnerActiveDate ? r.partnerActiveDate.toISOString() : null,
          partnerDftDate: r.partnerDftDate ? r.partnerDftDate.toISOString() : null,
          tripCount: r.tripCount,
          lastTripAt: r.lastTripAt ? r.lastTripAt.toISOString() : null,
          contactResolved: r.contactId !== null,
          createdAt: r.createdAt.toISOString(),
        })),
        total,
      };
    });
  }
}

export interface PartnerSnapshotDto {
  id: string;
  partnerSourceId: string;
  partnerSource: { id: string; displayName: string; partnerCode: string } | null;
  startedAt: string;
  completedAt: string | null;
  status: string;
  rowsTotal: number;
  rowsImported: number;
  rowsSkipped: number;
  rowsError: number;
  sourceMetadata: Record<string, unknown> | null;
  triggeredBy: { id: string; name: string } | null;
  createdAt: string;
}

export interface PartnerRecordDto {
  id: string;
  phone: string | null;
  partnerStatus: string | null;
  partnerActiveDate: string | null;
  partnerDftDate: string | null;
  tripCount: number | null;
  lastTripAt: string | null;
  /** Whether the snapshot row resolved to an existing Contact. */
  contactResolved: boolean;
  createdAt: string;
}

type SnapshotWithRelations = Prisma.PartnerSnapshotGetPayload<{
  include: {
    partnerSource: { select: { id: true; displayName: true; partnerCode: true } };
    triggeredBy: { select: { id: true; name: true } };
  };
}>;

function toSnapshotDto(row: SnapshotWithRelations): PartnerSnapshotDto {
  return {
    id: row.id,
    partnerSourceId: row.partnerSourceId,
    partnerSource: row.partnerSource
      ? {
          id: row.partnerSource.id,
          displayName: row.partnerSource.displayName,
          partnerCode: row.partnerSource.partnerCode,
        }
      : null,
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    status: row.status,
    rowsTotal: row.rowsTotal,
    rowsImported: row.rowsImported,
    rowsSkipped: row.rowsSkipped,
    rowsError: row.rowsError,
    sourceMetadata: (row.sourceMetadata as Record<string, unknown> | null) ?? null,
    triggeredBy: row.triggeredBy ? { id: row.triggeredBy.id, name: row.triggeredBy.name } : null,
    createdAt: row.createdAt.toISOString(),
  };
}
