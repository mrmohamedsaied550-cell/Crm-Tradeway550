import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { ScopeContextService, type ScopeUserClaims } from '../rbac/scope-context.service';
import { requireTenantId } from '../tenants/tenant-context';

/**
 * Phase D4 — D4.4: PartnerVerificationService.
 *
 * Pure projection over `partner_snapshots` + `partner_records`. No
 * writes into CRM rows happen here — the read-only PartnerData card
 * on lead detail consumes this; controlled merge (D4.5) is a
 * separate explicit operator action.
 *
 * Resolution rules:
 *   1. Pick the latest `partner_records` row for `(partnerSource,
 *      contact.phone)` whose enclosing snapshot status is in
 *      ('success', 'partial'). 'failed' / 'running' snapshots are
 *      ignored — they didn't actually publish data.
 *   2. When the lead has no Contact (unmigrated legacy rows), match
 *      on `Lead.phone` directly using the same rule.
 *   3. Pick across ALL active partner sources visible to the
 *      caller — the UI renders one tab per source so the operator
 *      can switch. When `partnerSourceId` is supplied, narrow to
 *      that source.
 *
 * Verification status (per source) compares partner data to CRM
 * truth. Captain context (when the lead has converted) drives the
 * date / DFT / trips comparisons; pre-conversion leads only compute
 * `not_found` / `found` / `partner_active_crm_not_active`.
 *
 * Server NEVER writes through this service into Lead / Captain /
 * CaptainTrip — D4 trip clarification: snapshot trip_count stays in
 * `partner_records` only and feeds the projection here.
 */
