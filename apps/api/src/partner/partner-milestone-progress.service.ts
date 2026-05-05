import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { ScopeContextService, type ScopeUserClaims } from '../rbac/scope-context.service';
import { requireTenantId } from '../tenants/tenant-context';
import {
  PartnerMilestoneConfigsService,
  type MilestoneConfigRow,
} from './partner-milestone-configs.service';
import { DEFAULT_RISK_THRESHOLDS } from './partner-milestone.dto';

/**
 * Phase D4 — D4.7: PartnerMilestoneProgressService.
 *
 * Pure derivation. NEVER writes through to Lead / Captain /
 * CaptainTrip. Takes the latest `success` / `partial` partner
 * record for the lead's contact, walks every `isActive=true`
 * milestone config on that source, and returns one
 * `MilestoneProgress` entry per config.
 *
 * Trip-count source (locked clarification preserved):
 *   • `tripCount` comes from `PartnerRecord.tripCount` ONLY.
 *   • `Captain.tripCount` is NEVER read or written here.
 *   • `CaptainTrip` ledger is untouched.
 *
 * Anchor resolution:
 *   • `partner_active_date`     → record.partnerActiveDate.
 *   • `partner_dft_date`        → record.partnerDftDate.
 *   • `first_seen_in_partner`   → record.createdAt (the snapshot
 *     row's insert timestamp; matches "first time we saw this
 *     contact in the partner feed").
 *
 * Risk:
 *   • `completed`  — tripCount ≥ targetTrips.
 *   • `expired`    — daysLeft < 0 AND not completed.
 *   • `high`       — daysLeft / windowDays < threshold.high.
 *   • `medium`     — daysLeft / windowDays < threshold.medium.
 *   • `low`        — otherwise.
 *
 * `needsPush` = `risk` ∈ {`high`, `expired`} && not completed.
 */
