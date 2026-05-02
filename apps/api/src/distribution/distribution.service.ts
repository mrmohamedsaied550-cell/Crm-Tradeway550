import { Injectable, Optional } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { TenantSettingsService } from '../tenants/tenant-settings.service';
import { AgentCapacitiesService } from './capacities.service';
import { filterCandidates, type RawCandidate } from './candidate-filter';
import type { RoutingContext, RoutingDecision, StrategyName } from './distribution.types';
import { LeadRoutingLogService } from './routing-log.service';
import { DistributionRulesService } from './rules.service';
import { getStrategy } from './strategies';

/**
 * Phase 1A — A4: the distribution engine façade.
 *
 * One public method: `route(ctx, tx)` returns the routing decision
 * AND persists the audit log row. The decision is purely advisory
 * — applying it (lead.assignedToId update, users.last_assigned_at
 * bump, SLA reset, activity row) is the caller's job (see
 * LeadsService.autoAssign in A5).
 *
 * Flow:
 *   1. Find the matching rule (DistributionRulesService) — or fall
 *      back to a synthesised "no-rule" decision using the tenant's
 *      default_strategy.
 *   2. Load the candidate pool: every user in the tenant whose
 *      role + status are in scope. This is a single query.
 *   3. Load capacities for those users (synthesised default for
 *      missing rows).
 *   4. Load active-lead counts for those users (one COUNT GROUP BY).
 *   5. Run the filter pipeline (pure function in candidate-filter.ts).
 *   6. Run the chosen strategy on the surviving candidates.
 *   7. Build + persist the routing log row.
 *   8. Return the decision.
 *
 * Tenant scoping: when called inside an existing
 * PrismaService.withTenant transaction, `tx` is reused so the route
 * decision lands atomically with the lead update. When called
 * standalone (e.g. dry-run from the admin "test rule" button),
 * the service opens its own withTenant block.
 */
@Injectable()
export class DistributionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rules: DistributionRulesService,
    private readonly capacities: AgentCapacitiesService,
    private readonly logs: LeadRoutingLogService,
    @Optional() private readonly tenantSettings?: TenantSettingsService,
  ) {}

  async route(ctx: RoutingContext, tx?: Prisma.TransactionClient): Promise<RoutingDecision> {
    const run = (client: Prisma.TransactionClient): Promise<RoutingDecision> =>
      this.routeInTx(ctx, client);
    if (tx) return run(tx);
    return this.prisma.withTenant(ctx.tenantId, run);
  }

  private async routeInTx(
    ctx: RoutingContext,
    tx: Prisma.TransactionClient,
  ): Promise<RoutingDecision> {
    // 1. Match a rule (or fall back).
    const rule = await this.rules.findMatchingRule(ctx, tx);
    const strategyName: StrategyName = rule
      ? (rule.strategy as StrategyName)
      : await this.getDefaultStrategy(ctx.tenantId, tx);

    // 2. Build the raw candidate pool. SQL pre-filters to
    //    eligible roles + active status to keep the in-memory list
    //    small; the filter pipeline (#5 below) re-checks for
    //    consistency + records exclusion reasons for non-pre-filtered
    //    rows that join via other paths.
    //
    //    We fetch ALL active users with eligible roles in the
    //    tenant — typically 5–50 rows. No need to paginate.
    const users = await tx.user.findMany({
      where: {
        status: 'active',
        role: { code: { in: ['sales_agent', 'tl_sales'] } },
      },
      select: {
        id: true,
        status: true,
        teamId: true,
        lastAssignedAt: true,
        role: { select: { code: true } },
      },
    });

    if (users.length === 0) {
      const decision: RoutingDecision = {
        ruleId: rule?.id ?? null,
        strategy: strategyName,
        chosenUserId: null,
        candidateCount: 0,
        excludedCount: 0,
        excludedReasons: {},
      };
      await this.logs.record(decision, ctx, tx);
      return decision;
    }

    // 3. Load capacities (defaults synthesised for missing rows).
    const userIds = users.map((u) => u.id);
    const capacities = await this.capacities.getEffectiveForUsers(userIds, tx);

    // 4. Active-lead counts per user. One GROUP BY query.
    const counts = await tx.lead.groupBy({
      by: ['assignedToId'],
      where: { assignedToId: { in: userIds }, stage: { isTerminal: false } },
      _count: { _all: true },
    });
    const countByUser = new Map(counts.map((c) => [c.assignedToId as string, c._count._all]));

    // 5. Run the filter pipeline.
    const raw: RawCandidate[] = users.map((u) => ({
      id: u.id,
      status: u.status,
      roleCode: u.role.code,
      teamId: u.teamId,
      lastAssignedAt: u.lastAssignedAt,
      capacity: capacities.get(u.id)!, // synthesised default if missing
      activeLeadCount: countByUser.get(u.id) ?? 0,
    }));
    const { surviving, excluded } = filterCandidates(raw, {
      ruleTargetTeamId: rule?.targetTeamId ?? null,
      excludeUserIds: ctx.currentAssigneeId ? [ctx.currentAssigneeId] : [],
      now: new Date(),
    });

    // 6. Run the strategy.
    const strategy = getStrategy(strategyName);
    const { chosenUserId } = strategy.pick({
      candidates: surviving,
      rule: {
        id: rule?.id ?? '__no_rule__',
        strategy: strategyName,
        targetUserId: rule?.targetUserId ?? null,
      },
    });

    // 7. Persist the audit log + return.
    const decision: RoutingDecision = {
      ruleId: rule?.id ?? null,
      strategy: strategyName,
      chosenUserId,
      candidateCount: surviving.length,
      excludedCount: Object.keys(excluded).length,
      excludedReasons: excluded,
    };
    await this.logs.record(decision, ctx, tx);
    return decision;
  }

  /**
   * Tenant default strategy. Reads from `tenant_settings.default_strategy`
   * (added by 0026). Falls back to 'capacity' when the settings
   * service isn't wired (tests with a thin fixture) — preserving
   * the pre-Phase-1 behaviour.
   */
  private async getDefaultStrategy(
    tenantId: string,
    tx: Prisma.TransactionClient,
  ): Promise<StrategyName> {
    if (!this.tenantSettings) return 'capacity';
    const settings = await this.tenantSettings.getInTx(tx, tenantId);
    return settings.defaultStrategy;
  }
}
