import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { requireTenantId } from '../tenants/tenant-context';
import type { CreateMetaLeadSourceDto, UpdateMetaLeadSourceDto } from './ingestion.dto';

/**
 * P2-06 — admin CRUD for Meta lead-ad source configurations.
 *
 * `meta_lead_sources` is intentionally NOT RLS-isolated (it has to be
 * read cross-tenant by the public webhook controller — see the
 * migration 0019 header). Tenant scoping is enforced here in the
 * service: every call filters / writes on `requireTenantId()`.
 *
 * The select shape returned to clients drops `app_secret` so a
 * compromised admin token cannot exfiltrate the HMAC secret. The
 * webhook handler uses `findRoutingByPageId` instead, which exposes
 * `appSecret` only inside the trusted ingestion path.
 */
@Injectable()
export class MetaLeadSourcesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  list() {
    const tenantId = requireTenantId();
    return this.prisma.metaLeadSource.findMany({
      where: { tenantId },
      orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
      select: PUBLIC_SELECT,
    });
  }

  async findByIdOrThrow(id: string) {
    const tenantId = requireTenantId();
    const row = await this.prisma.metaLeadSource.findFirst({
      where: { id, tenantId },
      select: PUBLIC_SELECT,
    });
    if (!row) {
      throw new NotFoundException({
        code: 'meta_lead_source.not_found',
        message: `Meta lead source ${id} not found in active tenant`,
      });
    }
    return row;
  }

  async create(dto: CreateMetaLeadSourceDto, actorUserId: string | null) {
    const tenantId = requireTenantId();
    try {
      const created = await this.prisma.metaLeadSource.create({
        data: {
          tenantId,
          displayName: dto.displayName,
          pageId: dto.pageId,
          formId: dto.formId ?? null,
          verifyToken: dto.verifyToken,
          appSecret: dto.appSecret ?? null,
          defaultSource: dto.defaultSource,
          fieldMapping: dto.fieldMapping as Prisma.InputJsonValue,
          isActive: dto.isActive,
        },
        select: PUBLIC_SELECT,
      });
      await this.prisma.withTenant(tenantId, (tx) =>
        this.audit.writeInTx(tx, tenantId, {
          action: 'meta_lead_source.created',
          entityType: 'meta_lead_source',
          entityId: created.id,
          actorUserId,
          payload: {
            pageId: created.pageId,
            formId: created.formId,
            displayName: created.displayName,
          } as Prisma.InputJsonValue,
        }),
      );
      return created;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException({
          code: 'meta_lead_source.duplicate',
          message: `A Meta lead source with that page and form already exists`,
        });
      }
      throw err;
    }
  }

  async update(id: string, dto: UpdateMetaLeadSourceDto, actorUserId: string | null) {
    const tenantId = requireTenantId();
    await this.findByIdOrThrow(id);
    try {
      const updated = await this.prisma.metaLeadSource.update({
        where: { id },
        data: {
          ...(dto.displayName !== undefined && { displayName: dto.displayName }),
          ...(dto.pageId !== undefined && { pageId: dto.pageId }),
          ...(dto.formId !== undefined && { formId: dto.formId }),
          ...(dto.verifyToken !== undefined && { verifyToken: dto.verifyToken }),
          ...(dto.appSecret !== undefined && { appSecret: dto.appSecret }),
          ...(dto.defaultSource !== undefined && { defaultSource: dto.defaultSource }),
          ...(dto.fieldMapping !== undefined && {
            fieldMapping: dto.fieldMapping as Prisma.InputJsonValue,
          }),
          ...(dto.isActive !== undefined && { isActive: dto.isActive }),
        },
        select: PUBLIC_SELECT,
      });
      await this.prisma.withTenant(tenantId, (tx) =>
        this.audit.writeInTx(tx, tenantId, {
          action: 'meta_lead_source.updated',
          entityType: 'meta_lead_source',
          entityId: id,
          actorUserId,
          payload: { changes: Object.keys(dto) } as Prisma.InputJsonValue,
        }),
      );
      return updated;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException({
          code: 'meta_lead_source.duplicate',
          message: `A Meta lead source with that page and form already exists`,
        });
      }
      throw err;
    }
  }

  async delete(id: string, actorUserId: string | null) {
    const tenantId = requireTenantId();
    await this.findByIdOrThrow(id);
    await this.prisma.metaLeadSource.delete({ where: { id } });
    await this.prisma.withTenant(tenantId, (tx) =>
      this.audit.writeInTx(tx, tenantId, {
        action: 'meta_lead_source.deleted',
        entityType: 'meta_lead_source',
        entityId: id,
        actorUserId,
      }),
    );
  }

  /**
   * Cross-tenant routing lookup used by the public webhook handler. NOT
   * tenant-scoped: it's how we discover the tenant in the first place.
   * Returns the full row (including appSecret) so the controller can
   * verify the HMAC signature. Callers must NEVER expose this row to
   * an admin client.
   */
  findRoutingByPageId(pageId: string, formId?: string | null) {
    return this.prisma.metaLeadSource.findFirst({
      where: {
        pageId,
        isActive: true,
        // formId on the row may be null (catch-all for the page), or a
        // specific id; prefer specific match when both exist.
        ...(formId ? { OR: [{ formId }, { formId: null }] } : { formId: null }),
      },
      orderBy: { formId: 'desc' }, // non-null formIds win over null catch-alls
    });
  }

  /** Webhook GET handshake routing — match active source by verify token. */
  findRoutingByVerifyToken(verifyToken: string) {
    return this.prisma.metaLeadSource.findFirst({
      where: { verifyToken, isActive: true },
    });
  }
}

const PUBLIC_SELECT = {
  id: true,
  tenantId: true,
  displayName: true,
  pageId: true,
  formId: true,
  verifyToken: true,
  // appSecret intentionally omitted — never returned to clients.
  defaultSource: true,
  fieldMapping: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.MetaLeadSourceSelect;
