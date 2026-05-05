import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { ScopeContextService, type ScopeUserClaims } from '../rbac/scope-context.service';
import { requireTenantId } from '../tenants/tenant-context';

/**
 * Phase D4 — D4.5: PartnerMergeService — controlled merge of
 * selected partner fields into CRM truth.
 *
 * Hard rules (locked product decisions):
 *   • NEVER blanket-overwrite. One field at a time, explicit
 *     operator action, audited with before/after.
 *   • NEVER write `Captain.tripCount` or `CaptainTrip` from a
 *     snapshot. Trip telemetry stays in the projection.
 *   • NEVER write `partner_status` into CRM stage / lifecycle.
 *   • NEVER auto-create a Captain just for a merge. If the lead
 *     hasn't converted yet, throw `partner.merge.no_captain` —
 *     the operator must convert first via the existing flow.
 *
 * Whitelist for D4.5:
 *   • `active_date` → `Captain.activatedAt`
 *   • `dft_date`    → `Captain.dftAt`
 *
 * Audit footprint per merge:
 *   • `LeadEvidence` row (kind = 'partner_record') referencing
 *     the snapshot + record + optional operator note.
 *   • `LeadActivity` row (type = 'partner_merge', actionSource =
 *     'lead') with structured `{ fields, before, after,
 *     partnerSourceId, partnerSnapshotId, partnerRecordId }`
 *     payload. Surfaces on the lead timeline.
 *   • `audit_events` row (action = 'partner.merge.applied') with
 *     the same structured payload — dashboard-friendly handle
 *     for /admin/audit chip filters.
 *
 * Snapshot freshness:
 *   • Configurable max-age via `PARTNER_MERGE_MAX_SNAPSHOT_AGE_HOURS`
 *     env var (default 168 / 7 days). Older record → typed
 *     `partner.merge.snapshot_stale` so operators see why a
 *     button greyed out instead of getting a silent no-op.
 *
 * Concurrency:
 *   • All four writes (Captain.update + LeadEvidence.create +
 *     LeadActivity.create + audit) ride one `withTenant` tx so
 *     a partial failure rolls everything back. RLS guarantees
 *     tenant isolation.
 */
