import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { requireTenantId } from '../tenants/tenant-context';

/**
 * Round-robin assignment.
 *
 * "Eligible" agents are users in the active tenant whose status is
 * `active` and whose role is sales-facing (sales_agent or tl_sales).
 * The picker chooses the agent with the fewest *active* leads (i.e.
 * not in a terminal pipeline stage), tiebroken by user id for
 * determinism. Stateless — no per-tenant pointer to maintain — and
 * self-corrects when load distributions drift.
 *
 * `excludeUserIds` lets callers skip the lead's current assignee on a
 * reassignment so the same agent doesn't immediately get the breached
 * lead back; if the exclusion empties the candidate pool, the picker
 * returns null and the caller decides what to do (e.g. send to TL
 * unassigned queue — that lands when teams are introduced).
 */
@Injectable()
export class AssignmentService {
  private readonly logger = new Logger(AssignmentService.name);

  static readonly ELIGIBLE_ROLE_CODES = ['sales_agent', 'tl_sales'] as const;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Returns the next eligible user id by round-robin (lowest active-lead
   * load + lowest id tiebreaker). Returns null when the pool is empty.
   *
   * @param excludeUserIds optional ids to skip (e.g. the current assignee
   *   on a breach-driven reassignment).
   */
  async pickEligibleAgent(excludeUserIds: readonly string[] = []): Promise<string | null> {
    const tenantId = requireTenantId();

    return this.prisma.withTenant(tenantId, async (tx) => {
      const candidates = await tx.user.findMany({
        where: {
          status: 'active',
          role: { code: { in: [...AssignmentService.ELIGIBLE_ROLE_CODES] } },
          ...(excludeUserIds.length > 0 && { id: { notIn: [...excludeUserIds] } }),
        },
        select: {
          id: true,
          _count: {
            select: {
              assignedLeads: {
                where: { stage: { isTerminal: false } },
              },
            },
          },
        },
      });

      if (candidates.length === 0) return null;

      candidates.sort((a, b) => {
        const loadDiff = a._count.assignedLeads - b._count.assignedLeads;
        if (loadDiff !== 0) return loadDiff;
        return a.id.localeCompare(b.id);
      });

      return candidates[0]?.id ?? null;
    });
  }

  /**
   * Apply round-robin assignment to a lead. Returns the picked user id,
   * or null if no eligible agent was found (lead left as-is).
   *
   * The actual lead-update + activity-write is done in a single
   * transaction by the caller (LeadsService.assign or
   * SlaService.runReassignmentForBreaches) so the audit timeline never
   * drifts. This service only owns the *who* decision.
   */
  async assignLeadViaRoundRobin(opts: {
    tx: Prisma.TransactionClient;
    leadId: string;
    tenantId: string;
    excludeUserIds?: readonly string[];
    activityType: 'auto_assignment' | 'sla_breach';
    actorUserId?: string | null;
    body: string;
    payload: Record<string, unknown>;
  }): Promise<string | null> {
    const candidates = await opts.tx.user.findMany({
      where: {
        status: 'active',
        role: { code: { in: [...AssignmentService.ELIGIBLE_ROLE_CODES] } },
        ...(opts.excludeUserIds &&
          opts.excludeUserIds.length > 0 && { id: { notIn: [...opts.excludeUserIds] } }),
      },
      select: {
        id: true,
        _count: {
          select: {
            assignedLeads: { where: { stage: { isTerminal: false } } },
          },
        },
      },
    });

    if (candidates.length === 0) {
      this.logger.warn(`assignLeadViaRoundRobin: no eligible agents in tenant ${opts.tenantId}`);
      return null;
    }

    candidates.sort((a, b) => {
      const loadDiff = a._count.assignedLeads - b._count.assignedLeads;
      if (loadDiff !== 0) return loadDiff;
      return a.id.localeCompare(b.id);
    });

    const pickedId = candidates[0]?.id;
    if (!pickedId) return null;

    await opts.tx.lead.update({
      where: { id: opts.leadId },
      data: { assignedToId: pickedId },
    });
    await opts.tx.leadActivity.create({
      data: {
        tenantId: opts.tenantId,
        leadId: opts.leadId,
        type: opts.activityType,
        body: opts.body,
        payload: opts.payload as Prisma.InputJsonValue,
        createdById: opts.actorUserId ?? null,
      },
    });

    return pickedId;
  }
}
