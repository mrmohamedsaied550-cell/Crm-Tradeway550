import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { requireTenantId } from '../tenants/tenant-context';

/**
 * Phase D2 — D2.2: read-only queries over the multi-attempt chain
 * shipped in D2.1.
 *
 * Powers (in later D2 chunks):
 *   - D2.5 Lead-detail "Attempts history" card
 *   - D2.5 ContactCard "N attempts on this contact" line
 *   - D2.3 DuplicateDecisionService — `getNextAttemptIndex(...)` is
 *     the canonical computation for the new attempt's number
 *
 * No writes. No scope enforcement here — every method is intended to
 * be called from a context that has ALREADY established a tenant
 * scope via `requireTenantId()`. Lead-list scope (own / team /
 * company / country) belongs to the caller; this service trusts the
 * tx's RLS isolation for tenant safety and returns whatever rows
 * fall under it.
 */

/** Minimum projection of a Lead row for the attempt history view. */
export interface AttemptSummary {
  id: string;
  attemptIndex: number;
  previousLeadId: string | null;
  reactivatedAt: Date | null;
  reactivatedById: string | null;
  reactivationRule: string | null;
  lifecycleState: string;
  lostReasonId: string | null;
  assignedToId: string | null;
  pipelineId: string | null;
  companyId: string | null;
  countryId: string | null;
  source: string;
  stageId: string;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class LeadAttemptsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * All attempts for a contact, ordered by `attemptIndex` ascending
   * (oldest first). Used by the lead-detail "Attempts history" card
   * and by the WhatsApp side-panel "N attempts" line.
   *
   * Returns an empty array when the contact doesn't exist or has no
   * leads yet. Tenant isolation comes from `prisma.withTenant`.
   */
  async listAttemptsForContact(contactId: string): Promise<AttemptSummary[]> {
    const tenantId = requireTenantId();
    return this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.lead.findMany({
        where: { tenantId, contactId },
        orderBy: { attemptIndex: 'asc' },
        select: ATTEMPT_SUMMARY_SELECT,
      });
      return rows.map(toAttemptSummary);
    });
  }

  /**
   * Walk the `previousLeadId` chain from a given lead back through
   * its predecessors, oldest first. Used when the operator opens
   * a lead and wants to see "what was tried before this attempt"
   * even if the contactId is missing on legacy rows. Capped at 64
   * hops to defend against a corrupted chain (the service should
   * never see one).
   */
  async getAttemptHistory(leadId: string): Promise<AttemptSummary[]> {
    const tenantId = requireTenantId();
    return this.prisma.withTenant(tenantId, async (tx) => {
      const visited = new Set<string>();
      const chain: AttemptSummary[] = [];
      let cursor: string | null = leadId;
      while (cursor && !visited.has(cursor) && chain.length < 64) {
        visited.add(cursor);
        const cursorId: string = cursor;
        const row = await tx.lead.findUnique({
          where: { id: cursorId },
          select: ATTEMPT_SUMMARY_SELECT,
        });
        if (!row) break;
        chain.push(toAttemptSummary(row));
        cursor = row.previousLeadId;
      }
      return chain.reverse(); // oldest first
    });
  }

  /**
   * Return the (at most one) currently-open attempt for a contact.
   * After D2.3 ships the partial-unique-on-open index there is at
   * most one such row; until then, we still tolerate multiple and
   * pick the one with the highest `attemptIndex`. Returns null when
   * no open attempt exists.
   */
  async getCurrentOpenAttempt(contactId: string): Promise<AttemptSummary | null> {
    const tenantId = requireTenantId();
    return this.prisma.withTenant(tenantId, async (tx) => {
      const row = await tx.lead.findFirst({
        where: { tenantId, contactId, lifecycleState: 'open' },
        orderBy: { attemptIndex: 'desc' },
        select: ATTEMPT_SUMMARY_SELECT,
      });
      return row ? toAttemptSummary(row) : null;
    });
  }

  /**
   * Most recent attempt (any lifecycle) for a contact. Used by
   * DuplicateDecisionService when it needs a "what's the latest
   * thing we tried" anchor regardless of state.
   */
  async getLatestAttempt(contactId: string): Promise<AttemptSummary | null> {
    const tenantId = requireTenantId();
    return this.prisma.withTenant(tenantId, async (tx) => {
      const row = await tx.lead.findFirst({
        where: { tenantId, contactId },
        orderBy: { attemptIndex: 'desc' },
        select: ATTEMPT_SUMMARY_SELECT,
      });
      return row ? toAttemptSummary(row) : null;
    });
  }

  /**
   * Compute the index for the NEXT attempt in this contact's chain.
   * `MAX(attemptIndex) + 1`, falling back to 1 when no attempts
   * exist. Used by DuplicateDecisionService.createNewAttempt.
   *
   * Uses an aggregate so the contact with thousands of attempts
   * (rare but possible — bulk reactivation campaigns) doesn't
   * pull every row.
   */
  async getNextAttemptIndex(contactId: string): Promise<number> {
    const tenantId = requireTenantId();
    return this.prisma.withTenant(tenantId, async (tx) => {
      const agg = await tx.lead.aggregate({
        where: { tenantId, contactId },
        _max: { attemptIndex: true },
      });
      const current = agg._max.attemptIndex ?? 0;
      return current + 1;
    });
  }
}

const ATTEMPT_SUMMARY_SELECT = {
  id: true,
  attemptIndex: true,
  previousLeadId: true,
  reactivatedAt: true,
  reactivatedById: true,
  reactivationRule: true,
  lifecycleState: true,
  lostReasonId: true,
  assignedToId: true,
  pipelineId: true,
  companyId: true,
  countryId: true,
  source: true,
  stageId: true,
  createdAt: true,
  updatedAt: true,
} as const;

function toAttemptSummary(row: {
  id: string;
  attemptIndex: number;
  previousLeadId: string | null;
  reactivatedAt: Date | null;
  reactivatedById: string | null;
  reactivationRule: string | null;
  lifecycleState: string;
  lostReasonId: string | null;
  assignedToId: string | null;
  pipelineId: string | null;
  companyId: string | null;
  countryId: string | null;
  source: string;
  stageId: string;
  createdAt: Date;
  updatedAt: Date;
}): AttemptSummary {
  return row;
}
