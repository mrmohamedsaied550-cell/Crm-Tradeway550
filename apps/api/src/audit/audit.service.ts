import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { requireTenantId } from '../tenants/tenant-context';

/**
 * C40 — Audit service.
 *
 * `writeEvent` appends a row to `audit_events` for non-lead-scoped
 * admin actions (bonus / competition / follow-up CRUD). It never
 * raises — audit failures are warned and swallowed so a downstream
 * write doesn't fail because the audit log briefly chokes.
 *
 * `list` returns a unified, normalized stream of `audit_events` plus
 * `lead_activities` (the lead-scoped audit trail authored elsewhere
 * — assignment / handover / sla_breach / note / stage_change /
 * auto_assignment), sorted desc by timestamp. Limited to a sensible
 * default; pagination via the `before` cursor.
 */

export interface AuditRow {
  source: 'audit_event' | 'lead_activity';
  id: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  actorUserId: string | null;
  payload: Prisma.JsonValue | null;
  createdAt: Date;
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Append an audit row inside an existing transaction (so the audit
   * lands or rolls back with the parent write).
   */
  async writeInTx(
    tx: Prisma.TransactionClient,
    tenantId: string,
    input: {
      action: string;
      entityType?: string | null;
      entityId?: string | null;
      payload?: Prisma.InputJsonValue;
      actorUserId?: string | null;
    },
  ): Promise<void> {
    await tx.auditEvent.create({
      data: {
        tenantId,
        action: input.action,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        ...(input.payload !== undefined && { payload: input.payload }),
        actorUserId: input.actorUserId ?? null,
      },
    });
  }

  /** Best-effort write outside a transaction. Failures are swallowed. */
  async writeEvent(input: {
    action: string;
    entityType?: string | null;
    entityId?: string | null;
    payload?: Prisma.InputJsonValue;
    actorUserId?: string | null;
  }): Promise<void> {
    const tenantId = requireTenantId();
    try {
      await this.prisma.withTenant(tenantId, (tx) => this.writeInTx(tx, tenantId, input));
    } catch {
      // Audit must not break the parent operation. The triggering
      // service has already returned its result by the time this runs.
    }
  }

  async list(opts: { limit?: number; before?: Date } = {}): Promise<AuditRow[]> {
    const tenantId = requireTenantId();
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const [events, activities] = await Promise.all([
        tx.auditEvent.findMany({
          where: opts.before ? { createdAt: { lt: opts.before } } : {},
          orderBy: { createdAt: 'desc' },
          take: limit,
        }),
        tx.leadActivity.findMany({
          where: opts.before ? { createdAt: { lt: opts.before } } : {},
          orderBy: { createdAt: 'desc' },
          take: limit,
          select: {
            id: true,
            type: true,
            body: true,
            payload: true,
            createdAt: true,
            createdById: true,
            leadId: true,
          },
        }),
      ]);

      const rows: AuditRow[] = [
        ...events.map<AuditRow>((e) => ({
          source: 'audit_event',
          id: e.id,
          action: e.action,
          entityType: e.entityType,
          entityId: e.entityId,
          actorUserId: e.actorUserId,
          payload: e.payload as Prisma.JsonValue | null,
          createdAt: e.createdAt,
        })),
        ...activities.map<AuditRow>((a) => ({
          source: 'lead_activity',
          id: a.id,
          action: `lead.${a.type}`,
          entityType: 'lead',
          entityId: a.leadId,
          actorUserId: a.createdById,
          payload: (() => {
            const extra = a.payload && typeof a.payload === 'object' ? a.payload : {};
            return a.body !== null
              ? { body: a.body, ...(extra as Record<string, unknown>) }
              : a.payload;
          })() as Prisma.JsonValue | null,
          createdAt: a.createdAt,
        })),
      ];

      rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return rows.slice(0, limit);
    });
  }
}
