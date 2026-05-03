import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { dayBoundsInTimezone } from '../crm/time.util';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { requireTenantId } from '../tenants/tenant-context';
import { TenantSettingsService } from '../tenants/tenant-settings.service';
import type {
  CalendarFollowUpsQueryDto,
  CreateFollowUpDto,
  ListMyFollowUpsQueryDto,
  UpdateFollowUpDto,
} from './follow-up.dto';

@Injectable()
export class FollowUpsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    /**
     * Phase A — A5: the summary endpoint computes "due today" in
     * the tenant's IANA timezone (Africa/Cairo, Asia/Riyadh, …).
     * `Optional`-injected only to keep the type lean; production
     * wiring (FollowUpsModule) always provides it.
     */
    private readonly tenantSettings: TenantSettingsService,
  ) {}

  /**
   * Recompute the lead's `nextActionDueAt` denormalised column to
   * the soonest *effective* due time across pending (not-completed)
   * follow-ups, or null when none remain.
   *
   * Phase A — A5: "effective due" accounts for snooze. A row whose
   * `snoozedUntil > dueAt` is considered due at `snoozedUntil`
   * instead of `dueAt`. This keeps the lead's "next action" pointer
   * accurate without needing a scheduler to clear it when a snooze
   * passes (the row simply stops being snoozed and its dueAt wins
   * again on the next recompute trigger — but most agents will
   * complete or re-snooze before that happens anyway).
   *
   * The query fetches every pending row and computes in JS — most
   * leads have single-digit follow-ups so the cost is negligible
   * and Prisma can't express `MAX(dueAt, snoozedUntil)` natively
   * without raw SQL.
   *
   * Called inside the same transaction as the triggering mutation
   * so the column never lags behind reality. Triggers: create,
   * complete, delete, snooze.
   */
  private async recomputeNextActionDueAt(
    tx: Prisma.TransactionClient,
    leadId: string,
  ): Promise<void> {
    const pending = await tx.leadFollowUp.findMany({
      where: { leadId, completedAt: null },
      select: { dueAt: true, snoozedUntil: true },
    });
    let earliest: Date | null = null;
    for (const row of pending) {
      const eff =
        row.snoozedUntil && row.snoozedUntil.getTime() > row.dueAt.getTime()
          ? row.snoozedUntil
          : row.dueAt;
      if (!earliest || eff.getTime() < earliest.getTime()) earliest = eff;
    }
    await tx.lead.update({
      where: { id: leadId },
      data: { nextActionDueAt: earliest ?? null },
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

  /**
   * P3-04 — month/week calendar feed. Returns every follow-up
   * (pending OR completed) inside `[from, to]` for the calling user
   * by default, or for the entire tenant when the caller requested
   * `mine='0'` (the controller already gated that on a manage
   * capability). Joins the lead's name + phone so the calendar can
   * label each event without an extra round-trip.
   */
  async listInRange(
    callingUserId: string,
    query: CalendarFollowUpsQueryDto & { allowAllAssignees: boolean },
  ) {
    const tenantId = requireTenantId();
    const from = new Date(query.from);
    const to = new Date(query.to);
    const restrictToCaller = query.mine === '1' || !query.allowAllAssignees;
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.leadFollowUp.findMany({
        where: {
          dueAt: { gte: from, lte: to },
          ...(restrictToCaller && { assignedToId: callingUserId }),
        },
        orderBy: [{ dueAt: 'asc' }],
        take: query.limit,
        include: { lead: { select: { id: true, name: true, phone: true } } },
      }),
    );
  }

  async listMine(userId: string, query: ListMyFollowUpsQueryDto) {
    const tenantId = requireTenantId();
    const now = new Date();
    // Phase A — A5: a row whose `snoozedUntil > now` is hidden from
    // both `pending` and `overdue` lists. Once the snooze passes,
    // the row reappears at its original `dueAt`.
    const notSnoozed = {
      OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: now } }],
    } satisfies Prisma.LeadFollowUpWhereInput;
    return this.prisma.withTenant(tenantId, (tx) => {
      const base = { assignedToId: userId };
      const where =
        query.status === 'done'
          ? { ...base, completedAt: { not: null } }
          : query.status === 'overdue'
            ? { ...base, completedAt: null, dueAt: { lt: now }, ...notSnoozed }
            : query.status === 'all'
              ? base
              : /* pending */ { ...base, completedAt: null, ...notSnoozed };
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

  /**
   * Phase A — A5: bell-badge counters for the calling user.
   *
   *   • `overdueCount` — pending, NOT snoozed-into-future, dueAt < now.
   *   • `dueTodayCount` — pending, NOT snoozed-into-future, dueAt
   *      lands inside today's tenant-timezone window. The same
   *      `dayBoundsInTimezone` helper used elsewhere; ensures Cairo
   *      and Riyadh agents see "today" matching their wall clock.
   *
   * Cheap two-COUNT(*) per request — the `(tenant_id, assignedToId,
   * completedAt, dueAt)` index from C37 covers both predicates.
   */
  async summaryForUser(userId: string): Promise<{
    overdueCount: number;
    dueTodayCount: number;
  }> {
    const tenantId = requireTenantId();
    const now = new Date();
    const settings = await this.tenantSettings.getCurrent();
    const today = dayBoundsInTimezone(now, settings.timezone);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const notSnoozed = {
        OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: now } }],
      } satisfies Prisma.LeadFollowUpWhereInput;
      const baseActive: Prisma.LeadFollowUpWhereInput = {
        assignedToId: userId,
        completedAt: null,
        ...notSnoozed,
      };
      const [overdueCount, dueTodayCount] = await Promise.all([
        tx.leadFollowUp.count({ where: { ...baseActive, dueAt: { lt: now } } }),
        tx.leadFollowUp.count({
          where: { ...baseActive, dueAt: { gte: today.start, lte: today.end } },
        }),
      ]);
      return { overdueCount, dueTodayCount };
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
      // P2-02 — notify the new owner if they aren't the same person who
      // scheduled the follow-up. Self-scheduling shouldn't bell.
      if (assignedToId && assignedToId !== actorUserId) {
        await this.notifications.createInTx(tx, tenantId, {
          recipientUserId: assignedToId,
          kind: 'followup.assigned',
          title: `New follow-up scheduled (${created.actionType})`,
          body: `Due ${created.dueAt.toISOString()}`,
          payload: { leadId, followUpId: created.id, dueAt: created.dueAt.toISOString() },
        });
      }
      return created;
    });
  }

  /**
   * Phase A — A5: snooze (or un-snooze) a pending follow-up.
   *
   * `snoozedUntil` payload semantics:
   *   • ISO datetime in the future → push the row out of the
   *     active / overdue / due-today windows until that moment.
   *   • `null` → clear an existing snooze (the row's original
   *     dueAt becomes effective again).
   *
   * Guards:
   *   • The row must exist + be in the active tenant (RLS-checked).
   *   • A non-null `snoozedUntil` must be strictly in the future —
   *     snoozing into the past is rejected with
   *     `follow_up.snoozed_in_past`.
   *   • Completing then snoozing is a no-op on snoozedUntil — the
   *     completed flag wins; we still write the column for symmetry
   *     but the row is hidden from active views by completion.
   *
   * Side-effects:
   *   • Recomputes `Lead.nextActionDueAt` (effective-due aware).
   *   • Audit row written with `followup.snooze` action.
   *   • No notification — snooze is a self-action that doesn't
   *     change ownership.
   */
  async update(id: string, dto: UpdateFollowUpDto, actorUserId: string | null = null) {
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

      const data: Prisma.LeadFollowUpUncheckedUpdateInput = {};
      if (dto.snoozedUntil !== undefined) {
        if (dto.snoozedUntil === null) {
          data.snoozedUntil = null;
        } else {
          const t = new Date(dto.snoozedUntil);
          if (t.getTime() <= Date.now()) {
            throw new BadRequestException({
              code: 'follow_up.snoozed_in_past',
              message: 'snoozedUntil must be a future timestamp',
            });
          }
          data.snoozedUntil = t;
        }
      }

      const updated = await tx.leadFollowUp.update({ where: { id }, data });
      await this.recomputeNextActionDueAt(tx, row.leadId);
      await this.audit.writeInTx(tx, tenantId, {
        action: 'followup.snooze',
        entityType: 'lead_followup',
        entityId: id,
        actorUserId,
        payload: {
          leadId: row.leadId,
          snoozedUntil: updated.snoozedUntil ? updated.snoozedUntil.toISOString() : null,
        },
      });
      return updated;
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
