import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { LeadReviewService } from '../crm/lead-review.service';
import { ScopeContextService, type ScopeUserClaims } from '../rbac/scope-context.service';
import { requireTenantId } from '../tenants/tenant-context';
import { AuditService } from '../audit/audit.service';

/**
 * Phase D4 — D4.6: PartnerReconciliationService.
 *
 * Pure derived view over the existing snapshot + CRM rows. NO new
 * table — discrepancies are computed on read so a fresh sync
 * always reflects in the next read without a backfill (per the
 * locked product decision in the D4 plan §16).
 *
 * Five categories implemented in D4.6:
 *   • partner_missing               — CRM is won/active but no matching
 *                                     partner record OR partner_status
 *                                     is non-active.
 *   • partner_active_not_in_crm     — partner says active but the
 *                                     contact has no won lead /
 *                                     captain.
 *   • partner_date_mismatch         — captain.activatedAt ≠
 *                                     partner.partnerActiveDate.
 *   • partner_dft_mismatch          — captain.dftAt ≠
 *                                     partner.partnerDftDate.
 *   • partner_trips_mismatch        — captain.tripCount ≠
 *                                     partner.tripCount. READ-ONLY
 *                                     warning — never writes
 *                                     captain.tripCount or
 *                                     CaptainTrip.
 *
 * `commission_risk` is intentionally omitted in D4.6 — it depends
 * on the milestone configs that ship in D4.7. Operators see an
 * empty result for that category until then.
 *
 * Scope:
 *   • Sources are filtered to active rows in the caller's
 *     (companyId, countryId) scope.
 *   • Lead-keyed rows go through `ScopeContextService.resolveLeadScope`
 *     so a TL on EG-Uber doesn't see KSA-inDrive discrepancies.
 *   • The `partner_active_not_in_crm` category is the only one
 *     that can have NO leadId (the contact may not exist as a
 *     CRM lead). Those rows surface for Ops/AM only — the
 *     scope-aware list intentionally excludes them when the
 *     caller has no broader scope, since there's no lead to
 *     "open as review" against.
 *
 * Performance:
 *   • For each active partner source we run a bounded query
 *     (`take`) and stitch CRM context on the fly. The bounds keep
 *     the report cheap on first ship; if reconciliation grows
 *     past ~50k rows per source, materialising into a
 *     `partner_discrepancies` table becomes the next step (D4
 *     plan §23).
 */
