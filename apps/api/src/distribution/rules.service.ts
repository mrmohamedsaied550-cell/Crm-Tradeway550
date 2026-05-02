import { Injectable } from '@nestjs/common';
import type { DistributionRule, Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { requireTenantId } from '../tenants/tenant-context';
import type { RoutingContext, StrategyName } from './distribution.types';

/**
 * Phase 1A — A4: per-tenant rule lookup + CRUD.
 *
 * The match algorithm: take the highest-priority active rule whose
 * non-NULL conditions all match the routing context. NULL on a
 * match column is a wildcard (= "any"). When two rules tie on
 * priority, the older one (createdAt ASC) wins — a deterministic
 * tiebreak that matches the natural intuition "the rule that's
 * been there longer is the canonical one".
 *
 * "Most specific match" emerges from priority: ops gives the most
 * specific rules a lower priority number. The engine doesn't try
 * to compute specificity from the wildcard pattern — that's
 * fragile (what's more specific: source-only, or country-only?).
 * Priority is the explicit, auditable knob.
 */
@Injectable()
export class DistributionRulesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Returns the rule that should drive routing for `ctx`, or null
   * when no rule matches. Always reads inside the active tenant
   * via PrismaService.withTenant — RLS guarantees no cross-tenant
   * leak even if a buggy caller crafts the wrong context.
   */
  async findMatchingRule(
    ctx: RoutingContext,
    tx?: Prisma.TransactionClient,
  ): Promise<DistributionRule | null> {
    const tenantId = ctx.tenantId;

    const fetch = async (client: Prisma.TransactionClient): Promise<DistributionRule | null> => {
      // Prisma's `where` for "field IS NULL OR field = value" is the
      // OR-of-two-shapes pattern. Each match column gets the same
      // pair so the dimension is honoured wildcard-style.
      const candidates = await client.distributionRule.findMany({
        where: {
          tenantId,
          isActive: true,
          AND: [
            ctx.source === null
              ? { source: null }
              : { OR: [{ source: null }, { source: ctx.source }] },
            ctx.companyId === null
              ? { companyId: null }
              : { OR: [{ companyId: null }, { companyId: ctx.companyId }] },
            ctx.countryId === null
              ? { countryId: null }
              : { OR: [{ countryId: null }, { countryId: ctx.countryId }] },
          ],
        },
        orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
        take: 1,
      });
      return candidates[0] ?? null;
    };

    if (tx) return fetch(tx);
    return this.prisma.withTenant(tenantId, fetch);
  }

  /** Read every rule in the active tenant — used by the admin UI. */
  list(): Promise<DistributionRule[]> {
    const tenantId = requireTenantId();
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.distributionRule.findMany({
        orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
      }),
    );
  }

  findById(id: string): Promise<DistributionRule | null> {
    const tenantId = requireTenantId();
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.distributionRule.findUnique({ where: { id } }),
    );
  }

  /**
   * Validate that `strategy` is a known name + that `targetUserId`
   * is set when (and only when) strategy === 'specific_user'.
   * Throws a typed Error so the controller layer can map it to a
   * 400 with a stable code.
   */
  static validateRuleShape(input: { strategy: StrategyName; targetUserId: string | null }): void {
    if (input.strategy === 'specific_user' && !input.targetUserId) {
      throw new Error('rule.specific_user_requires_target_user');
    }
    if (input.strategy !== 'specific_user' && input.targetUserId) {
      throw new Error('rule.target_user_only_for_specific_user');
    }
  }
}
