import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { requireTenantId } from '../tenants/tenant-context';
import {
  type CreatePartnerMappingDto,
  type PartnerTargetField,
  type UpdatePartnerMappingDto,
} from './partner-mapping.dto';

/**
 * Phase D4 — D4.2: PartnerFieldMapping admin CRUD.
 *
 * One row per `(partnerSource, targetField)` — UNIQUE constraint
 * lives at the DB layer. Service catches the unique-violation
 * specifically so the operator sees a typed `partner.mapping.duplicate_target`
 * error instead of a raw 500.
 *
 * Phone mapping is required before sync — the service exposes
 * `getReadiness(sourceId)` returning `{ phoneMapped, missingTargets }`
 * so the UI can warn before the operator hits "Sync now". D4.2
 * never blocks mapping CRUD itself; readiness is advisory.
 *
 * Audit: every create / update / delete writes
 * `partner.mapping.updated` with `{ partnerSourceId, mappingId,
 * action, before, after, changedFields }` so the audit trail
 * reflects the operator's intent without three separate verbs.
 */
@Injectable()
export class PartnerMappingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(partnerSourceId: string): Promise<PartnerMappingDto[]> {
    const tenantId = requireTenantId();
    await this.assertSourceVisible(partnerSourceId);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.partnerFieldMapping.findMany({
        where: { tenantId, partnerSourceId },
        orderBy: [{ displayOrder: 'asc' }, { targetField: 'asc' }],
      });
      return rows.map((row) => this.toDto(row));
    });
  }

  async getReadiness(partnerSourceId: string): Promise<MappingReadiness> {
    const tenantId = requireTenantId();
    await this.assertSourceVisible(partnerSourceId);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.partnerFieldMapping.findMany({
        where: { tenantId, partnerSourceId },
        select: { targetField: true },
      });
      const fields = new Set(rows.map((r) => r.targetField));
      const phoneMapped = fields.has('phone');
      // Closed v1 set; future fields appended in
      // partner-mapping.dto.ts will need to be considered here too
      // if they should appear in the missingTargets list.
      const expected: PartnerTargetField[] = ['phone', 'partner_status', 'partner_active_date'];
      const missingTargets = expected.filter((f) => !fields.has(f));
      return { phoneMapped, missingTargets };
    });
  }

  async create(
    partnerSourceId: string,
    dto: CreatePartnerMappingDto,
    actorUserId: string | null,
  ): Promise<PartnerMappingDto> {
    const tenantId = requireTenantId();
    await this.assertSourceVisible(partnerSourceId);
    return this.prisma.withTenant(tenantId, async (tx) => {
      try {
        const row = await tx.partnerFieldMapping.create({
          data: {
            tenantId,
            partnerSourceId,
            sourceColumn: dto.sourceColumn,
            targetField: dto.targetField,
            ...(dto.transformKind !== undefined && { transformKind: dto.transformKind }),
            ...(dto.transformArgs !== undefined && {
              transformArgs: dto.transformArgs as Prisma.InputJsonValue,
            }),
            isRequired: dto.isRequired,
            displayOrder: dto.displayOrder,
          },
        });
        await this.audit.writeInTx(tx, tenantId, {
          action: 'partner.mapping.updated',
          entityType: 'partner_field_mapping',
          entityId: row.id,
          actorUserId,
          payload: {
            partnerSourceId,
            mappingId: row.id,
            action: 'create',
            after: this.toDto(row),
          } as unknown as Prisma.InputJsonValue,
        });
        return this.toDto(row);
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw new ConflictException({
            code: 'partner.mapping.duplicate_target',
            message: `Target field '${dto.targetField}' is already mapped on this source.`,
          });
        }
        throw err;
      }
    });
  }

  async update(
    partnerSourceId: string,
    mappingId: string,
    dto: UpdatePartnerMappingDto,
    actorUserId: string | null,
  ): Promise<PartnerMappingDto> {
    const tenantId = requireTenantId();
    await this.assertSourceVisible(partnerSourceId);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const before = await tx.partnerFieldMapping.findFirst({
        where: { id: mappingId, tenantId, partnerSourceId },
      });
      if (!before) {
        throw new NotFoundException({
          code: 'partner.mapping.not_found',
          message: `Mapping not found: ${mappingId}`,
        });
      }
      try {
        const updated = await tx.partnerFieldMapping.update({
          where: { id: mappingId },
          data: {
            ...(dto.sourceColumn !== undefined && { sourceColumn: dto.sourceColumn }),
            ...(dto.targetField !== undefined && { targetField: dto.targetField }),
            ...(dto.transformKind !== undefined && {
              transformKind: dto.transformKind,
            }),
            ...(dto.transformArgs !== undefined && {
              transformArgs:
                dto.transformArgs === null
                  ? Prisma.JsonNull
                  : (dto.transformArgs as Prisma.InputJsonValue),
            }),
            ...(dto.isRequired !== undefined && { isRequired: dto.isRequired }),
            ...(dto.displayOrder !== undefined && { displayOrder: dto.displayOrder }),
          },
        });
        const beforeDto = this.toDto(before);
        const afterDto = this.toDto(updated);
        const changedFields = (Object.keys(dto) as (keyof UpdatePartnerMappingDto)[]).filter(
          (k) =>
            JSON.stringify((beforeDto as unknown as Record<string, unknown>)[k]) !==
            JSON.stringify((afterDto as unknown as Record<string, unknown>)[k]),
        );
        await this.audit.writeInTx(tx, tenantId, {
          action: 'partner.mapping.updated',
          entityType: 'partner_field_mapping',
          entityId: updated.id,
          actorUserId,
          payload: {
            partnerSourceId,
            mappingId: updated.id,
            action: 'update',
            before: beforeDto,
            after: afterDto,
            changedFields,
          } as unknown as Prisma.InputJsonValue,
        });
        return afterDto;
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw new ConflictException({
            code: 'partner.mapping.duplicate_target',
            message: `Target field is already mapped on this source.`,
          });
        }
        throw err;
      }
    });
  }

  async remove(
    partnerSourceId: string,
    mappingId: string,
    actorUserId: string | null,
  ): Promise<void> {
    const tenantId = requireTenantId();
    await this.assertSourceVisible(partnerSourceId);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const before = await tx.partnerFieldMapping.findFirst({
        where: { id: mappingId, tenantId, partnerSourceId },
      });
      if (!before) {
        throw new NotFoundException({
          code: 'partner.mapping.not_found',
          message: `Mapping not found: ${mappingId}`,
        });
      }
      await tx.partnerFieldMapping.delete({ where: { id: mappingId } });
      await this.audit.writeInTx(tx, tenantId, {
        action: 'partner.mapping.updated',
        entityType: 'partner_field_mapping',
        entityId: before.id,
        actorUserId,
        payload: {
          partnerSourceId,
          mappingId: before.id,
          action: 'delete',
          before: this.toDto(before),
        } as unknown as Prisma.InputJsonValue,
      });
    });
  }

  private async assertSourceVisible(partnerSourceId: string): Promise<void> {
    const tenantId = requireTenantId();
    const exists = await this.prisma.withTenant(tenantId, (tx) =>
      tx.partnerSource.findFirst({
        where: { id: partnerSourceId, tenantId },
        select: { id: true },
      }),
    );
    if (!exists) {
      throw new NotFoundException({
        code: 'partner.source.not_found',
        message: `Partner source not found: ${partnerSourceId}`,
      });
    }
  }

  private toDto(
    row: Prisma.PartnerFieldMappingGetPayload<Record<string, never>>,
  ): PartnerMappingDto {
    return {
      id: row.id,
      partnerSourceId: row.partnerSourceId,
      sourceColumn: row.sourceColumn,
      targetField: row.targetField,
      transformKind: row.transformKind,
      transformArgs: row.transformArgs as Record<string, unknown> | null,
      isRequired: row.isRequired,
      displayOrder: row.displayOrder,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

export interface PartnerMappingDto {
  id: string;
  partnerSourceId: string;
  sourceColumn: string;
  targetField: string;
  transformKind: string | null;
  transformArgs: Record<string, unknown> | null;
  isRequired: boolean;
  displayOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface MappingReadiness {
  phoneMapped: boolean;
  /** Recommended target fields not yet mapped — advisory only. */
  missingTargets: string[];
}