@Injectable()
export class PartnerMergeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly scopeContext: ScopeContextService,
  ) {}

  async mergeFields(input: {
    leadId: string;
    partnerSourceId: string;
    fields: ReadonlyArray<MergeableField>;
    evidenceNote?: string;
    actorUserId: string;
    userClaims: ScopeUserClaims;
  }): Promise<MergeResult> {
    const tenantId = requireTenantId();

    if (input.fields.length === 0) {
      throw new BadRequestException({
        code: 'partner.merge.field_not_mergeable',
        message: 'No fields supplied for merge.',
      });
    }
    for (const f of input.fields) {
      if (!MERGEABLE_FIELDS.has(f)) {
        throw new BadRequestException({
          code: 'partner.merge.field_not_mergeable',
          message: `Field '${f}' is not mergeable in D4.5.`,
        });
      }
    }

    // Scope-narrowed lead lookup so a TL on a different team can't
    // merge through a leakable id.
    const scope = await this.scopeContext.resolveLeadScope(input.userClaims);
    const lead = await this.prisma.withTenant(tenantId, (tx) => {
      const where: Prisma.LeadWhereInput = scope.where
        ? { AND: [{ id: input.leadId, tenantId }, scope.where] }
        : { id: input.leadId, tenantId };
      return tx.lead.findFirst({
        where,
        select: {
          id: true,
          contactId: true,
          phone: true,
          captain: { select: { id: true, activatedAt: true, dftAt: true } },
        },
      });
    });
    if (!lead) {
      throw new NotFoundException({
        code: 'lead.not_found',
        message: `Lead not found: ${input.leadId}`,
      });
    }
    if (!lead.captain) {
      throw new BadRequestException({
        code: 'partner.merge.no_captain',
        message:
          'No captain on this lead. Convert the lead to a captain before merging partner dates.',
      });
    }

    // Resolve the join phone (Contact.phone preferred, fallback to
    // Lead.phone). Same rule the verification projection uses.
    const phone = await this.resolveJoinPhone(lead);
    if (!phone) {
      throw new BadRequestException({
        code: 'partner.merge.no_record',
        message: 'No phone available on lead/contact to look up partner record.',
      });
    }

    // Latest record from a `success` / `partial` snapshot for the
    // requested source. We capture the snapshot id alongside so
    // the evidence row points at the correct run.
    const record = await this.prisma.withTenant(tenantId, (tx) =>
      tx.partnerRecord.findFirst({
        where: {
          tenantId,
          partnerSourceId: input.partnerSourceId,
          phone,
          snapshot: { status: { in: ['success', 'partial'] } },
        },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          snapshotId: true,
          partnerActiveDate: true,
          partnerDftDate: true,
          createdAt: true,
        },
      }),
    );
    if (!record) {
      throw new NotFoundException({
        code: 'partner.merge.no_record',
        message: 'No partner record found for this lead in the requested source.',
      });
    }

    // Snapshot staleness check — defaults to 7 days; configurable
    // via env so an operator can tighten / loosen.
    const maxAgeHours = resolveMaxAgeHours();
    const ageMs = Date.now() - record.createdAt.getTime();
    if (ageMs > maxAgeHours * 60 * 60 * 1000) {
      throw new BadRequestException({
        code: 'partner.merge.snapshot_stale',
        message: `Partner snapshot is older than ${maxAgeHours}h. Sync the source again before merging.`,
      });
    }

    // Per-field validation + before/after assembly. We also build
    // the Prisma update set in one pass so the captain write only
    // runs when at least one field actually changes.
    const before: Record<string, string | null> = {};
    const after: Record<string, string | null> = {};
    const changedFields: MergeableField[] = [];
    const captainUpdate: Prisma.CaptainUpdateInput = {};

    for (const field of input.fields) {
      if (field === 'active_date') {
        if (!record.partnerActiveDate) {
          throw new BadRequestException({
            code: 'partner.merge.field_missing_in_partner',
            message: 'Partner record has no active date.',
          });
        }
        if (
          lead.captain.activatedAt &&
          lead.captain.activatedAt.getTime() === record.partnerActiveDate.getTime()
        ) {
          throw new BadRequestException({
            code: 'partner.merge.value_unchanged',
            message: 'Partner active date matches CRM; nothing to merge.',
          });
        }
        before['activatedAt'] = lead.captain.activatedAt
          ? lead.captain.activatedAt.toISOString()
          : null;
        after['activatedAt'] = record.partnerActiveDate.toISOString();
        captainUpdate.activatedAt = record.partnerActiveDate;
        changedFields.push('active_date');
      } else if (field === 'dft_date') {
        if (!record.partnerDftDate) {
          throw new BadRequestException({
            code: 'partner.merge.field_missing_in_partner',
            message: 'Partner record has no DFT date.',
          });
        }
        if (
          lead.captain.dftAt &&
          lead.captain.dftAt.getTime() === record.partnerDftDate.getTime()
        ) {
          throw new BadRequestException({
            code: 'partner.merge.value_unchanged',
            message: 'Partner DFT date matches CRM; nothing to merge.',
          });
        }
        before['dftAt'] = lead.captain.dftAt ? lead.captain.dftAt.toISOString() : null;
        after['dftAt'] = record.partnerDftDate.toISOString();
        captainUpdate.dftAt = record.partnerDftDate;
        changedFields.push('dft_date');
      }
    }

    // Single-tx commit: captain update + evidence + activity +
    // audit. RLS on every write keeps tenant isolation honest;
    // partial failure rolls everything back.
    const { evidenceId, activityId } = await this.prisma.withTenant(tenantId, async (tx) => {
      await tx.captain.update({
        where: { id: lead.captain!.id },
        data: captainUpdate,
      });
      const evidence = await tx.leadEvidence.create({
        data: {
          tenantId,
          leadId: lead.id,
          kind: 'partner_record',
          partnerRecordId: record.id,
          partnerSnapshotId: record.snapshotId,
          ...(input.evidenceNote && input.evidenceNote.trim().length > 0
            ? { notes: input.evidenceNote.trim() }
            : {}),
          capturedByUserId: input.actorUserId,
        },
      });
      const activityPayload: Prisma.InputJsonValue = {
        fields: changedFields,
        before,
        after,
        partnerSourceId: input.partnerSourceId,
        partnerSnapshotId: record.snapshotId,
        partnerRecordId: record.id,
        evidenceId: evidence.id,
      } as Prisma.InputJsonValue;
      const activity = await tx.leadActivity.create({
        data: {
          tenantId,
          leadId: lead.id,
          type: 'partner_merge',
          actionSource: 'lead',
          createdById: input.actorUserId,
          payload: activityPayload,
        },
      });
      await this.audit.writeInTx(tx, tenantId, {
        action: 'partner.merge.applied',
        entityType: 'lead',
        entityId: lead.id,
        actorUserId: input.actorUserId,
        payload: {
          leadId: lead.id,
          captainId: lead.captain!.id,
          partnerSourceId: input.partnerSourceId,
          partnerSnapshotId: record.snapshotId,
          partnerRecordId: record.id,
          evidenceId: evidence.id,
          changedFields,
          before,
          after,
        } as Prisma.InputJsonValue,
      });
      await this.audit.writeInTx(tx, tenantId, {
        action: 'partner.evidence.attached',
        entityType: 'lead_evidence',
        entityId: evidence.id,
        actorUserId: input.actorUserId,
        payload: {
          leadId: lead.id,
          kind: 'partner_record',
          partnerSnapshotId: record.snapshotId,
          partnerRecordId: record.id,
        } as Prisma.InputJsonValue,
      });
      return { evidenceId: evidence.id, activityId: activity.id };
    });

    return {
      leadId: lead.id,
      captainId: lead.captain.id,
      partnerSourceId: input.partnerSourceId,
      partnerSnapshotId: record.snapshotId,
      partnerRecordId: record.id,
      evidenceId,
      activityId,
      changedFields,
      before,
      after,
    };
  }

  /**
   * Read-only evidence list for a lead. Visible to anyone with
   * lead access in scope — the controller-level capability gate
   * decides which `partner.*` cap is required.
   */
  async listEvidenceForLead(
    leadId: string,
    userClaims: ScopeUserClaims,
  ): Promise<LeadEvidenceDto[]> {
    const tenantId = requireTenantId();
    const scope = await this.scopeContext.resolveLeadScope(userClaims);
    const lead = await this.prisma.withTenant(tenantId, (tx) => {
      const where: Prisma.LeadWhereInput = scope.where
        ? { AND: [{ id: leadId, tenantId }, scope.where] }
        : { id: leadId, tenantId };
      return tx.lead.findFirst({ where, select: { id: true } });
    });
    if (!lead) {
      throw new NotFoundException({
        code: 'lead.not_found',
        message: `Lead not found: ${leadId}`,
      });
    }
    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.leadEvidence.findMany({
        where: { tenantId, leadId },
        orderBy: { createdAt: 'desc' },
        include: {
          capturedBy: { select: { id: true, name: true } },
        },
      }),
    );
    return rows.map((r) => ({
      id: r.id,
      leadId: r.leadId,
      kind: r.kind,
      partnerRecordId: r.partnerRecordId,
      partnerSnapshotId: r.partnerSnapshotId,
      storageRef: r.storageRef,
      fileName: r.fileName,
      mimeType: r.mimeType,
      sizeBytes: r.sizeBytes,
      notes: r.notes,
      capturedBy: r.capturedBy ? { id: r.capturedBy.id, name: r.capturedBy.name } : null,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  // ─── helpers ──────────────────────────────────────────────────

  private async resolveJoinPhone(lead: {
    contactId: string | null;
    phone: string;
  }): Promise<string | null> {
    if (!lead.contactId) return lead.phone ?? null;
    const tenantId = requireTenantId();
    const contact = await this.prisma.withTenant(tenantId, (tx) =>
      tx.contact.findUnique({
        where: { id: lead.contactId! },
        select: { phone: true },
      }),
    );
    return contact?.phone ?? lead.phone ?? null;
  }
}

// ─── shapes ─────────────────────────────────────────────────────────

export const MERGEABLE_FIELDS = new Set(['active_date', 'dft_date'] as const);
export type MergeableField = 'active_date' | 'dft_date';

export interface MergeResult {
  leadId: string;
  captainId: string;
  partnerSourceId: string;
  partnerSnapshotId: string;
  partnerRecordId: string;
  evidenceId: string;
  activityId: string;
  changedFields: MergeableField[];
  before: Record<string, string | null>;
  after: Record<string, string | null>;
}

export interface LeadEvidenceDto {
  id: string;
  leadId: string;
  kind: string;
  partnerRecordId: string | null;
  partnerSnapshotId: string | null;
  storageRef: string | null;
  fileName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  notes: string | null;
  capturedBy: { id: string; name: string } | null;
  createdAt: string;
}

function resolveMaxAgeHours(): number {
  const raw = process.env['PARTNER_MERGE_MAX_SNAPSHOT_AGE_HOURS'];
  if (!raw) return 168;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 168;
}
