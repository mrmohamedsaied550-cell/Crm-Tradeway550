import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { requireTenantId } from '../tenants/tenant-context';
import type { CreateFollowUpDto, ListMyFollowUpsQueryDto } from './follow-up.dto';

@Injectable()
export class FollowUpsService {
  constructor(private readonly prisma: PrismaService) {}

  async listForLead(leadId: string) {
    const tenantId = requireTenantId();
    return this.prisma.withTenant(tenantId, async (tx) => {
      // Confirm the lead is visible to the active tenant; RLS does
      // the heavy lifting but the explicit lookup gives a clear 404.
      const lead = await tx.lead.findUnique({ where: { id: leadId }, select: { id: true } });
      if (!lead) {
        throw new NotFoundException({
          code: 'lead.not_found',
          message: `Lead ${leadId} not found in active tenant`,
        });
      }
      return tx.leadFollowUp.findMany({
        where: { leadId },
        orderBy: [{ completedAt: 'asc' }, { dueAt: 'asc' }],
      });
    });
  }

  async listMine(userId: string, query: ListMyFollowUpsQueryDto) {
    const tenantId = requireTenantId();
    const now = new Date();
    return this.prisma.withTenant(tenantId, (tx) => {
      const base = { assignedToId: userId };
      const where =
        query.status === 'done'
          ? { ...base, completedAt: { not: null } }
          : query.status === 'overdue'
            ? { ...base, completedAt: null, dueAt: { lt: now } }
            : query.status === 'all'
              ? base
              : /* pending */ { ...base, completedAt: null };
      return tx.leadFollowUp.findMany({
        where,
        orderBy: [{ dueAt: 'asc' }],
        take: query.limit,
        include: {
          lead: { select: { id: true, name: true, phone: true } },
        },
      });
    });
  }

  async create(leadId: string, dto: CreateFollowUpDto, actorUserId: string | null) {
    const tenantId = requireTenantId();
    return this.prisma.withTenant(tenantId, async (tx) => {
      const lead = await tx.lead.findUnique({
        where: { id: leadId },
        select: { id: true, assignedToId: true },
      });
      if (!lead) {
        throw new NotFoundException({
          code: 'lead.not_found',
          message: `Lead ${leadId} not found in active tenant`,
        });
      }
      const assignedToId = dto.assignedToId !== undefined ? dto.assignedToId : lead.assignedToId;
      return tx.leadFollowUp.create({
        data: {
          tenantId,
          leadId,
          actionType: dto.actionType,
          dueAt: new Date(dto.dueAt),
          note: dto.note ?? null,
          assignedToId,
          createdById: actorUserId,
        },
      });
    });
  }

  async complete(id: string) {
    const tenantId = requireTenantId();
    return this.prisma.withTenant(tenantId, async (tx) => {
      const row = await tx.leadFollowUp.findUnique({ where: { id }, select: { id: true } });
      if (!row) {
        throw new NotFoundException({
          code: 'followup.not_found',
          message: `Follow-up ${id} not found in active tenant`,
        });
      }
      return tx.leadFollowUp.update({
        where: { id },
        data: { completedAt: new Date() },
      });
    });
  }

  async remove(id: string) {
    const tenantId = requireTenantId();
    await this.prisma.withTenant(tenantId, async (tx) => {
      await tx.leadFollowUp.delete({ where: { id } }).catch(() => {});
    });
  }
}