@Injectable()
export class PartnerMilestoneProgressService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configs: PartnerMilestoneConfigsService,
    private readonly scopeContext: ScopeContextService,
  ) {}

  /**
   * Per-lead progress projection. Groups results by partner source
   * so the UI can hang the milestone block off the active partner
   * tab on the lead-detail PartnerDataCard.
   */
  async forLead(leadId: string, userClaims: ScopeUserClaims): Promise<LeadMilestoneProgressResult> {
    const tenantId = requireTenantId();
    const scopeWhere = (await this.scopeContext.resolveLeadScope(userClaims)).where;
    const lead = await this.prisma.withTenant(tenantId, (tx) => {
      const where: Prisma.LeadWhereInput = scopeWhere
        ? { AND: [{ id: leadId, tenantId }, scopeWhere] }
        : { id: leadId, tenantId };
      return tx.lead.findFirst({
        where,
        select: { id: true, contactId: true, phone: true },
      });
    });
    if (!lead) {
      throw new NotFoundException({
        code: 'lead.not_found',
        message: `Lead not found: ${leadId}`,
      });
    }

    const phone = await this.resolveJoinPhone(lead);

    // List active sources + active configs in one pass so we know
    // which partner_records to look up.
    const sources = await this.prisma.withTenant(tenantId, (tx) =>
      tx.partnerSource.findMany({
        where: { tenantId, isActive: true },
        select: { id: true, displayName: true, partnerCode: true },
      }),
    );

    const projections: MilestoneProgressProjection[] = [];
    for (const source of sources) {
      const configs = await this.configs.listActiveForSource(source.id);
      if (configs.length === 0) continue;
      const record = phone ? await this.loadLatestRecord(tenantId, source.id, phone) : null;
      for (const config of configs) {
        projections.push(this.computeProgress({ source, config, record, now: new Date() }));
      }
    }

    return { leadId, phone: phone ?? null, projections };
  }

  // ─── pure derivation ──────────────────────────────────────────

  /**
   * Compute one milestone projection. Public-on-the-class so
   * `PartnerReconciliationService.commission_risk` can reuse it
   * without re-implementing the rules.
   */
  computeProgress(input: {
    source: { id: string; displayName: string; partnerCode: string };
    config: MilestoneConfigRow;
    record: RecordRow | null;
    now: Date;
  }): MilestoneProgressProjection {
    const { source, config, record, now } = input;
    const milestoneSteps = parseSteps(config.milestoneSteps);
    const targetTrips = milestoneSteps[milestoneSteps.length - 1] ?? 0;
    const thresholds = parseRisk(config.riskThresholds) ?? DEFAULT_RISK_THRESHOLDS;

    const shell: MilestoneProgressProjection = {
      partnerSourceId: source.id,
      partnerSourceName: source.displayName,
      configId: config.id,
      configCode: config.code,
      displayName: config.displayName,
      anchor: config.anchor,
      anchorAt: null,
      windowDays: config.windowDays,
      windowEndsAt: null,
      daysLeft: null,
      tripCount: null,
      targetTrips,
      milestoneSteps,
      currentMilestone: null,
      nextMilestone: null,
      progressPct: 0,
      risk: 'unknown',
      needsPush: false,
      reason: null,
    };

    if (!record) {
      return { ...shell, reason: 'no_partner_record' };
    }

    const anchorAt = resolveAnchor(config.anchor, record);
    if (!anchorAt) {
      return { ...shell, reason: 'missing_anchor' };
    }
    const windowEndsAt = new Date(anchorAt.getTime() + config.windowDays * 86400_000);
    const daysLeft = Math.ceil((windowEndsAt.getTime() - now.getTime()) / 86400_000);

    const tripCount = typeof record.tripCount === 'number' ? record.tripCount : 0;
    const currentMilestone =
      milestoneSteps
        .slice()
        .reverse()
        .find((step) => tripCount >= step) ?? null;
    const nextMilestone = milestoneSteps.find((step) => tripCount < step) ?? null;
    const progressPct = targetTrips > 0 ? Math.min(1, tripCount / targetTrips) : 0;

    const completed = tripCount >= targetTrips && targetTrips > 0;
    let risk: MilestoneRisk = 'low';
    if (completed) {
      risk = 'completed';
    } else if (daysLeft < 0) {
      risk = 'expired';
    } else {
      const fractionLeft = config.windowDays > 0 ? daysLeft / config.windowDays : 0;
      if (fractionLeft <= thresholds.high) risk = 'high';
      else if (fractionLeft <= thresholds.medium) risk = 'medium';
    }
    const needsPush = !completed && (risk === 'high' || risk === 'expired');

    return {
      ...shell,
      anchorAt: anchorAt.toISOString(),
      windowEndsAt: windowEndsAt.toISOString(),
      daysLeft,
      tripCount,
      currentMilestone,
      nextMilestone,
      progressPct,
      risk,
      needsPush,
    };
  }

  /**
   * Bulk projection used by D4.7 commission CSV exports + the
   * reconciliation `commission_risk` category. Returns one row per
   * (record, config) pair across active sources whose contact has
   * any record in the latest snapshot.
   */
  async listAllProgress(filters: {
    partnerSourceId?: string;
    onlyAtRisk?: boolean;
  }): Promise<CommissionProgressRow[]> {
    const tenantId = requireTenantId();
    const sources = await this.prisma.withTenant(tenantId, (tx) =>
      tx.partnerSource.findMany({
        where: {
          tenantId,
          isActive: true,
          ...(filters.partnerSourceId && { id: filters.partnerSourceId }),
        },
        select: { id: true, displayName: true, partnerCode: true },
      }),
    );
    const out: CommissionProgressRow[] = [];
    const now = new Date();
    for (const source of sources) {
      const configs = await this.configs.listActiveForSource(source.id);
      if (configs.length === 0) continue;
      const records = await this.loadLatestRecordsForSource(tenantId, source.id);
      const phones = Array.from(
        new Set(records.map((r) => r.phone).filter((p): p is string => !!p)),
      );
      const contacts = await this.lookupContacts(tenantId, phones);
      const leads = await this.lookupLeads(
        tenantId,
        [...contacts.values()].map((c) => c.id),
      );
      for (const record of records) {
        if (!record.phone) continue;
        const contact = contacts.get(record.phone);
        const lead = contact ? leads.get(contact.id) : undefined;
        for (const config of configs) {
          const projection = this.computeProgress({ source, config, record, now });
          if (filters.onlyAtRisk && !['high', 'expired', 'medium'].includes(projection.risk)) {
            continue;
          }
          out.push({
            phone: record.phone,
            crmName: lead?.name ?? null,
            crmStage: lead?.stage.code ?? null,
            owner: lead?.assignedTo?.name ?? null,
            projection,
          });
        }
      }
    }
    return out;
  }

  // ─── private helpers ──────────────────────────────────────────

  private async resolveJoinPhone(lead: {
    contactId: string | null;
    phone: string;
  }): Promise<string | null> {
    if (!lead.contactId) return lead.phone ?? null;
    const tenantId = requireTenantId();
    const contact = await this.prisma.withTenant(tenantId, (tx) =>
      tx.contact.findUnique({ where: { id: lead.contactId! }, select: { phone: true } }),
    );
    return contact?.phone ?? lead.phone ?? null;
  }

  private async loadLatestRecord(
    tenantId: string,
    partnerSourceId: string,
    phone: string,
  ): Promise<RecordRow | null> {
    const row = await this.prisma.withTenant(tenantId, (tx) =>
      tx.partnerRecord.findFirst({
        where: {
          tenantId,
          partnerSourceId,
          phone,
          snapshot: { status: { in: ['success', 'partial'] } },
        },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          phone: true,
          partnerActiveDate: true,
          partnerDftDate: true,
          tripCount: true,
          createdAt: true,
        },
      }),
    );
    return row as RecordRow | null;
  }

  private async loadLatestRecordsForSource(
    tenantId: string,
    sourceId: string,
  ): Promise<RecordRow[]> {
    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.partnerRecord.findMany({
        where: {
          tenantId,
          partnerSourceId: sourceId,
          phone: { not: null },
          snapshot: { status: { in: ['success', 'partial'] } },
        },
        orderBy: { createdAt: 'desc' },
        take: 1000,
        select: {
          id: true,
          phone: true,
          partnerActiveDate: true,
          partnerDftDate: true,
          tripCount: true,
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
    for (const r of rows) out.set(r.phone, { id: r.id });
    return out;
  }

  private async lookupLeads(tenantId: string, contactIds: string[]): Promise<Map<string, LeadRow>> {
    if (contactIds.length === 0) return new Map();
    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.lead.findMany({
        where: { tenantId, contactId: { in: contactIds } },
        orderBy: { updatedAt: 'desc' },
        select: {
          id: true,
          name: true,
          contactId: true,
          stage: { select: { code: true } },
          assignedTo: { select: { name: true } },
        },
      }),
    );
    const out = new Map<string, LeadRow>();
    for (const r of rows) {
      if (!r.contactId) continue;
      if (!out.has(r.contactId)) out.set(r.contactId, r as LeadRow);
    }
    return out;
  }
}

// ─── helpers ────────────────────────────────────────────────────────

function resolveAnchor(anchor: string, record: RecordRow): Date | null {
  if (anchor === 'partner_active_date') return record.partnerActiveDate ?? null;
  if (anchor === 'partner_dft_date') return record.partnerDftDate ?? null;
  if (anchor === 'first_seen_in_partner') return record.createdAt;
  return null;
}

function parseSteps(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0);
}

