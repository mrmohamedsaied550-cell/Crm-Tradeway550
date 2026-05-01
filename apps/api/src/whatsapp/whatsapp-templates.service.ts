import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { requireTenantId } from '../tenants/tenant-context';
import type {
  CreateWhatsAppTemplateDto,
  ListWhatsAppTemplatesQueryDto,
  UpdateWhatsAppTemplateDto,
} from './whatsapp-templates.dto';

/**
 * P2-12 — admin CRUD over WhatsApp templates the operator has
 * already had approved by Meta in the WABA console.
 *
 * Template `name` + `language` is unique per account because that's
 * how Meta identifies a template at send-time. `variableCount` is
 * pre-computed from the body's `{{1}}`/`{{2}}` placeholders so the
 * picker can validate the number of variables on the way in
 * without re-parsing on every render.
 */
@Injectable()
export class WhatsAppTemplatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  list(opts: ListWhatsAppTemplatesQueryDto) {
    const tenantId = requireTenantId();
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.whatsAppTemplate.findMany({
        where: {
          ...(opts.accountId && { accountId: opts.accountId }),
          ...(opts.status && { status: opts.status }),
        },
        orderBy: [{ status: 'asc' }, { name: 'asc' }, { language: 'asc' }],
      }),
    );
  }

  async findByIdOrThrow(id: string) {
    const tenantId = requireTenantId();
    const row = await this.prisma.withTenant(tenantId, (tx) =>
      tx.whatsAppTemplate.findFirst({ where: { id } }),
    );
    if (!row) {
      throw new NotFoundException({
        code: 'whatsapp.template.not_found',
        message: `WhatsApp template ${id} not found in active tenant`,
      });
    }
    return row;
  }

  async create(dto: CreateWhatsAppTemplateDto, actorUserId: string | null) {
    const tenantId = requireTenantId();
    const variableCount = countTemplateVariables(dto.bodyText);
    try {
      return await this.prisma.withTenant(tenantId, async (tx) => {
        // Cross-validate the account belongs to this tenant.
        const account = await tx.whatsAppAccount.findUnique({
          where: { id: dto.accountId },
          select: { id: true },
        });
        if (!account) {
          throw new BadRequestException({
            code: 'whatsapp.template.account_not_found',
            message: `WhatsApp account ${dto.accountId} not found in active tenant`,
          });
        }
        const created = await tx.whatsAppTemplate.create({
          data: {
            tenantId,
            accountId: dto.accountId,
            name: dto.name,
            language: dto.language,
            category: dto.category,
            bodyText: dto.bodyText,
            variableCount,
            status: dto.status,
          },
        });
        await this.audit.writeInTx(tx, tenantId, {
          action: 'whatsapp.template.created',
          entityType: 'whatsapp_template',
          entityId: created.id,
          actorUserId,
          payload: {
            accountId: dto.accountId,
            name: dto.name,
            language: dto.language,
            variableCount,
          } as Prisma.InputJsonValue,
        });
        return created;
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException({
          code: 'whatsapp.template.duplicate',
          message: `A template named "${dto.name}" (${dto.language}) already exists for this account`,
        });
      }
      throw err;
    }
  }

  async update(id: string, dto: UpdateWhatsAppTemplateDto, actorUserId: string | null) {
    const tenantId = requireTenantId();
    await this.findByIdOrThrow(id);
    const variableCount =
      dto.bodyText !== undefined ? countTemplateVariables(dto.bodyText) : undefined;
    return this.prisma.withTenant(tenantId, async (tx) => {
      const updated = await tx.whatsAppTemplate.update({
        where: { id },
        data: {
          ...(dto.bodyText !== undefined && { bodyText: dto.bodyText }),
          ...(variableCount !== undefined && { variableCount }),
          ...(dto.category !== undefined && { category: dto.category }),
          ...(dto.status !== undefined && { status: dto.status }),
        },
      });
      await this.audit.writeInTx(tx, tenantId, {
        action: 'whatsapp.template.updated',
        entityType: 'whatsapp_template',
        entityId: id,
        actorUserId,
        payload: { changes: Object.keys(dto) } as Prisma.InputJsonValue,
      });
      return updated;
    });
  }

  async delete(id: string, actorUserId: string | null) {
    const tenantId = requireTenantId();
    await this.findByIdOrThrow(id);
    await this.prisma.withTenant(tenantId, (tx) => tx.whatsAppTemplate.delete({ where: { id } }));
    await this.prisma.withTenant(tenantId, (tx) =>
      this.audit.writeInTx(tx, tenantId, {
        action: 'whatsapp.template.deleted',
        entityType: 'whatsapp_template',
        entityId: id,
        actorUserId,
      }),
    );
  }
}

/**
 * Count distinct `{{N}}` placeholders in a template body. We
 * track the MAX index rather than the unique count so a body that
 * uses `{{1}}` and `{{3}}` (skipping 2) still requires 3 variables
 * — Meta's renderer treats the indexes as positional.
 */
export function countTemplateVariables(body: string): number {
  let max = 0;
  for (const match of body.matchAll(/\{\{\s*(\d+)\s*\}\}/gu)) {
    const n = Number.parseInt(match[1] ?? '0', 10);
    if (n > max) max = n;
  }
  return max;
}
