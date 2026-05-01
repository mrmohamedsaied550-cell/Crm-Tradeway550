import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { requireTenantId } from '../tenants/tenant-context';
import type { ReportFiltersDto, TimeseriesQueryDto } from './report.dto';

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

export type TimeseriesMetric = 'leads_created' | 'activations' | 'first_trips';

export interface TimeseriesPoint {
  /** UTC date in `YYYY-MM-DD` form. */
  date: string;
  count: number;
}

export interface TimeseriesReport {
  metric: TimeseriesMetric;
  from: string;
  to: string;
  points: TimeseriesPoint[];
}

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Single-call summary used by /admin/reports. All counts are tenant-
   * scoped via RLS. Filters compose against the lead's assignee chain
   * (`assignedTo.team.country.companyId`):
   *
   *   - companyId only          → leads where assignee's team's
   *                               country belongs to that company
   *   - countryId only          → leads where assignee's team belongs
   *                               to that country (any company)
   *   - teamId only             → leads assigned to a user in that team
   *   - any combination         → AND of the above
   *
   * Captain-side counts (`activations`, `first_trips` timeseries)
   * filter on `Captain.teamId` directly when teamId is set; for
   * countryId / companyId we walk through the team's country.
   * Date range bounds `Lead.createdAt` for the funnel and
   * `Captain.activatedAt` for activations / `Captain.firstTripAt` for
   * first-trip metrics.
   */
  async summary(filters: ReportFiltersDto): Promise<SummaryReport> {
    const tenantId = requireTenantId();
    const now = new Date();
    const fromDate = filters.from ? new Date(filters.from) : undefined;
    const toDate = filters.to ? new Date(filters.to) : now;
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const endToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

    return this.prisma.withTenant(tenantId, async (tx) => {
      const leadScope = leadScopeWhere(filters);
      const captainScope = captainScopeWhere(filters);
      const followUpScope = followUpScopeWhere(filters);

      const createdRange: Prisma.LeadWhereInput = {
        ...(fromDate && { createdAt: { gte: fromDate, lte: toDate } }),
      };

      const baseLeadWhere: Prisma.LeadWhereInput = {
        ...leadScope,
        ...createdRange,
      };

      // Total leads + per-stage breakdown — scoped to the tenant's
      // default pipeline so the funnel stays consistent with the
      // pre-P2-07 contract.
      const defaultPipeline = await tx.pipeline.findFirst({
        where: { isDefault: true },
        select: { id: true },
      });
      const [totalLeads, grouped, stages] = await Promise.all([
        tx.lead.count({ where: baseLeadWhere }),
        tx.lead.groupBy({
          by: ['stageId'],
          where: baseLeadWhere,
          _count: { _all: true },
        }),
        tx.pipelineStage.findMany({
          where: defaultPipeline ? { pipelineId: defaultPipeline.id } : undefined,
          orderBy: { order: 'asc' },
          select: { id: true, code: true, name: true },
        }),
      ]);
      const leadsByStage = stages.map((s) => {
        const g = grouped.find((row) => row.stageId === s.id);
        return { stageCode: s.code, stageName: s.name, count: g ? g._count._all : 0 };
      });

      const [overdueCount, dueTodayCount] = await Promise.all([
        tx.lead.count({
          where: { ...leadScope, nextActionDueAt: { lt: now } },
        }),
        tx.lead.count({
          where: { ...leadScope, nextActionDueAt: { gte: startToday, lte: endToday } },
        }),
      ]);

      const [followUpsPending, followUpsDone] = await Promise.all([
        tx.leadFollowUp.count({
          where: {
            completedAt: null,
            ...(fromDate && { dueAt: { gte: fromDate, lte: toDate } }),
            ...followUpScope,
          },
        }),
        tx.leadFollowUp.count({
          where: {
            completedAt: { not: null },
            ...(fromDate && { completedAt: { gte: fromDate, lte: toDate } }),
            ...followUpScope,
          },
        }),
      ]);

      const activations = await tx.captain.count({
        where: {
          ...captainScope,
          ...(fromDate && { createdAt: { gte: fromDate, lte: toDate } }),
        },
      });

      const convertedCount = await tx.lead.count({
        where: { ...baseLeadWhere, stage: { code: 'converted' } },
      });
      const conversionRate =
        totalLeads === 0 ? null : Math.round((convertedCount / totalLeads) * 1000) / 10;

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
   * P2-11 — daily count time-series for one of the supported metrics.
   *
   * Returns one point per UTC day in the inclusive [from..to] range,
   * including zero-rows (so the chart x-axis is dense). The default
   * window when neither bound is supplied is the trailing 30 days.
   *
   * Implementation note: we group with `date_trunc` in JS by counting
   * raw rows, not via `$queryRaw`, to keep the RLS / Prisma `withTenant`
   * contract intact. The volumes here are tenant-bounded and the date
   * ranges admins pick are small — no need to push down to SQL.
   */
  async timeseries(query: TimeseriesQueryDto): Promise<TimeseriesReport> {
    const tenantId = requireTenantId();
    const now = new Date();
    const toDate = query.to ? new Date(query.to) : now;
    const fromDate = query.from
      ? new Date(query.from)
      : new Date(toDate.getTime() - 29 * 24 * 60 * 60 * 1000);

    return this.prisma.withTenant(tenantId, async (tx) => {
      const dates: Array<{ at: Date | null }> = [];
      switch (query.metric) {
        case 'leads_created': {
          const rows = await tx.lead.findMany({
            where: { ...leadScopeWhere(query), createdAt: { gte: fromDate, lte: toDate } },
            select: { createdAt: true },
          });
          for (const r of rows) dates.push({ at: r.createdAt });
          break;
        }
        case 'activations': {
          const rows = await tx.captain.findMany({
            where: { ...captainScopeWhere(query), createdAt: { gte: fromDate, lte: toDate } },
            select: { createdAt: true },
          });
          for (const r of rows) dates.push({ at: r.createdAt });
          break;
        }
        case 'first_trips': {
          const rows = await tx.captain.findMany({
            where: {
              ...captainScopeWhere(query),
              firstTripAt: { gte: fromDate, lte: toDate },
            },
            select: { firstTripAt: true },
          });
          for (const r of rows) dates.push({ at: r.firstTripAt });
          break;
        }
        default:
          break;
      }
      const points = bucketByDay(fromDate, toDate, dates);
      return {
        metric: query.metric,
        from: dayStartUtc(fromDate).toISOString(),
        to: dayStartUtc(toDate).toISOString(),
        points,
      };
    });
  }

  /**
   * P2-11 — flatten the summary + a leads_created series into a
   * single CSV blob. Header rows are commented (`#`) so a
   * spreadsheet import keeps the data section clean.
   */
  async exportCsv(filters: ReportFiltersDto): Promise<string> {
    const summary = await this.summary(filters);
    const series = await this.timeseries({ ...filters, metric: 'leads_created' });
    const lines: string[] = [];
    lines.push('# Trade Way / Captain Masr CRM — report export');
    lines.push(`# generated_at,${new Date().toISOString()}`);
    lines.push(`# from,${filters.from ?? ''}`);
    lines.push(`# to,${filters.to ?? ''}`);
    lines.push(`# companyId,${filters.companyId ?? ''}`);
    lines.push(`# countryId,${filters.countryId ?? ''}`);
    lines.push(`# teamId,${filters.teamId ?? ''}`);
    lines.push('');
    lines.push('section,key,value');
    lines.push(`summary,total_leads,${summary.totalLeads}`);
    lines.push(`summary,overdue,${summary.overdueCount}`);
    lines.push(`summary,due_today,${summary.dueTodayCount}`);
    lines.push(`summary,followups_pending,${summary.followUpsPending}`);
    lines.push(`summary,followups_done,${summary.followUpsDone}`);
    lines.push(`summary,activations,${summary.activations}`);
    lines.push(`summary,conversion_rate,${summary.conversionRate ?? ''}`);
    for (const s of summary.leadsByStage) {
      lines.push(`stage,${csvEscape(s.stageCode)},${s.count}`);
    }
    for (const p of series.points) {
      lines.push(`leads_created,${p.date},${p.count}`);
    }
    return lines.join('\n') + '\n';
  }
}

// ───────────────────────────────────────────────────────────────────
// where-clause helpers
// ───────────────────────────────────────────────────────────────────

/**
 * Build a `Lead.where` fragment from the filters. Filters compose:
 * the lead's `assignedTo.team` is the join shaft, and we layer
 * `teamId` / `countryId` / `companyId` predicates on top.
 *
 * When ANY filter is present we exclude leads with no assignee (we
 * can't attribute them); the manager UX expects scope-or-nothing.
 */
function leadScopeWhere(filters: {
  companyId?: string;
  countryId?: string;
  teamId?: string;
}): Prisma.LeadWhereInput {
  const teamWhere = teamWhereFromFilters(filters);
  if (!teamWhere) return {};
  return { assignedTo: { team: teamWhere } };
}

function captainScopeWhere(filters: {
  companyId?: string;
  countryId?: string;
  teamId?: string;
}): Prisma.CaptainWhereInput {
  const teamWhere = teamWhereFromFilters(filters);
  if (!teamWhere) return {};
  return { team: teamWhere };
}

function followUpScopeWhere(filters: {
  companyId?: string;
  countryId?: string;
  teamId?: string;
}): Prisma.LeadFollowUpWhereInput {
  const teamWhere = teamWhereFromFilters(filters);
  if (!teamWhere) return {};
  return { lead: { assignedTo: { team: teamWhere } } };
}

function teamWhereFromFilters(filters: {
  companyId?: string;
  countryId?: string;
  teamId?: string;
}): Prisma.TeamWhereInput | null {
  if (!filters.teamId && !filters.countryId && !filters.companyId) return null;
  const w: Prisma.TeamWhereInput = {};
  if (filters.teamId) w.id = filters.teamId;
  if (filters.countryId) w.countryId = filters.countryId;
  if (filters.companyId) w.country = { companyId: filters.companyId };
  return w;
}

// ───────────────────────────────────────────────────────────────────
// time-series helpers
// ───────────────────────────────────────────────────────────────────

function dayStartUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
}

function dayKey(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function bucketByDay(from: Date, to: Date, rows: Array<{ at: Date | null }>): TimeseriesPoint[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (!r.at) continue;
    const key = dayKey(r.at);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const out: TimeseriesPoint[] = [];
  let cursor = dayStartUtc(from).getTime();
  const end = dayStartUtc(to).getTime();
  while (cursor <= end) {
    const key = dayKey(new Date(cursor));
    out.push({ date: key, count: counts.get(key) ?? 0 });
    cursor += 24 * 60 * 60 * 1000;
  }
  return out;
}

function csvEscape(s: string): string {
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
