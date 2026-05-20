import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { requireTenantId } from '../tenants/tenant-context';
import { PipelineService } from './pipeline.service';
import type {
  CreateLeadStatusDto,
  UpdateLeadStatusDto,
  CreateLeadDocumentDto,
  UpdateLeadDocumentDto,
  CreateLeadFollowUpDto,
  CompleteLeadFollowUpDto,
  AdvancedFilterDto,
} from './lead-extensions.dto';

/**
 * Lead Extensions Service (C30).
 *
 * Handles lead statuses (substatus within a stage), documents,
 * follow-ups, and advanced filtering.
 */
@Injectable()
export class LeadExtensionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pipeline: PipelineService,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // LEAD STATUSES
  // ═══════════════════════════════════════════════════════════════════════════

  async listStatuses(stageCode?: string) {
    const tenantId = requireTenantId();
    const where: Prisma.LeadStatusWhereInput = {};

    if (stageCode) {
      const stage = await this.pipeline.findByCodeOrThrow(stageCode);
      where.stageId = stage.id;
    }

    return this.prisma.withTenant(tenantId, (tx) =>
      tx.leadStatus.findMany({
        where,
        orderBy: [{ stageId: 'asc' }, { order: 'asc' }],
        include: {
          stage: { select: { code: true, name: true, order: true } },
        },
      }),
    );
  }

  async createStatus(dto: CreateLeadStatusDto) {
    const tenantId = requireTenantId();
    const stage = await this.pipeline.findByCodeOrThrow(dto.stageCode);

    try {
      return await this.prisma.withTenant(tenantId, async (tx) => {
        // If this is set as default, unset any existing default for this stage
        if (dto.isDefault) {
          await tx.leadStatus.updateMany({
            where: { stageId: stage.id, isDefault: true },
            data: { isDefault: false },
          });
        }

        return tx.leadStatus.create({
          data: {
            tenantId,
            stageId: stage.id,
            code: dto.code,
            name: dto.name,
            color: dto.color,
            order: dto.order,
            isDefault: dto.isDefault,
          },
          include: {
            stage: { select: { code: true, name: true, order: true } },
          },
        });
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException({
          code: 'lead_status.duplicate',
          message: `A status with code "${dto.code}" already exists for this stage`,
        });
      }
      throw err;
    }
  }

  async updateStatus(id: string, dto: UpdateLeadStatusDto) {
    const tenantId = requireTenantId();

    return this.prisma.withTenant(tenantId, async (tx) => {
      const existing = await tx.leadStatus.findUnique({ where: { id } });
      if (!existing) {
        throw new NotFoundException({ code: 'lead_status.not_found', message: `Status not found: ${id}` });
      }

      if (dto.isDefault) {
        await tx.leadStatus.updateMany({
          where: { stageId: existing.stageId, isDefault: true, id: { not: id } },
          data: { isDefault: false },
        });
      }

      return tx.leadStatus.update({
        where: { id },
        data: {
          ...(dto.name !== undefined && { name: dto.name }),
          ...(dto.color !== undefined && { color: dto.color }),
          ...(dto.order !== undefined && { order: dto.order }),
          ...(dto.isDefault !== undefined && { isDefault: dto.isDefault }),
        },
        include: {
          stage: { select: { code: true, name: true, order: true } },
        },
      });
    });
  }

  async deleteStatus(id: string) {
    const tenantId = requireTenantId();
    return this.prisma.withTenant(tenantId, async (tx) => {
      const existing = await tx.leadStatus.findUnique({ where: { id } });
      if (!existing) {
        throw new NotFoundException({ code: 'lead_status.not_found', message: `Status not found: ${id}` });
      }
      // Nullify all leads that have this status
      await tx.lead.updateMany({
        where: { statusId: id },
        data: { statusId: null },
      });
      await tx.leadStatus.delete({ where: { id } });
    });
  }

  async changeLeadStatus(leadId: string, statusId: string | null, actorUserId: string) {
    const tenantId = requireTenantId();

    return this.prisma.withTenant(tenantId, async (tx) => {
      const lead = await tx.lead.findUnique({
        where: { id: leadId },
        include: { stage: true, status: true },
      });
      if (!lead) {
        throw new NotFoundException({ code: 'lead.not_found', message: `Lead not found: ${leadId}` });
      }

      if (statusId !== null) {
        // Validate the status belongs to the lead's current stage
        const status = await tx.leadStatus.findUnique({ where: { id: statusId } });
        if (!status) {
          throw new NotFoundException({ code: 'lead_status.not_found', message: `Status not found: ${statusId}` });
        }
        if (status.stageId !== lead.stageId) {
          throw new BadRequestException({
            code: 'lead_status.wrong_stage',
            message: `Status "${status.code}" does not belong to stage "${lead.stage.code}"`,
          });
        }
      }

      const updated = await tx.lead.update({
        where: { id: leadId },
        data: { statusId },
        include: {
          stage: { select: { code: true, name: true, order: true, isTerminal: true } },
          status: { select: { id: true, code: true, name: true, color: true } },
          captain: { select: { id: true, onboardingStatus: true } },
        },
      });

      // Log activity
      await tx.leadActivity.create({
        data: {
          tenantId,
          leadId,
          type: 'status_change',
          body: statusId
            ? `Status changed to "${updated.status?.name}"`
            : 'Status cleared',
          payload: {
            event: 'status_change',
            fromStatusId: lead.statusId ?? null,
            toStatusId: statusId,
          },
          createdById: actorUserId,
        },
      });

      return updated;
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LEAD DOCUMENTS
  // ═══════════════════════════════════════════════════════════════════════════

  async listDocuments(leadId: string) {
    const tenantId = requireTenantId();
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.leadDocument.findMany({
        where: { leadId },
        orderBy: { createdAt: 'asc' },
      }),
    );
  }

  async createDocument(leadId: string, dto: CreateLeadDocumentDto, actorUserId: string) {
    const tenantId = requireTenantId();

    // Verify lead exists
    await this.prisma.withTenant(tenantId, async (tx) => {
      const lead = await tx.lead.findUnique({ where: { id: leadId } });
      if (!lead) throw new NotFoundException({ code: 'lead.not_found', message: `Lead not found: ${leadId}` });
    });

    return this.prisma.withTenant(tenantId, async (tx) => {
      const doc = await tx.leadDocument.create({
        data: {
          tenantId,
          leadId,
          type: dto.type,
          label: dto.label,
          status: dto.fileUrl ? 'uploaded' : 'pending',
          fileUrl: dto.fileUrl ?? null,
          notes: dto.notes ?? null,
        },
      });

      await tx.leadActivity.create({
        data: {
          tenantId,
          leadId,
          type: 'system',
          body: `Document "${dto.label}" added`,
          payload: { event: 'document_added', documentId: doc.id, type: dto.type },
          createdById: actorUserId,
        },
      });

      return doc;
    });
  }

  async updateDocument(leadId: string, docId: string, dto: UpdateLeadDocumentDto, actorUserId: string) {
    const tenantId = requireTenantId();

    return this.prisma.withTenant(tenantId, async (tx) => {
      const doc = await tx.leadDocument.findFirst({ where: { id: docId, leadId } });
      if (!doc) {
        throw new NotFoundException({ code: 'lead_document.not_found', message: `Document not found` });
      }

      const updated = await tx.leadDocument.update({
        where: { id: docId },
        data: {
          ...(dto.status !== undefined && { status: dto.status }),
          ...(dto.fileUrl !== undefined && { fileUrl: dto.fileUrl }),
          ...(dto.notes !== undefined && { notes: dto.notes }),
          ...(dto.status === 'approved' || dto.status === 'rejected'
            ? { reviewedBy: actorUserId, reviewedAt: new Date() }
            : {}),
        },
      });

      if (dto.status && dto.status !== doc.status) {
        await tx.leadActivity.create({
          data: {
            tenantId,
            leadId,
            type: 'system',
            body: `Document "${doc.label}" status changed to ${dto.status}`,
            payload: { event: 'document_status_change', documentId: docId, from: doc.status, to: dto.status },
            createdById: actorUserId,
          },
        });
      }

      return updated;
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LEAD FOLLOW-UPS
  // ═══════════════════════════════════════════════════════════════════════════

  async listFollowUps(leadId: string) {
    const tenantId = requireTenantId();
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.leadFollowUp.findMany({
        where: { leadId },
        orderBy: { scheduledAt: 'asc' },
      }),
    );
  }

  async createFollowUp(leadId: string, dto: CreateLeadFollowUpDto, actorUserId: string) {
    const tenantId = requireTenantId();

    return this.prisma.withTenant(tenantId, async (tx) => {
      const lead = await tx.lead.findUnique({ where: { id: leadId } });
      if (!lead) throw new NotFoundException({ code: 'lead.not_found', message: `Lead not found: ${leadId}` });

      const followUp = await tx.leadFollowUp.create({
        data: {
          tenantId,
          leadId,
          scheduledAt: new Date(dto.scheduledAt),
          method: dto.method,
          note: dto.note ?? null,
          createdBy: actorUserId,
        },
      });

      await tx.leadActivity.create({
        data: {
          tenantId,
          leadId,
          type: 'system',
          body: `Follow-up scheduled for ${dto.scheduledAt} via ${dto.method}`,
          payload: { event: 'follow_up_scheduled', followUpId: followUp.id, method: dto.method },
          createdById: actorUserId,
        },
      });

      return followUp;
    });
  }

  async completeFollowUp(leadId: string, followUpId: string, dto: CompleteLeadFollowUpDto, actorUserId: string) {
    const tenantId = requireTenantId();

    return this.prisma.withTenant(tenantId, async (tx) => {
      const followUp = await tx.leadFollowUp.findFirst({
        where: { id: followUpId, leadId },
      });
      if (!followUp) {
        throw new NotFoundException({ code: 'lead_follow_up.not_found', message: `Follow-up not found` });
      }
      if (followUp.status === 'completed') {
        throw new BadRequestException({ code: 'lead_follow_up.already_completed', message: 'Already completed' });
      }

      const updated = await tx.leadFollowUp.update({
        where: { id: followUpId },
        data: {
          status: 'completed',
          completedAt: new Date(),
          completedBy: actorUserId,
          ...(dto.note !== undefined && { note: dto.note }),
        },
      });

      await tx.leadActivity.create({
        data: {
          tenantId,
          leadId,
          type: 'system',
          body: `Follow-up completed (${followUp.method})`,
          payload: { event: 'follow_up_completed', followUpId, method: followUp.method },
          createdById: actorUserId,
        },
      });

      return updated;
    });
  }

  async listDueFollowUps() {
    const tenantId = requireTenantId();
    const now = new Date();

    return this.prisma.withTenant(tenantId, (tx) =>
      tx.leadFollowUp.findMany({
        where: {
          status: 'pending',
          scheduledAt: { lte: now },
        },
        orderBy: { scheduledAt: 'asc' },
        include: {
          lead: { select: { id: true, name: true, phone: true } },
        },
      }),
    );
  }

  async listMyFollowUps(userId: string, status?: string, limit?: number) {
    const tenantId = requireTenantId();
    const where: Record<string, unknown> = { createdBy: userId };
    if (status === 'pending') where.status = 'pending';
    else if (status === 'done') where.status = 'completed';
    // 'all' = no status filter

    return this.prisma.withTenant(tenantId, (tx) =>
      tx.leadFollowUp.findMany({
        where,
        orderBy: { scheduledAt: 'desc' },
        take: limit ?? 50,
        include: {
          lead: { select: { id: true, name: true, phone: true } },
        },
      }),
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ADVANCED FILTER / QUERY BUILDER
  // ═══════════════════════════════════════════════════════════════════════════

  async advancedFilter(dto: AdvancedFilterDto) {
    const tenantId = requireTenantId();

    const andConditions = this.buildConditions(dto.allConditions);
    const orConditions = this.buildConditions(dto.anyConditions);

    const where: Prisma.LeadWhereInput = {
      ...(andConditions.length > 0 && { AND: andConditions }),
      ...(orConditions.length > 0 && { OR: orConditions }),
    };

    return this.prisma.withTenant(tenantId, async (tx) => {
      const [items, total] = await Promise.all([
        tx.lead.findMany({
          where,
          orderBy: { [dto.sortBy]: dto.sortOrder },
          take: dto.limit,
          skip: dto.offset,
          include: {
            stage: { select: { code: true, name: true, order: true, isTerminal: true } },
            status: { select: { id: true, code: true, name: true, color: true } },
            captain: { select: { id: true, onboardingStatus: true } },
          },
        }),
        tx.lead.count({ where }),
      ]);
      return { items, total, limit: dto.limit, offset: dto.offset };
    });
  }

  private buildConditions(
    conditions: Array<{ field: string; operator: string; value?: unknown }>,
  ): Prisma.LeadWhereInput[] {
    return conditions.map((c) => this.mapCondition(c));
  }

  private mapCondition(c: { field: string; operator: string; value?: unknown }): Prisma.LeadWhereInput {
    const { field, operator, value } = c;

    switch (field) {
      case 'stage':
        return this.buildRelationFilter('stage', 'code', operator, value);
      case 'status':
        return this.buildRelationFilter('status', 'code', operator, value);
      case 'source':
        return this.buildStringFilter('source', operator, value);
      case 'assignedTo':
        if (operator === 'is_null') return { assignedToId: null };
        if (operator === 'is_not_null') return { assignedToId: { not: null } };
        return { assignedToId: value as string };
      case 'slaStatus':
        return this.buildStringFilter('slaStatus', operator, value);
      case 'name':
        return this.buildStringFilter('name', operator, value);
      case 'phone':
        return this.buildStringFilter('phone', operator, value);
      case 'email':
        return this.buildStringFilter('email', operator, value);
      case 'createdAt':
        return this.buildDateFilter('createdAt', operator, value);
      case 'updatedAt':
        return this.buildDateFilter('updatedAt', operator, value);
      case 'lastResponseAt':
        return this.buildDateFilter('lastResponseAt', operator, value);
      default:
        return {};
    }
  }

  private buildStringFilter(field: string, operator: string, value: unknown): Prisma.LeadWhereInput {
    switch (operator) {
      case 'eq':
        return { [field]: value as string };
      case 'neq':
        return { [field]: { not: value as string } };
      case 'contains':
        return { [field]: { contains: value as string, mode: 'insensitive' } };
      case 'not_contains':
        return { NOT: { [field]: { contains: value as string, mode: 'insensitive' } } };
      case 'in':
        return { [field]: { in: value as string[] } };
      case 'not_in':
        return { [field]: { notIn: value as string[] } };
      case 'is_null':
        return { [field]: null };
      case 'is_not_null':
        return { [field]: { not: null } };
      default:
        return {};
    }
  }

  private buildDateFilter(field: string, operator: string, value: unknown): Prisma.LeadWhereInput {
    const date = value ? new Date(value as string) : undefined;
    switch (operator) {
      case 'gt':
        return { [field]: { gt: date } };
      case 'gte':
        return { [field]: { gte: date } };
      case 'lt':
        return { [field]: { lt: date } };
      case 'lte':
        return { [field]: { lte: date } };
      case 'is_null':
        return { [field]: null };
      case 'is_not_null':
        return { [field]: { not: null } };
      default:
        return {};
    }
  }

  private buildRelationFilter(
    relation: string,
    subField: string,
    operator: string,
    value: unknown,
  ): Prisma.LeadWhereInput {
    switch (operator) {
      case 'eq':
        return { [relation]: { [subField]: value as string } };
      case 'neq':
        return { [relation]: { [subField]: { not: value as string } } };
      case 'in':
        return { [relation]: { [subField]: { in: value as string[] } } };
      case 'not_in':
        return { [relation]: { [subField]: { notIn: value as string[] } } };
      case 'is_null':
        return { [relation]: null };
      case 'is_not_null':
        return { NOT: { [relation]: null } };
      default:
        return {};
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // WHATSAPP CONVERSATION LOOKUP BY LEAD
  // ═══════════════════════════════════════════════════════════════════════════

  async getLeadConversations(leadId: string) {
    const tenantId = requireTenantId();

    return this.prisma.withTenant(tenantId, async (tx) => {
      const lead = await tx.lead.findUnique({ where: { id: leadId } });
      if (!lead) {
        throw new NotFoundException({ code: 'lead.not_found', message: `Lead not found: ${leadId}` });
      }

      // Find conversations linked to this lead OR matching the lead's phone
      const conversations = await tx.whatsAppConversation.findMany({
        where: {
          OR: [
            { leadId },
            { phone: lead.phone },
          ],
        },
        orderBy: { lastMessageAt: 'desc' },
        include: {
          account: { select: { id: true, displayName: true, phoneNumber: true } },
        },
      });

      return conversations;
    });
  }
}
