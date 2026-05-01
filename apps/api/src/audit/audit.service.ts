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

  /**
   * P2-04 — pre-context audit write.
   *
   * Identical to `writeEvent`, but takes the `tenantId` explicitly so
   * authentication flows (login / refresh / logout / lockout) — which
   * run BEFORE the tenant-context middleware has set
   * AsyncLocalStorage — can still record an audit row. Failures are
   * swallowed so an audit outage never breaks the auth path.
   */
  async writeForTenant(
    tenantId: string,
    input: {
      action: string;
      entityType?: string | null;
      entityId?: string | null;
      payload?: Prisma.InputJsonValue;
      actorUserId?: string | null;
    },
  ): Promise<void> {
    try {
      await this.prisma.withTenant(tenantId, (tx) => this.writeInTx(tx, tenantId, input));
    } catch {
      // see writeEvent
    }
  }

  /**
   * P2-04 — accept an `action` filter on the unified audit feed.
   *
   * Two shapes:
   *   - exact match  (e.g. `?action=auth.login.success`)
   *   - prefix match (e.g. `?action=auth.*`)  — convenient for "show
   *     me everything auth-related" without the caller having to OR
   *     a dozen specific verbs together.
   *
   * The filter applies to `audit_events.action` directly. For the
   * `lead_activities` half of the stream, the synthesised verb is
   * `lead.<type>`, so a prefix like `lead.*` will likewise narrow
   * the activity rows.
   */
  async list(opts: { limit?: number; before?: Date; action?: string } = {}): Promise<AuditRow[]> {
    const tenantId = requireTenantId();
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
    const filter = parseActionFilter(opts.action);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const eventWhere: Prisma.AuditEventWhereInput = {
        ...(opts.before && { createdAt: { lt: opts.before } }),
        ...(filter.kind === 'exact' && { action: filter.value }),
        ...(filter.kind === 'prefix' && { action: { startsWith: filter.value } }),
      };
      // For lead_activities the action is `lead.<type>`, so prefix
      // filters on that half of the stream are mapped to a `type`
      // filter where it makes sense, and the row is dropped entirely
      // when the filter is for a non-lead namespace (e.g. `auth.*`).
      const activitiesEnabled =
        filter.kind === 'none' ||
        (filter.kind === 'exact' && filter.value.startsWith('lead.')) ||
        (filter.kind === 'prefix' && 'lead.'.startsWith(filter.value));
      const activityWhere: Prisma.LeadActivityWhereInput = {
        ...(opts.before && { createdAt: { lt: opts.before } }),
        ...(filter.kind === 'exact' &&
          filter.value.startsWith('lead.') && { type: filter.value.slice('lead.'.length) }),
        ...(filter.kind === 'prefix' &&
          filter.value.startsWith('lead.') && {
            type: { startsWith: filter.value.slice('lead.'.length) },
          }),
      };
      const [events, activities] = await Promise.all([
        tx.auditEvent.findMany({
          where: eventWhere,
          orderBy: { createdAt: 'desc' },
          take: limit,
        }),
        activitiesEnabled
          ? tx.leadActivity.findMany({
              where: activityWhere,
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
            })
          : Promise.resolve([]),
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

type ActionFilter =
  | { kind: 'none' }
  | { kind: 'exact'; value: string }
  | { kind: 'prefix'; value: string };

/** Parse `?action=auth.*` / `?action=auth.login.success` / undefined. */
function parseActionFilter(action: string | undefined): ActionFilter {
  if (!action || action.trim().length === 0) return { kind: 'none' };
  const trimmed = action.trim();
  if (trimmed.endsWith('.*')) {
    const prefix = trimmed.slice(0, -1); // keep the trailing dot
    return { kind: 'prefix', value: prefix };
  }
  return { kind: 'exact', value: trimmed };
}
