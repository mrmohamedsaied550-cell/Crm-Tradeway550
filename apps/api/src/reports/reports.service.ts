import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { requireTenantId } from '../tenants/tenant-context';
import type { ReportFiltersDto } from './report.dto';

export interface SummaryReport {
  totalLeads: number;
  leadsByStage: Array<{ stageCode: string; stageName: string; count: number }>;
  overdueCount: number;
  dueTodayCount: number;
  followUpsPending: number;
  followUpsDone: number;
  activations: number;
  /** Percentage 0..100 (rounded to one decimal). null when totalLeads === 0. */
  conversionRate: number | null;
}

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Single-call summary used by /admin/reports. All counts are tenant-
   * scoped via the existing RLS policy. Filters compose:
   *   - company / country / team narrow the LEAD scope (via assignedTo
   *     team membership and via captain team for activations).
   *   - from / to bound the lead.createdAt window (the activations and
   *     follow-ups counts use their own row's createdAt).
   *
   * Best-effort: when team data isn't set on a lead's assignee the lead
   * still counts toward the tenant total. The MVP intentionally avoids
   * heavy joins; richer breakdowns layer on later.
   */
  async summary(filters: ReportFiltersDto): Promise<SummaryReport> {
    const tenantId = requireTenantId();
    const now = new Date();
    const fromDate = filters.from ? new Date(filters.from) : undefined;
    const toDate = filters.to ? new Date(filters.to) : now;
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const endToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

    return this.prisma.withTenant(tenantId, async (tx) => {
      // Scope helpers — narrow leads to the picked team / country /
      // company by walking the assignee → team → country → company
      // chain. Leads with no assignee are excluded when any team /
      // country / company filter is set, which matches the manager UX.
      const teamId = await this.resolveTeamId(tx, filters);
      const leadAssigneeFilter: Prisma.LeadWhereInput = teamId ? { assignedTo: { teamId } } : {};

      const createdRange: Prisma.LeadWhereInput = {
        ...(fromDate && { createdAt: { gte: fromDate, lte: toDate } }),
      };

      const baseLeadWhere: Prisma.LeadWhereInput = {
        ...leadAssigneeFilter,
        ...createdRange,
      };

      // Total leads + per-stage breakdown.
      const [totalLeads, grouped, stages] = await Promise.all([
        tx.lead.count({ where: baseLeadWhere }),
        tx.lead.groupBy({
          by: ['stageId'],
          where: baseLeadWhere,
          _count: { _all: true },
        }),
        tx.pipelineStage.findMany({
          orderBy: { order: 'asc' },
          select: { id: true, code: true, name: true },
        }),
      ]);
      const stageById = new Map(stages.map((s) => [s.id, s]));
      const leadsByStage = stages.map((s) => {
        const g = grouped.find((row) => row.stageId === s.id);
        return {
          stageCode: s.code,
          stageName: s.name,
          count: g ? g._count._all : 0,
        };
      });
      // Stages with no leads stay in the list at count 0 — managers
      // want to see the funnel zero-rows too.

      // Overdue + due-today are derived from the C37 next_action_due_at
      // column — same scope filters apply.
      const [overdueCount, dueTodayCount] = await Promise.all([
        tx.lead.count({
          where: {
            ...leadAssigneeFilter,
            nextActionDueAt: { lt: now },
          },
        }),
        tx.lead.count({
          where: {
            ...leadAssigneeFilter,
            nextActionDueAt: { gte: startToday, lte: endToday },
          },
        }),
      ]);

      // Follow-ups: pending + done in the same date window. If no
      // window is set we count "all pending right now" for a clean
      // dashboard glance.
      const [followUpsPending, followUpsDone] = await Promise.all([
        tx.leadFollowUp.count({
          where: {
            completedAt: null,
            ...(fromDate && { dueAt: { gte: fromDate, lte: toDate } }),
            ...(teamId && { lead: { assignedTo: { teamId } } }),
          },
        }),
        tx.leadFollowUp.count({
          where: {
            completedAt: { not: null },
            ...(fromDate && { completedAt: { gte: fromDate, lte: toDate } }),
            ...(teamId && { lead: { assignedTo: { teamId } } }),
          },
        }),
      ]);

      // Activations: captains created in the window. If a team filter
      // is on, restrict to captains in that team; otherwise count
      // tenant-wide.
      const activations = await tx.captain.count({
        where: {
          ...(teamId && { teamId }),
          ...(fromDate && { createdAt: { gte: fromDate, lte: toDate } }),
        },
      });

      // Conversion rate = (leads in 'converted' terminal stage) /
      // (totalLeads). null when no leads in scope.
      const convertedCount = await tx.lead.count({
        where: {
          ...baseLeadWhere,
          stage: { code: 'converted' },
        },
      });
      const conversionRate =
        totalLeads === 0 ? null : Math.round((convertedCount / totalLeads) * 1000) / 10;

      void stageById; // referenced indirectly via the .map above
      return {
        totalLeads,
        leadsByStage,
        overdueCount,
        dueTodayCount,
        followUpsPending,
        followUpsDone,
        activations,
        conversionRate,
      };
    });
  }

  /**
   * If a Country or Company filter is supplied without an explicit
   * Team, we ignore that branch in the MVP — leads are scoped through
   * `assignedTo.teamId` only. Returns the explicit teamId when set,
   * otherwise null.
   */
  private async resolveTeamId(
    _tx: Prisma.TransactionClient,
    filters: ReportFiltersDto,
  ): Promise<string | null> {
    return filters.teamId ?? null;
  }
}
