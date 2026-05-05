import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { requireTenantId } from '../tenants/tenant-context';

/**
 * Phase D3 — D3.7: agent-workspace "Needs attention now" surface.
 *
 * Single read endpoint that gathers three operational signals for the
 * calling agent in one round-trip:
 *
 *   1. `rotatedToMe` — leads that landed on the agent's desk in the
 *      last 24 h via the rotation engine (D3.4). Includes manual TL/
 *      Ops rotations and SLA-driven rotations.
 *   2. `atRiskSla`   — agent's own leads currently sitting in the
 *      `t150` or `t200` SLA threshold buckets (the two buckets where
 *      the operator should act *now*). Excludes resolved /
 *      converted / lost leads via the existing terminal-stage filter.
 *   3. `openReviews` — open `LeadReview` rows assigned to the agent.
 *      The agent role typically lacks `lead.review.read`, so this
 *      list is empty for sales / activation / driving agents — but
 *      the same endpoint also serves TLs working their own queue.
 *
 * Visibility:
 *   - Sanitised payload — NO previous-owner names, NO blame fields.
 *     For `rotatedToMe`, only the lead context + `rotatedAt` is
 *     surfaced; `fromUser` / `actor` from `LeadRotationLog` is
 *     intentionally dropped at the projection layer.
 *   - Reviews in the list are ALREADY filtered to the calling user
 *     (`assignedTlId = me`); broader TL queue access lives at
 *     `/admin/lead-reviews`.
 *
 * Feature flag: `D3_ENGINE_V1`. When the flag is off, the threshold
 * column stays at `'ok'` for new rows (the SLA threshold engine
 * doesn't write any other value), so `atRiskSla` is naturally empty.
 * `rotatedToMe` reads the rotation log table — the table only ever
 * carries flag-on rows because the writers respect the flag. The
 * endpoint is therefore safe to surface unconditionally.
 *
 * One DB round-trip is three SELECTs in parallel through a single
 * `withTenant` transaction so the FORCE-RLS policy is honoured.
 */
@Injectable()
export class AgentWorkspaceService {
  constructor(private readonly prisma: PrismaService) {}

  async getNeedsAttention(userId: string): Promise<NeedsAttentionResult> {
    const tenantId = requireTenantId();
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    return this.prisma.withTenant(tenantId, async (tx) => {
      const [rotations, atRiskLeads, reviews] = await Promise.all([
        // 1. Rotated-to-me in last 24h.
        tx.leadRotationLog.findMany({
          where: {
            tenantId,
            toUserId: userId,
            createdAt: { gte: since },
          },
          orderBy: { createdAt: 'desc' },
          take: 25,
          select: {
            id: true,
            createdAt: true,
            lead: {
              select: {
                id: true,
                name: true,
                phone: true,
                stage: { select: { code: true, name: true } },
              },
            },
          },
        }),
        // 2. My leads at threshold t150/t200. Active stages only —
        // terminal lead-state leads should never appear in the
        // worklist.
        tx.lead.findMany({
          where: {
            tenantId,
            assignedToId: userId,
            slaThreshold: { in: ['t150', 't200'] },
            stage: { isTerminal: false },
          },
          orderBy: [{ slaThresholdAt: 'asc' }, { createdAt: 'desc' }],
          take: 25,
          select: {
            id: true,
            name: true,
            phone: true,
            slaThreshold: true,
            slaThresholdAt: true,
            stage: { select: { code: true, name: true } },
          },
        }),
        // 3. Open LeadReviews assigned to me.
        tx.leadReview.findMany({
          where: {
            tenantId,
            assignedTlId: userId,
            resolvedAt: null,
          },
          orderBy: { createdAt: 'desc' },
          take: 25,
          select: {
            id: true,
            reason: true,
            createdAt: true,
            lead: {
              select: {
                id: true,
                name: true,
                phone: true,
                stage: { select: { code: true, name: true } },
              },
            },
          },
        }),
      ]);

      // Project rotation rows with NO sensitive fields (no fromUser,
      // no actor, no notes). The agent sees only "you got this one,
      // here's the lead" — the audit trail at /admin/audit carries
      // the full chain for TL/Ops review.
      const seenLeadIds = new Set<string>();
      const rotatedToMe: NeedsAttentionResult['rotatedToMe'] = [];
      for (const r of rotations) {
        if (seenLeadIds.has(r.lead.id)) continue;
        seenLeadIds.add(r.lead.id);
        rotatedToMe.push({
          rotationId: r.id,
          leadId: r.lead.id,
          leadName: r.lead.name,
          phone: r.lead.phone,
          stage: { code: r.lead.stage.code, name: r.lead.stage.name },
          rotatedAt: r.createdAt.toISOString(),
        });
      }

      const atRiskSla: NeedsAttentionResult['atRiskSla'] = atRiskLeads.map((l) => ({
        leadId: l.id,
        leadName: l.name,
        phone: l.phone,
        stage: { code: l.stage.code, name: l.stage.name },
        threshold: l.slaThreshold as 't150' | 't200',
        thresholdAt: l.slaThresholdAt ? l.slaThresholdAt.toISOString() : null,
      }));

      const openReviews: NeedsAttentionResult['openReviews'] = reviews.map((r) => ({
        reviewId: r.id,
        leadId: r.lead.id,
        leadName: r.lead.name,
        phone: r.lead.phone,
        stage: { code: r.lead.stage.code, name: r.lead.stage.name },
        reason: r.reason,
        createdAt: r.createdAt.toISOString(),
      }));

      return { rotatedToMe, atRiskSla, openReviews };
    });
  }
}

export interface NeedsAttentionResult {
  rotatedToMe: Array<{
    rotationId: string;
    leadId: string;
    leadName: string;
    phone: string;
    stage: { code: string; name: string };
    rotatedAt: string;
  }>;
  atRiskSla: Array<{
    leadId: string;
    leadName: string;
    phone: string;
    stage: { code: string; name: string };
    threshold: 't150' | 't200';
    thresholdAt: string | null;
  }>;
  openReviews: Array<{
    reviewId: string;
    leadId: string;
    leadName: string;
    phone: string;
    stage: { code: string; name: string };
    reason: string;
    createdAt: string;
  }>;
}