function parseRisk(raw: unknown): { high: number; medium: number } | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj['high'] !== 'number' || typeof obj['medium'] !== 'number') return null;
  return { high: obj['high'] as number, medium: obj['medium'] as number };
}

// ─── shapes ─────────────────────────────────────────────────────────

export type MilestoneRisk = 'low' | 'medium' | 'high' | 'expired' | 'completed' | 'unknown';

export interface MilestoneProgressProjection {
  partnerSourceId: string;
  partnerSourceName: string;
  configId: string;
  configCode: string;
  displayName: string;
  anchor: string;
  anchorAt: string | null;
  windowDays: number;
  windowEndsAt: string | null;
  daysLeft: number | null;
  tripCount: number | null;
  targetTrips: number;
  milestoneSteps: number[];
  currentMilestone: number | null;
  nextMilestone: number | null;
  progressPct: number;
  risk: MilestoneRisk;
  needsPush: boolean;
  /** Optional explanation when projection couldn't be computed
   *  ('no_partner_record' / 'missing_anchor'). NULL on a happy
   *  path. */
  reason: string | null;
}

export interface LeadMilestoneProgressResult {
  leadId: string;
  phone: string | null;
  projections: MilestoneProgressProjection[];
}

export interface CommissionProgressRow {
  phone: string;
  crmName: string | null;
  crmStage: string | null;
  owner: string | null;
  projection: MilestoneProgressProjection;
}

interface RecordRow {
  id: string;
  phone: string;
  partnerActiveDate: Date | null;
  partnerDftDate: Date | null;
  tripCount: number | null;
  createdAt: Date;
}

interface LeadRow {
  id: string;
  name: string;
  contactId: string | null;
  stage: { code: string };
  assignedTo: { name: string } | null;
}