@Injectable()
export class PartnerReconciliationService {
  /** Default cap per category to keep the JSON response bounded.
   *  Operators that need everything export to CSV. */
  private static readonly DEFAULT_LIMIT = 200;
  private static readonly MAX_LIMIT = 1000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly leadReviews: LeadReviewService,
    private readonly scopeContext: ScopeContextService,
  ) {}

  /**
   * Compute discrepancies. Returns the items + total per category
   * so the UI can show counts on the chip filter without a second
   * round-trip.
   */
  async list(
    filters: ReconciliationFilters,
    userClaims: ScopeUserClaims,
  ): Promise<ReconciliationResult> {
    const tenantId = requireTenantId();
    const limit = Math.min(
      Math.max(filters.limit ?? PartnerReconciliationService.DEFAULT_LIMIT, 1),
      PartnerReconciliationService.MAX_LIMIT,
    );
    const sources = await this.listVisibleSources(tenantId, filters);
    if (sources.length === 0) {
      return { items: [], counts: emptyCounts(), generatedAt: new Date().toISOString() };
    }

    const scopeWhere = (await this.scopeContext.resolveLeadScope(userClaims)).where;

    const all: ReconciliationItem[] = [];
    for (const source of sources) {
      const records = await this.loadLatestRecordsForSource(tenantId, source.id, limit * 4);
      const phones = Array.from(
        new Set(records.map((r) => r.phone).filter((p): p is string => !!p)),
      );
      const contactsByPhone = await this.lookupContacts(tenantId, phones);
      const leadsByContactId = await this.lookupLeadsForContacts(
        tenantId,
        Array.from(new Set([...contactsByPhone.values()].map((c) => c.id))),
        scopeWhere,
      );

      // 1. Per-record categories (mismatch + active-not-in-crm).
      for (const record of records) {
        if (!record.phone) continue;
        const contact = contactsByPhone.get(record.phone);
        const lead = contact ? leadsByContactId.get(contact.id) : undefined;
        const captain = lead?.captain ?? null;
        const partnerActive = (record.partnerStatus ?? '').toLowerCase() === 'active';

        // partner_active_not_in_crm
        if (partnerActive) {
          const crmActive =
            !!captain || lead?.lifecycleState === 'won' || lead?.stage.terminalKind === 'won';
          if (!crmActive) {
            all.push({
              category: 'partner_active_not_in_crm',
              partnerSourceId: source.id,
              partnerSourceName: source.displayName,
              leadId: lead?.id ?? null,
              captainId: null,
              contactId: contact?.id ?? null,
              phone: record.phone,
              crmName: lead?.name ?? null,
              crmStage: lead?.stage.code ?? null,
              crmLifecycleState: lead?.lifecycleState ?? null,
              crmActiveDate: null,
              crmDftDate: null,
              crmTripCount: null,
              partnerStatus: record.partnerStatus,
              partnerActiveDate: record.partnerActiveDate,
              partnerDftDate: record.partnerDftDate,
              partnerTripCount: record.tripCount,
              lastSyncAt: source.lastSyncAt,
              severity: 'warning',
              recommendedAction: lead ? 'review_or_convert' : 'investigate_partner_or_create_lead',
            });
          }
        }

        // Date / DFT / trips mismatch — only meaningful when a
        // captain exists.
        if (captain && lead) {
          if (
            record.partnerActiveDate &&
            captain.activatedAt &&
            !sameDay(record.partnerActiveDate, captain.activatedAt)
          ) {
            all.push(buildItem(source, record, lead, captain, 'partner_date_mismatch', 'warning'));
          }
          if (
            record.partnerDftDate &&
            captain.dftAt &&
            !sameDay(record.partnerDftDate, captain.dftAt)
          ) {
            all.push(buildItem(source, record, lead, captain, 'partner_dft_mismatch', 'warning'));
          }
          if (typeof record.tripCount === 'number' && record.tripCount !== captain.tripCount) {
            all.push(buildItem(source, record, lead, captain, 'partner_trips_mismatch', 'info'));
          }
        }
      }

      // 2. partner_missing — sweep CRM-side won/captain leads in
      // scope and flag those whose contact has no record (or only
      // a non-active record) in the latest snapshot for THIS source.
      const missing = await this.computePartnerMissing(tenantId, source, records, scopeWhere);
      all.push(...missing);
    }

    // Apply category filter + counts + final cap.
    const countsAll = countByCategory(all);
    const filtered = filters.category ? all.filter((i) => i.category === filters.category) : all;
    return {
      items: filtered.slice(0, limit),
      counts: countsAll,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * CSV export — all items in the requested category (or all
   * categories when omitted), no pagination cap. Uses the same
   * computation as `list` but skips the slice. Operators that
   * need a different cohort filter via the same query params.
   */
  async exportCsv(filters: ReconciliationFilters, userClaims: ScopeUserClaims): Promise<string> {
    const result = await this.list(
      { ...filters, limit: PartnerReconciliationService.MAX_LIMIT },
      userClaims,
    );
    const lines: string[] = [];
    lines.push(`# Trade Way / Captain Masr CRM — partner reconciliation export`);
    lines.push(`# generated: ${result.generatedAt}`);
    if (filters.partnerSourceId) lines.push(`# partnerSourceId: ${filters.partnerSourceId}`);
    if (filters.category) lines.push(`# category: ${filters.category}`);
    lines.push(
      [
        'category',
        'partner_source',
        'phone',
        'crm_name',
        'crm_stage',
        'crm_lifecycle',
        'crm_active_date',
        'crm_dft_date',
        'crm_trip_count',
        'partner_status',
        'partner_active_date',
        'partner_dft_date',
        'partner_trip_count',
        'last_sync_at',
        'severity',
        'lead_id',
        'captain_id',
      ].join(','),
    );
    for (const item of result.items) {
      lines.push(
        [
          item.category,
          csvEscape(item.partnerSourceName),
          csvEscape(item.phone),
          csvEscape(item.crmName ?? ''),
          csvEscape(item.crmStage ?? ''),
          csvEscape(item.crmLifecycleState ?? ''),
          csvEscape(item.crmActiveDate ? item.crmActiveDate.toISOString() : ''),
          csvEscape(item.crmDftDate ? item.crmDftDate.toISOString() : ''),
          item.crmTripCount?.toString() ?? '',
          csvEscape(item.partnerStatus ?? ''),
          csvEscape(item.partnerActiveDate ? item.partnerActiveDate.toISOString() : ''),
          csvEscape(item.partnerDftDate ? item.partnerDftDate.toISOString() : ''),
          item.partnerTripCount?.toString() ?? '',
          csvEscape(item.lastSyncAt ? item.lastSyncAt.toISOString() : ''),
          item.severity,
          item.leadId ?? '',
          item.captainId ?? '',
        ].join(','),
      );
    }
    return lines.join('\n');
  }

  /**
   * Promote a discrepancy into the existing TL Review Queue.
   *
   * Idempotent: `LeadReviewService.raiseReview` dedups on
   * `(lead, reason, open)` so multiple opens against the same
   * lead+category fold into one row.
   */
  async openReview(
    input: {
      category: ReconciliationCategory;
      leadId: string;
      partnerSourceId: string;
      partnerRecordId?: string;
      notes?: string;
      actorUserId: string;
    },
    userClaims: ScopeUserClaims,
  ): Promise<{ reviewId: string; alreadyOpen: boolean }> {
    const tenantId = requireTenantId();
    if (!RECONCILIATION_CATEGORIES.has(input.category)) {
      throw new BadRequestException({
        code: 'partner.reconciliation.invalid_category',
        message: `Unknown reconciliation category: ${input.category}`,
      });
    }
    if (input.category === 'partner_active_not_in_crm' && !input.leadId) {
      // Sanity belt-and-braces — schema-side leadId is required, but
      // surface a typed error rather than a Prisma FK failure.
      throw new BadRequestException({
        code: 'partner.reconciliation.no_lead',
        message: 'Cannot open a review without a lead. Create or link a lead first.',
      });
    }

    // Lead-scope check — the controller capability gate is
    // partner.reconciliation.resolve, but the lead must still
    // be visible to the caller.
    const scopeWhere = (await this.scopeContext.resolveLeadScope(userClaims)).where;
    const lead = await this.prisma.withTenant(tenantId, (tx) => {
      const where: Prisma.LeadWhereInput = scopeWhere
        ? { AND: [{ id: input.leadId, tenantId }, scopeWhere] }
        : { id: input.leadId, tenantId };
      return tx.lead.findFirst({ where, select: { id: true } });
    });
    if (!lead) {
      throw new NotFoundException({
        code: 'lead.not_found',
        message: `Lead not found: ${input.leadId}`,
      });
    }

    // Build a structured payload that pins the reviewer to the
    // exact partner record they were looking at when they opened
    // this. The future LeadReviewCard renderer already understands
    // structured `reasonPayload`.
    const reasonPayload: Prisma.InputJsonValue = {
      partnerSourceId: input.partnerSourceId,
      ...(input.partnerRecordId && { partnerRecordId: input.partnerRecordId }),
      category: input.category,
      ...(input.notes && { notes: input.notes }),
    } as Prisma.InputJsonValue;

    const result = await this.leadReviews.raiseReview({
      leadId: input.leadId,
      reason: input.category,
      reasonPayload,
      actorUserId: input.actorUserId,
    });

    // Audit verb dedicated to reconciliation — the lead-review
    // service already writes `lead.review.raised` for the
    // queue-side audit; this row is the Ops-side handle so the
    // /admin/audit chip filter for reconciliation activity
    // doesn't bleed into the TL queue's normal flow.
    await this.audit.writeEvent({
      action: 'partner.reconciliation.review_opened',
      entityType: 'lead_review',
      entityId: result.id,
      actorUserId: input.actorUserId,
      payload: {
        leadId: input.leadId,
        partnerSourceId: input.partnerSourceId,
        category: input.category,
        alreadyOpen: result.alreadyOpen,
      } as Prisma.InputJsonValue,
    });

    return { reviewId: result.id, alreadyOpen: result.alreadyOpen };
  }

  // ─── helpers ──────────────────────────────────────────────────

  private async listVisibleSources(
    tenantId: string,
    filters: ReconciliationFilters,
  ): Promise<SourceRow[]> {
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.partnerSource.findMany({
        where: {
          tenantId,
          isActive: true,
          ...(filters.partnerSourceId && { id: filters.partnerSourceId }),
          ...(filters.companyId && { companyId: filters.companyId }),
          ...(filters.countryId && { countryId: filters.countryId }),
        },
        select: {
          id: true,
          displayName: true,
          partnerCode: true,
          companyId: true,
          countryId: true,
          lastSyncAt: true,
        },
        orderBy: { displayName: 'asc' },
      }),
    ) as unknown as Promise<SourceRow[]>;
  }

  private async loadLatestRecordsForSource(
    tenantId: string,
    sourceId: string,
    take: number,
  ): Promise<RecordRow[]> {
    // Latest record per phone in this source's success/partial
    // snapshots. We do NOT try to do a true GROUP BY here — Prisma
    // 5 + Postgres can't easily express "row corresponding to
    // MAX(createdAt) per phone" without raw SQL. Instead we order
    // newest first and dedup in JS; `take` keeps it bounded.
    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.partnerRecord.findMany({
        where: {
          tenantId,
          partnerSourceId: sourceId,
          phone: { not: null },
          snapshot: { status: { in: ['success', 'partial'] } },
        },
        orderBy: { createdAt: 'desc' },
        take,
        select: {
          id: true,
          phone: true,
          partnerStatus: true,
          partnerActiveDate: true,
          partnerDftDate: true,
          tripCount: true,
          lastTripAt: true,
          createdAt: true,
        },
      }),
    );
    const seen = new Set<string>();
    const out: RecordRow[] = [];
    for (const r of rows) {
      if (!r.phone || seen.has(r.phone)) continue;
      seen.add(r.phone);
      out.push(r as RecordRow);
    }
    return out;
  }

  private async lookupContacts(
    tenantId: string,
    phones: string[],
  ): Promise<Map<string, { id: string }>> {
    if (phones.length === 0) return new Map();
    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.contact.findMany({
        where: { tenantId, phone: { in: phones } },
        select: { id: true, phone: true },
      }),
    );
    const out = new Map<string, { id: string }>();
    for (const c of rows) out.set(c.phone, { id: c.id });
    return out;
  }

  private async lookupLeadsForContacts(
    tenantId: string,
    contactIds: string[],
    scopeWhere: Prisma.LeadWhereInput | null,
  ): Promise<Map<string, LeadRow>> {
    if (contactIds.length === 0) return new Map();
    const rows = await this.prisma.withTenant(tenantId, (tx) => {
      const where: Prisma.LeadWhereInput = {
        tenantId,
        contactId: { in: contactIds },
        ...(scopeWhere ?? {}),
      };
      return tx.lead.findMany({
        where,
        // We want the most-recent lead per contact; Prisma orderBy
        // works on the result set, not GROUP BY. Sort newest first
        // and keep the first per contactId in JS.
        orderBy: [{ updatedAt: 'desc' }],
        select: {
          id: true,
          name: true,
          contactId: true,
          lifecycleState: true,
          stage: { select: { code: true, terminalKind: true } },
          captain: {
            select: { id: true, activatedAt: true, dftAt: true, tripCount: true },
          },
        },
      });
    });
    const out = new Map<string, LeadRow>();
    for (const l of rows) {
      if (!l.contactId) continue;
      if (!out.has(l.contactId)) out.set(l.contactId, l as LeadRow);
    }
    return out;
  }

  private async computePartnerMissing(
    tenantId: string,
    source: SourceRow,
    records: RecordRow[],
    scopeWhere: Prisma.LeadWhereInput | null,
  ): Promise<ReconciliationItem[]> {
    // Index partner records by phone for fast presence + active-status
    // lookup.
    const partnerByPhone = new Map<string, RecordRow>();
    for (const r of records) if (r.phone) partnerByPhone.set(r.phone, r);

    // Pull won/captain leads in scope. Bounded — D4.6 ships a
    // bounded report so a tenant with millions of won leads
    // doesn't blow the response. The CSV export still hits the
    // same MAX_LIMIT cap; tighter cohorts go via the filter
    // params.
    const leads = await this.prisma.withTenant(tenantId, (tx) => {
      const where: Prisma.LeadWhereInput = {
        tenantId,
        captain: { isNot: null },
        ...(source.companyId && { companyId: source.companyId }),
        ...(source.countryId && { countryId: source.countryId }),
        ...(scopeWhere ?? {}),
      };
      return tx.lead.findMany({
        where,
        take: PartnerReconciliationService.MAX_LIMIT,
        orderBy: { updatedAt: 'desc' },
        select: {
          id: true,
          name: true,
          phone: true,
          contactId: true,
          lifecycleState: true,
          stage: { select: { code: true, terminalKind: true } },
          captain: {
            select: { id: true, activatedAt: true, dftAt: true, tripCount: true },
          },
        },
      });
    });

    const out: ReconciliationItem[] = [];
    for (const lead of leads) {
      const phone = lead.phone;
      if (!phone) continue;
      const partner = partnerByPhone.get(phone);
      const partnerHasActive =
        partner !== undefined && (partner.partnerStatus ?? '').toLowerCase() === 'active';
      // Missing = no row at all OR row exists but partner status
      // isn't 'active'. Both signal CRM-active claim doesn't have
      // partner support.
      if (!partner || !partnerHasActive) {
        out.push({
          category: 'partner_missing',
          partnerSourceId: source.id,
          partnerSourceName: source.displayName,
          leadId: lead.id,
          captainId: lead.captain?.id ?? null,
          contactId: lead.contactId,
          phone,
          crmName: lead.name,
          crmStage: lead.stage.code,
          crmLifecycleState: lead.lifecycleState,
          crmActiveDate: lead.captain?.activatedAt ?? null,
          crmDftDate: lead.captain?.dftAt ?? null,
          crmTripCount: lead.captain?.tripCount ?? null,
          partnerStatus: partner?.partnerStatus ?? null,
          partnerActiveDate: partner?.partnerActiveDate ?? null,
          partnerDftDate: partner?.partnerDftDate ?? null,
          partnerTripCount: partner?.tripCount ?? null,
          lastSyncAt: source.lastSyncAt,
          severity: 'warning',
          recommendedAction: partner ? 'check_partner_status' : 'sync_partner',
        });
      }
    }
    return out;
  }
}