@Injectable()
export class PartnerVerificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly scopeContext: ScopeContextService,
  ) {}

  /**
   * Per-lead projections. Returns ONE entry per matching active
   * partner source. Empty array when no match anywhere.
   */
  async getForLead(
    leadId: string,
    userClaims: ScopeUserClaims,
    opts: { partnerSourceId?: string; explicitCheck?: boolean; actorUserId?: string | null } = {},
  ): Promise<PartnerVerificationResult> {
    const tenantId = requireTenantId();
    const lead = await this.findLeadInScope(leadId, userClaims);
    const phone = await this.resolveJoinPhone(lead);
    const sources = await this.listVisibleSources(opts.partnerSourceId);
    const captain = await this.prisma.withTenant(tenantId, (tx) =>
      tx.captain.findUnique({
        where: { leadId },
        select: { id: true, activatedAt: true, dftAt: true, tripCount: true },
      }),
    );

    const projections: PartnerVerificationProjection[] = [];
    for (const source of sources) {
      const projection = await this.projectForSource({
        tenantId,
        lead,
        captain,
        phone,
        source,
      });
      projections.push(projection);
    }

    if (opts.explicitCheck) {
      // Audit only when the operator explicitly hits "Check now" —
      // the card itself loads on every lead-detail view, which is
      // far too chatty to audit.
      await this.audit.writeEvent({
        action: 'partner.verification.checked',
        entityType: 'lead',
        entityId: leadId,
        actorUserId: opts.actorUserId ?? null,
        payload: {
          partnerSources: projections.map((p) => ({
            partnerSourceId: p.partnerSourceId,
            verificationStatus: p.verificationStatus,
          })),
        } as Prisma.InputJsonValue,
      });
    }

    return {
      leadId,
      phone: phone ?? null,
      hasCaptain: captain !== null,
      projections,
    };
  }

  // ─── helpers ──────────────────────────────────────────────────

  private async findLeadInScope(
    leadId: string,
    userClaims: ScopeUserClaims,
  ): Promise<LeadForVerification> {
    const tenantId = requireTenantId();
    const scope = await this.scopeContext.resolveLeadScope(userClaims);
    const lead = await this.prisma.withTenant(tenantId, (tx) => {
      const where: Prisma.LeadWhereInput = scope.where
        ? { AND: [{ id: leadId, tenantId }, scope.where] }
        : { id: leadId, tenantId };
      return tx.lead.findFirst({
        where,
        select: {
          id: true,
          phone: true,
          contactId: true,
          companyId: true,
          countryId: true,
          lifecycleState: true,
          stageId: true,
          stage: { select: { code: true, terminalKind: true } },
        },
      });
    });
    if (!lead) {
      throw new NotFoundException({
        code: 'lead.not_found',
        message: `Lead not found: ${leadId}`,
      });
    }
    return lead as LeadForVerification;
  }

  private async resolveJoinPhone(lead: LeadForVerification): Promise<string | null> {
    if (!lead.contactId) return lead.phone ?? null;
    const contact = await this.prisma.withTenant(requireTenantId(), (tx) =>
      tx.contact.findUnique({ where: { id: lead.contactId! }, select: { phone: true } }),
    );
    return contact?.phone ?? lead.phone ?? null;
  }

  private async listVisibleSources(
    partnerSourceId: string | undefined,
  ): Promise<VerificationSourceRow[]> {
    const tenantId = requireTenantId();
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.partnerSource.findMany({
        where: {
          tenantId,
          isActive: true,
          ...(partnerSourceId && { id: partnerSourceId }),
        },
        select: {
          id: true,
          partnerCode: true,
          displayName: true,
          companyId: true,
          countryId: true,
          lastSyncAt: true,
          lastSyncStatus: true,
        },
        orderBy: { displayName: 'asc' },
      }),
    ) as unknown as Promise<VerificationSourceRow[]>;
  }

  private async projectForSource(input: {
    tenantId: string;
    lead: LeadForVerification;
    captain: CaptainForVerification | null;
    phone: string | null;
    source: VerificationSourceRow;
  }): Promise<PartnerVerificationProjection> {
    const { tenantId, lead, captain, phone, source } = input;

    if (!phone) {
      return this.shellProjection(source, 'not_found', ['No phone on lead.']);
    }

    // Latest record across snapshots in {success, partial} for the
    // (source, phone) pair. Done in one query via a join on
    // snapshot status — Prisma's `partnerRecord.findFirst` doesn't
    // support nested `OR` on the relation cleanly without `where`
    // composition; we use the `snapshot.status IN (...)` filter.
    const record = await this.prisma.withTenant(tenantId, (tx) =>
      tx.partnerRecord.findFirst({
        where: {
          tenantId,
          partnerSourceId: source.id,
          phone,
          snapshot: { status: { in: ['success', 'partial'] } },
        },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          snapshotId: true,
          partnerStatus: true,
          partnerActiveDate: true,
          partnerDftDate: true,
          tripCount: true,
          lastTripAt: true,
          createdAt: true,
        },
      }),
    );

    if (!record) {
      const lastSyncAt = source.lastSyncAt ? source.lastSyncAt.toISOString() : null;
      const warnings: string[] = [];
      if (lead.stage.terminalKind === 'won' || lead.lifecycleState === 'won') {
        // CRM says won/active but partner has nothing → operator
        // signal. Still 'crm_active_partner_missing' even when the
        // record query returns null because there's no match at all.
        return {
          ...this.shellProjection(source, 'crm_active_partner_missing', warnings),
          lastSyncAt,
        };
      }
      return {
        ...this.shellProjection(source, 'not_found', warnings),
        lastSyncAt,
      };
    }

    const projection: PartnerVerificationProjection = {
      partnerSourceId: source.id,
      partnerSourceName: source.displayName,
      partnerCode: source.partnerCode,
      lastSyncAt: source.lastSyncAt ? source.lastSyncAt.toISOString() : null,
      snapshotId: record.snapshotId,
      recordId: record.id,
      partnerStatus: record.partnerStatus ?? null,
      partnerActiveDate: record.partnerActiveDate ? record.partnerActiveDate.toISOString() : null,
      partnerDftDate: record.partnerDftDate ? record.partnerDftDate.toISOString() : null,
      tripCount: record.tripCount ?? null,
      lastTripAt: record.lastTripAt ? record.lastTripAt.toISOString() : null,
      verificationStatus: 'matched',
      warnings: [],
    };

    // Status comparison. We OR signal kinds into a single
    // priority-ordered status — `crm_active_partner_missing` and
    // `partner_active_crm_not_active` win over date/dft/trips
    // mismatches because they're presence-level rather than value-
    // level signals. Sub-mismatches go into `warnings[]` so the UI
    // can surface them all.
    const partnerActive = (record.partnerStatus ?? '').toLowerCase() === 'active';
    const crmActive =
      lead.lifecycleState === 'won' || lead.stage.terminalKind === 'won' || captain !== null;
    if (partnerActive && !crmActive) {
      projection.verificationStatus = 'partner_active_crm_not_active';
    }
    if (!partnerActive && crmActive) {
      // Edge: partner says non-active (or null) but CRM thinks
      // we're won. Surface as `crm_active_partner_missing` even
      // when the row exists — the data published by the partner
      // doesn't match the CRM claim. UI copy makes this neutral.
      projection.verificationStatus = 'crm_active_partner_missing';
    }

    if (captain) {
      // Date / DFT / trips comparisons only fire when the captain
      // exists. We never auto-overwrite — these signals feed the
      // UI badge + the future reconciliation queue (D4.6).
      if (
        record.partnerActiveDate &&
        captain.activatedAt &&
        !sameDay(record.partnerActiveDate, captain.activatedAt)
      ) {
        if (projection.verificationStatus === 'matched') {
          projection.verificationStatus = 'date_mismatch';
        } else {
          projection.warnings.push('date_mismatch');
        }
      } else if (record.partnerActiveDate && !captain.activatedAt) {
        projection.warnings.push('partner_has_active_date_crm_missing');
      }

      if (
        record.partnerDftDate &&
        captain.dftAt &&
        !sameDay(record.partnerDftDate, captain.dftAt)
      ) {
        if (projection.verificationStatus === 'matched') {
          projection.verificationStatus = 'dft_mismatch';
        } else {
          projection.warnings.push('dft_mismatch');
        }
      } else if (record.partnerDftDate && !captain.dftAt) {
        projection.warnings.push('partner_has_dft_date_crm_missing');
      }

      // Trips: partner snapshot is an aggregate; CRM authoritative
      // count comes from CaptainTrip ledger. We compare and signal
      // — but never write through this service.
      if (typeof record.tripCount === 'number' && record.tripCount !== captain.tripCount) {
        if (projection.verificationStatus === 'matched') {
          projection.verificationStatus = 'trips_mismatch';
        } else {
          projection.warnings.push('trips_mismatch');
        }
      }
    } else if (partnerActive) {
      // No captain yet but partner says active — the conversion is
      // pending; surface as a warning rather than a hard mismatch.
      projection.warnings.push('partner_active_crm_no_captain_yet');
    }

    return projection;
  }

  private shellProjection(
    source: VerificationSourceRow,
    verificationStatus: PartnerVerificationStatus,
    warnings: string[],
  ): PartnerVerificationProjection {
    return {
      partnerSourceId: source.id,
      partnerSourceName: source.displayName,
      partnerCode: source.partnerCode,
      lastSyncAt: source.lastSyncAt ? source.lastSyncAt.toISOString() : null,
      snapshotId: null,
      recordId: null,
      partnerStatus: null,
      partnerActiveDate: null,
      partnerDftDate: null,
      tripCount: null,
      lastTripAt: null,
      verificationStatus,
      warnings,
    };
  }
}

