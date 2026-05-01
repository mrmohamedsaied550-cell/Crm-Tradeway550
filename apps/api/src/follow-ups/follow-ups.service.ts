import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { requireTenantId } from '../tenants/tenant-context';
import type { CreateFollowUpDto, ListMyFollowUpsQueryDto } from './follow-up.dto';

@Injectable()
export class FollowUpsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * C37 — recompute the lead's `nextActionDueAt` denormalised column
   * to the soonest pending (not-completed) follow-up's dueAt, or null
   * when none remain. Called inside the same transaction as the
   * triggering mutation so the column never lags behind reality.
   */
  private async recomputeNextActionDueAt(
    tx: Prisma.TransactionClient,
    leadId: string,
  ): Promise<void> {
    const next = await tx.leadFollowUp.findFirst({
      where: { leadId, completedAt: null },
      orderBy: { dueAt: 'asc' },
      select: { dueAt: true },
    });
    await tx.lead.update({
      where: { id: leadId },
      data: { nextActionDueAt: next?.dueAt ?? null },
    });
  }

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
      const created = await tx.leadFollowUp.create({
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
      await this.recomputeNextActionDueAt(tx, leadId);
      await this.audit.writeInTx(tx, tenantId, {
        action: 'followup.create',
        entityType: 'lead_followup',
        entityId: created.id,
        actorUserId,
        payload: { leadId, actionType: created.actionType, dueAt: created.dueAt.toISOString() },
      });
      return created;
    });
  }

  async complete(id: string, actorUserId: string | null = null) {
    const tenantId = requireTenantId();
    return this.prisma.withTenant(tenantId, async (tx) => {
      const row = await tx.leadFollowUp.findUnique({
        where: { id },
        select: { id: true, leadId: true },
      });
      if (!row) {
        throw new NotFoundException({
          code: 'followup.not_found',
          message: `Follow-up ${id} not found in active tenant`,
        });
      }
      const updated = await tx.leadFollowUp.update({
        where: { id },
        data: { completedAt: new Date() },
      });
      await this.recomputeNextActionDueAt(tx, row.leadId);
      await this.audit.writeInTx(tx, tenantId, {
        action: 'followup.complete',
        entityType: 'lead_followup',
        entityId: id,
        actorUserId,
        payload: { leadId: row.leadId },
      });
      return updated;
    });
  }

  async remove(id: string, actorUserId: string | null = null) {
    const tenantId = requireTenantId();
    await this.prisma.withTenant(tenantId, async (tx) => {
      const row = await tx.leadFollowUp
        .findUnique({ where: { id }, select: { leadId: true } })
        .catch(() => null);
      await tx.leadFollowUp.delete({ where: { id } }).catch(() => {});
      if (row?.leadId) {
        await this.recomputeNextActionDueAt(tx, row.leadId);
        await this.audit.writeInTx(tx, tenantId, {
          action: 'followup.delete',
          entityType: 'lead_followup',
          entityId: id,
          actorUserId,
          payload: { leadId: row.leadId },
        });
      }
    });
  }
}
