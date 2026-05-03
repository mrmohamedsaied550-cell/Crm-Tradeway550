import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { requireTenantId } from '../tenants/tenant-context';
import type { RoutingContext, RoutingDecision } from './distribution.types';

/**
 * Phase 1A — A4: append-only writes to lead_routing_logs.
 *
 * Every DistributionService.route() call results in exactly ONE
 * row, including the no-eligible-agent case (chosen_user_id NULL,
 * candidate_count 0 OR > 0 depending on whether anything passed
 * the filter pipeline).
 *
 * The log row is what ops looks at when investigating "why did
 * this lead get assigned to X?" or "why is no one being assigned
 * to anything from Meta-EG today?". Indexed on
 * (tenant_id, lead_id, decided_at DESC) so the lead-detail panel
 * pulls the most recent decision in O(log n).
 */
@Injectable()
export class LeadRoutingLogService {
  constructor(private readonly prisma: PrismaService) {}

  async record(
    decision: RoutingDecision,
    ctx: RoutingContext,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const tenantId = ctx.tenantId;
    const data = {
      tenantId,
      leadId: ctx.leadId,
      ruleId: decision.ruleId,
      strategy: decision.strategy,
      chosenUserId: decision.chosenUserId,
      candidateCount: decision.candidateCount,
      excludedCount: decision.excludedCount,
      excludedReasons: decision.excludedReasons as Prisma.InputJsonValue,
      requestId: ctx.requestId ?? null,
    };

    if (tx) {
      await tx.leadRoutingLog.create({ data });
      return;
    }
    await this.prisma.withTenant(tenantId, (client) => client.leadRoutingLog.create({ data }));
  }

  /**
   * List recent routing decisions in the active tenant. Used by the
   * /admin/distribution Routing log tab and the per-lead audit
   * panel. Capped at 200 to keep the JSON payload sane; the UI
   * paginates through `from`.
   */
  list(opts: { leadId?: string; from?: Date; limit?: number } = {}) {
    const tenantId = requireTenantId();
    const limit = Math.min(opts.limit ?? 50, 200);
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.leadRoutingLog.findMany({
        where: {
          ...(opts.leadId && { leadId: opts.leadId }),
          ...(opts.from && { decidedAt: { gte: opts.from } }),
        },
        orderBy: [{ decidedAt: 'desc' }],
        take: limit,
      }),
    );
  }
}