// ─── helpers ────────────────────────────────────────────────────────

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

// ─── shapes ─────────────────────────────────────────────────────────

export type PartnerVerificationStatus =
  | 'not_found'
  | 'matched'
  | 'crm_active_partner_missing'
  | 'partner_active_crm_not_active'
  | 'date_mismatch'
  | 'dft_mismatch'
  | 'trips_mismatch';

export interface PartnerVerificationProjection {
  partnerSourceId: string;
  partnerSourceName: string;
  partnerCode: string;
  lastSyncAt: string | null;
  snapshotId: string | null;
  recordId: string | null;
  partnerStatus: string | null;
  partnerActiveDate: string | null;
  partnerDftDate: string | null;
  tripCount: number | null;
  lastTripAt: string | null;
  verificationStatus: PartnerVerificationStatus;
  warnings: string[];
}

export interface PartnerVerificationResult {
  leadId: string;
  phone: string | null;
  hasCaptain: boolean;
  projections: PartnerVerificationProjection[];
}

interface LeadForVerification {
  id: string;
  phone: string;
  contactId: string | null;
  companyId: string | null;
  countryId: string | null;
  lifecycleState: string;
  stageId: string;
  stage: { code: string; terminalKind: string | null };
}

interface CaptainForVerification {
  id: string;
  activatedAt: Date | null;
  dftAt: Date | null;
  tripCount: number;
}

interface VerificationSourceRow {
  id: string;
  partnerCode: string;
  displayName: string;
  companyId: string | null;
  countryId: string | null;
  lastSyncAt: Date | null;
  lastSyncStatus: string | null;
}