// ─── helpers ────────────────────────────────────────────────────────

function buildItem(
  source: SourceRow,
  record: RecordRow,
  lead: LeadRow,
  captain: NonNullable<LeadRow['captain']>,
  category: ReconciliationCategory,
  severity: ReconciliationSeverity,
): ReconciliationItem {
  return {
    category,
    partnerSourceId: source.id,
    partnerSourceName: source.displayName,
    leadId: lead.id,
    captainId: captain.id,
    contactId: lead.contactId,
    phone: record.phone!,
    crmName: lead.name,
    crmStage: lead.stage.code,
    crmLifecycleState: lead.lifecycleState,
    crmActiveDate: captain.activatedAt,
    crmDftDate: captain.dftAt,
    crmTripCount: captain.tripCount,
    partnerStatus: record.partnerStatus,
    partnerActiveDate: record.partnerActiveDate,
    partnerDftDate: record.partnerDftDate,
    partnerTripCount: record.tripCount,
    lastSyncAt: source.lastSyncAt,
    severity,
    recommendedAction:
      category === 'partner_trips_mismatch' ? 'investigate_telemetry' : 'reconcile_dates',
  };
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

function csvEscape(s: string): string {
  if (s === null || s === undefined) return '';
  const t = String(s);
  if (/[",\n]/.test(t)) return `"${t.replace(/"/g, '""')}"`;
  return t;
}

function emptyCounts(): Record<ReconciliationCategory, number> {
  return {
    partner_missing: 0,
    partner_active_not_in_crm: 0,
    partner_date_mismatch: 0,
    partner_dft_mismatch: 0,
    partner_trips_mismatch: 0,
  };
}

function countByCategory(items: ReconciliationItem[]): Record<ReconciliationCategory, number> {
  const counts = emptyCounts();
  for (const i of items) counts[i.category] += 1;
  return counts;
}

// ─── shapes ─────────────────────────────────────────────────────────

export const RECONCILIATION_CATEGORIES = new Set([
  'partner_missing',
  'partner_active_not_in_crm',
  'partner_date_mismatch',
  'partner_dft_mismatch',
  'partner_trips_mismatch',
] as const);
export type ReconciliationCategory =
  | 'partner_missing'
  | 'partner_active_not_in_crm'
  | 'partner_date_mismatch'
  | 'partner_dft_mismatch'
  | 'partner_trips_mismatch';

export type ReconciliationSeverity = 'info' | 'warning';

export interface ReconciliationFilters {
  partnerSourceId?: string;
  companyId?: string;
  countryId?: string;
  category?: ReconciliationCategory;
  limit?: number;
}

export interface ReconciliationItem {
  category: ReconciliationCategory;
  partnerSourceId: string;
  partnerSourceName: string;
  leadId: string | null;
  captainId: string | null;
  contactId: string | null;
  phone: string;
  crmName: string | null;
  crmStage: string | null;
  crmLifecycleState: string | null;
  crmActiveDate: Date | null;
  crmDftDate: Date | null;
  crmTripCount: number | null;
  partnerStatus: string | null;
  partnerActiveDate: Date | null;
  partnerDftDate: Date | null;
  partnerTripCount: number | null;
  lastSyncAt: Date | null;
  severity: ReconciliationSeverity;
  recommendedAction: string;
}

export interface ReconciliationResult {
  items: ReconciliationItem[];
  counts: Record<ReconciliationCategory, number>;
  generatedAt: string;
}

interface SourceRow {
  id: string;
  displayName: string;
  partnerCode: string;
  companyId: string | null;
  countryId: string | null;
  lastSyncAt: Date | null;
}

interface RecordRow {
  id: string;
  phone: string;
  partnerStatus: string | null;
  partnerActiveDate: Date | null;
  partnerDftDate: Date | null;
  tripCount: number | null;
  lastTripAt: Date | null;
  createdAt: Date;
}

interface LeadRow {
  id: string;
  name: string;
  contactId: string | null;
  lifecycleState: string;
  stage: { code: string; terminalKind: string | null };
  captain: { id: string; activatedAt: Date | null; dftAt: Date | null; tripCount: number } | null;
}
