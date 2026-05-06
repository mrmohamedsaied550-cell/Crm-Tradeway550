import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { serializeCsv } from '../rbac/csv-serializer';
import { REDACTION_FIELD_KEY, type StructuredExport } from '../rbac/export-contract';
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
   * @deprecated D5.6C — kept as a thin shim around
   * `buildStructuredExport(...)` so any internal caller compiled
   * against the old signature still works. Production callers
   * route through the controller which now returns the
   * structured shape directly to the ExportInterceptor; this
   * method survives only to keep existing test fixtures /
   * imports compiling. A later cleanup chunk can delete it.
   */
  async exportCsv(filters: ReportFiltersDto): Promise<string> {
    const structured = await this.buildStructuredExport(filters);
    return serializeCsv(structured);
  }

  /**
   * D5.6C — structured export builder for the manager-dashboard
   * reports CSV. Returns the section/key/value variant
   * (`format: 'csv-keyvalue'`) with each row carrying a private
   * `__field` metadata that anchors the row to a specific
   * catalogue field on the `report` resource:
   *
   *   summary,total_leads     → report.summary.totalLeads
   *   summary,overdue         → report.summary.overdue
   *   summary,due_today       → report.summary.dueToday
   *   summary,followups_pending → report.summary.followupsPending
   *   summary,followups_done  → report.summary.followupsDone
   *   summary,activations     → report.summary.activations  (sensitive — commercial)
   *   summary,conversion_rate → report.summary.conversionRate (sensitive — commercial)
   *   stage,<stageCode>       → report.stageBuckets       (group)
   *   leads_created,<date>    → report.leadsCreatedTimeseries (group)
   *
   * The redactor (`csv-keyvalue` branch in
   * `ExportRedactionService`) drops rows whose `__field` appears
   * in the role's deny list. So a Finance-vs-non-Finance role
   * can hide `summary.activations` AND `summary.conversionRate`
   * while keeping the rest, and an audit-only role can hide the
   * whole `leadsCreatedTimeseries` group.
   *
   * Byte-equality with the legacy `exportCsv` output is pinned
   * by golden-file tests in `d5-6c-reports-export.test.ts` —
   * comments, the empty separator line, the `section,key,value`
   * header, the integer-vs-empty-conversion-rate formatting, and
   * the trailing newline are all preserved.
   */
  async buildStructuredExport(filters: ReportFiltersDto): Promise<StructuredExport> {
    const summary = await this.summary(filters);
    const series = await this.timeseries({ ...filters, metric: 'leads_created' });

    const rows: Record<string, unknown>[] = [
      this.row('summary', 'total_leads', summary.totalLeads, 'summary.totalLeads'),
      this.row('summary', 'overdue', summary.overdueCount, 'summary.overdue'),
      this.row('summary', 'due_today', summary.dueTodayCount, 'summary.dueToday'),
      this.row(
        'summary',
        'followups_pending',
        summary.followUpsPending,
        'summary.followupsPending',
      ),
      this.row('summary', 'followups_done', summary.followUpsDone, 'summary.followupsDone'),
      this.row('summary', 'activations', summary.activations, 'summary.activations'),
      this.row(
        'summary',
        'conversion_rate',
        summary.conversionRate ?? '',
        'summary.conversionRate',
      ),
    ];

    for (const s of summary.leadsByStage) {
      rows.push(this.row('stage', s.stageCode, s.count, 'stageBuckets'));
    }
    for (const p of series.points) {
      rows.push(this.row('leads_created', p.date, p.count, 'leadsCreatedTimeseries'));
    }

    return {
      format: 'csv-keyvalue',
      filename: `crm-report-${new Date().toISOString().slice(0, 10)}.csv`,
      comments: [
        '# Trade Way / Captain Masr CRM — report export',
        `# generated_at,${new Date().toISOString()}`,
        `# from,${filters.from ?? ''}`,
        `# to,${filters.to ?? ''}`,
        `# companyId,${filters.companyId ?? ''}`,
        `# countryId,${filters.countryId ?? ''}`,
        `# teamId,${filters.teamId ?? ''}`,
        '',
      ],
      // The three columns are structural anchors. They are
      // declared with `redactable: false` so an admin can never
      // strip the `section`/`key`/`value` columns themselves —
      // redaction in csv-keyvalue is row-level (drop a metric)
      // not column-level (drop a column).
      columns: [
        {
          key: 'section',
          label: 'section',
          resource: 'report',
          field: '_meta',
          redactable: false,
        },
        { key: 'key', label: 'key', resource: 'report', field: '_meta', redactable: false },
        {
          key: 'value',
          label: 'value',
          resource: 'report',
          field: '_meta',
          redactable: false,
        },
      ],
      rows,
      // Match the legacy `lines.join('\n') + '\n'` byte
      // convention so a flag-off run is byte-identical to D5.5
      // output.
      trailingNewline: true,
    };
  }

  private row(
    section: string,
    key: string,
    value: number | string,
    field: string,
  ): Record<string, unknown> {
    return {
      section,
      key,
      value,
      [REDACTION_FIELD_KEY]: field,
    };
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
