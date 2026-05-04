import { Injectable, Optional } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { TenantSettingsService } from '../tenants/tenant-settings.service';
import { AgentCapacitiesService } from './capacities.service';
import { filterCandidates, type RawCandidate } from './candidate-filter';
import type {
  ConversationRoutingContext,
  ConversationRoutingDecision,
  RoutingContext,
  RoutingDecision,
  StrategyName,
} from './distribution.types';
import { LeadRoutingLogService } from './routing-log.service';
import { DistributionRulesService } from './rules.service';
import { getStrategy } from './strategies';

/**
 * Stable namespace key for distribution advisory locks. Identical to
 * the value AssignmentService used pre-cutover (C29) so a rolling
 * deploy with both code paths active doesn't double-lock the same
 * tenant under different namespaces.
 */
const DISTRIBUTION_LOCK_NAMESPACE = 91924245;

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

  /**
   * Phase C — C10B-3: route an inbound WhatsApp conversation that has
   * NO lead yet.
   *
   * Reuses the existing rule lookup + candidate filter + strategy stack
   * — only the inputs and the output shape differ:
   *   - rule lookup runs against `(source='whatsapp', companyId,
   *     countryId)`, same as `route()` consults today.
   *   - candidate pool, capacities, active-lead counts: identical
   *     queries (capacity counts STILL use leads only — the locked
   *     decision is "no conversation count in capacity model" for
   *     this phase).
   *   - filter pipeline: identical, with `currentAssigneeId = null`
   *     (no stickiness — this is a fresh conversation).
   *   - strategy: identical pure pick.
   *
   * Differences from `route()`:
   *   - no advisory-lock under this path (no concurrent lead.update
   *     race to serialise; the conversation update is per-row).
   *   - no LeadRoutingLog row (lead-specific table; the routing
   *     decision is stashed in the inbound flow's audit payload
   *     instead — see C10B-3 plan §4 + decision §2).
   *   - returns `chosenTeamId` so the inbound orchestrator can
   *     denormalise ownership without a follow-up SELECT for
   *     `user.teamId`.
   */
  async routeConversation(
    ctx: ConversationRoutingContext,
    tx?: Prisma.TransactionClient,
  ): Promise<ConversationRoutingDecision> {
    const run = (client: Prisma.TransactionClient): Promise<ConversationRoutingDecision> =>
      this.routeConversationInTx(ctx, client);
    if (tx) return run(tx);
    return this.prisma.withTenant(ctx.tenantId, run);
  }

  private async routeConversationInTx(
    ctx: ConversationRoutingContext,
    tx: Prisma.TransactionClient,
  ): Promise<ConversationRoutingDecision> {
    // 1. Rule lookup — uses the same `(source, companyId, countryId)`
    //    selectors as `route()`. The rule type only requires those
    //    fields plus tenantId, so we shim a minimal RoutingContext
    //    (leadId is unused by `findMatchingRule`).
    const rule = await this.rules.findMatchingRule(
      {
        tenantId: ctx.tenantId,
        leadId: '__no_lead__', // findMatchingRule doesn't consult leadId
        source: ctx.source,
        companyId: ctx.companyId,
        countryId: ctx.countryId,
        currentAssigneeId: null,
      },
      tx,
    );

    const strategyName: StrategyName = rule
      ? (rule.strategy as StrategyName)
      : await this.getDefaultStrategy(ctx.tenantId, tx);

    // 2-5. Candidate pool + capacities + filter + pick. Reuses the
    //      private helper extracted from `routeInTx` so the two public
    //      methods stay in lockstep — any candidate-filter change
    //      lands once.
    const picked = await this.pickCandidate(tx, {
      ruleTargetTeamId: rule?.targetTeamId ?? null,
      excludeUserIds: [], // no current assignee on a fresh conversation
      ruleTargetUserId: rule?.targetUserId ?? null,
      ruleId: rule?.id ?? '__no_rule__',
      strategyName,
    });

    if (picked.chosenUserId === null) {
      // Truly unmatched — caller writes a review row with
      // reason='unmatched_after_routing'.
      return {
        ruleId: rule?.id ?? null,
        strategy: rule ? strategyName : 'no_match',
        chosenUserId: null,
        chosenTeamId: null,
        candidateCount: picked.candidateCount,
        excludedReasons: picked.excludedReasons,
      };
    }

    // 6. Resolve the chosen user's team in the same tx so the caller
    //    can denormalise without an extra round trip.
    const chosen = await tx.user.findUnique({
      where: { id: picked.chosenUserId },
      select: { teamId: true },
    });

    return {
      ruleId: rule?.id ?? null,
      strategy: strategyName,
      chosenUserId: picked.chosenUserId,
      chosenTeamId: chosen?.teamId ?? null,
      candidateCount: picked.candidateCount,
      excludedReasons: picked.excludedReasons,
    };
  }

  /**
   * Shared candidate-selection core for `route` and `routeConversation`.
   * Identical query / filter / strategy chain; only the caller decides
   * what to do with the result (lead update + log row vs. conversation
   * denormalisation + audit). Callers that need the chosen user's
   * teamId look it up themselves.
   */
  private async pickCandidate(
    tx: Prisma.TransactionClient,
    opts: {
      ruleTargetTeamId: string | null;
      excludeUserIds: readonly string[];
      ruleTargetUserId: string | null;
      ruleId: string;
      strategyName: StrategyName;
    },
  ): Promise<{
    chosenUserId: string | null;
    candidateCount: number;
    excludedReasons: RoutingDecision['excludedReasons'];
  }> {
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
      return { chosenUserId: null, candidateCount: 0, excludedReasons: {} };
    }

    const userIds = users.map((u) => u.id);
    const capacities = await this.capacities.getEffectiveForUsers(userIds, tx);

    const counts = await tx.lead.groupBy({
      by: ['assignedToId'],
      where: { assignedToId: { in: userIds }, stage: { isTerminal: false } },
      _count: { _all: true },
    });
    const countByUser = new Map(counts.map((c) => [c.assignedToId as string, c._count._all]));

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
      ruleTargetTeamId: opts.ruleTargetTeamId,
      excludeUserIds: [...opts.excludeUserIds],
      now: new Date(),
    });

    const strategy = getStrategy(opts.strategyName);
    const { chosenUserId } = strategy.pick({
      candidates: surviving,
      rule: {
        id: opts.ruleId,
        strategy: opts.strategyName,
        targetUserId: opts.ruleTargetUserId,
      },
    });

    return {
      chosenUserId,
      candidateCount: surviving.length,
      excludedReasons: excluded,
    };
  }

  private async routeInTx(
    ctx: RoutingContext,
    tx: Prisma.TransactionClient,
  ): Promise<RoutingDecision> {
    // Per-tenant advisory lock — held until the surrounding tx commits.
    // Without it, two concurrent route() calls within the same tenant
    // can both see "Alice has the lowest load" and both pick Alice,
    // wrecking the distribution. The lock serialises route() within
    // a tenant; concurrent routes for different tenants run in parallel.
    // Same namespace as AssignmentService used pre-cutover.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${DISTRIBUTION_LOCK_NAMESPACE}::int, hashtext(${ctx.tenantId}))`;

    // 1. Match a rule (unless explicitly bypassed). Bypass is only
    //    used by SLA breach reassignment today — see SlaService;
    //    when bypassed, we always run the tenant default strategy
    //    so the lead is routed to a fresh load-balanced agent rather
    //    than back to the rule's target (who just failed SLA).
    const rule = ctx.bypassRules ? null : await this.rules.findMatchingRule(ctx, tx);
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
