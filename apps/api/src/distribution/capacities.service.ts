import { Injectable } from '@nestjs/common';
import type { AgentCapacity, Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { requireTenantId } from '../tenants/tenant-context';

/**
 * Phase 1A — A4: per-user capacity / availability config.
 *
 * Effective shape for routing decisions. A user without an
 * `agent_capacities` row gets the synthesised defaults below.
 * The DistributionService consumes these; the strategies see the
 * already-flattened RoutingCandidate shape.
 */
export interface EffectiveCapacity {
  userId: string;
  weight: number; // clamped to >= 1
  isAvailable: boolean;
  outOfOfficeUntil: Date | null;
  maxActiveLeads: number | null;
}

const DEFAULT_CAPACITY: Omit<EffectiveCapacity, 'userId'> = {
  weight: 1,
  isAvailable: true,
  outOfOfficeUntil: null,
  maxActiveLeads: null,
};

@Injectable()
export class AgentCapacitiesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Returns a Map<userId, EffectiveCapacity> for the requested users.
   * Every requested id appears in the map — users without a row get
   * the synthesised defaults so the orchestrator never needs an
   * "exists?" branch per candidate.
   *
   * Pass `tx` from inside an existing PrismaService.withTenant block
   * to avoid opening a second transaction.
   */
  async getEffectiveForUsers(
    userIds: readonly string[],
    tx?: Prisma.TransactionClient,
  ): Promise<Map<string, EffectiveCapacity>> {
    if (userIds.length === 0) return new Map();
    const tenantId = requireTenantId();

    const fetch = async (client: Prisma.TransactionClient): Promise<AgentCapacity[]> =>
      client.agentCapacity.findMany({ where: { userId: { in: [...userIds] } } });

    const rows = tx ? await fetch(tx) : await this.prisma.withTenant(tenantId, fetch);
    const byUserId = new Map(rows.map((r) => [r.userId, r]));

    const out = new Map<string, EffectiveCapacity>();
    for (const userId of userIds) {
      const row = byUserId.get(userId);
      if (!row) {
        out.set(userId, { userId, ...DEFAULT_CAPACITY });
        continue;
      }
      out.set(userId, {
        userId,
        // Min weight 1: a 0 weight makes the candidate invisible to
        // the weighted strategy; that's a footgun. Operators who
        // want "no leads ever" should toggle isAvailable=false.
        weight: row.weight < 1 ? 1 : row.weight,
        isAvailable: row.isAvailable,
        outOfOfficeUntil: row.outOfOfficeUntil,
        maxActiveLeads: row.maxActiveLeads,
      });
    }
    return out;
  }

  /** Read every capacity row in the active tenant — used by admin UI. */
  list(): Promise<AgentCapacity[]> {
    const tenantId = requireTenantId();
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.agentCapacity.findMany({ orderBy: { userId: 'asc' } }),
    );
  }

  /**
   * Upsert a user's capacity row. The user must already be in the
   * active tenant (the FK enforces it; service-layer validation
   * rejects cross-tenant ids before we ever hit the DB).
   */
  async upsert(
    userId: string,
    patch: Partial<
      Pick<EffectiveCapacity, 'weight' | 'isAvailable' | 'outOfOfficeUntil' | 'maxActiveLeads'>
    >,
  ): Promise<AgentCapacity> {
    const tenantId = requireTenantId();
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.agentCapacity.upsert({
        where: { userId },
        update: {
          ...(patch.weight !== undefined && { weight: patch.weight }),
          ...(patch.isAvailable !== undefined && { isAvailable: patch.isAvailable }),
          ...(patch.outOfOfficeUntil !== undefined && {
            outOfOfficeUntil: patch.outOfOfficeUntil,
          }),
          ...(patch.maxActiveLeads !== undefined && { maxActiveLeads: patch.maxActiveLeads }),
        },
        create: {
          userId,
          tenantId,
          weight: patch.weight ?? DEFAULT_CAPACITY.weight,
          isAvailable: patch.isAvailable ?? DEFAULT_CAPACITY.isAvailable,
          outOfOfficeUntil: patch.outOfOfficeUntil ?? DEFAULT_CAPACITY.outOfOfficeUntil,
          maxActiveLeads: patch.maxActiveLeads ?? DEFAULT_CAPACITY.maxActiveLeads,
        },
      }),
    );
  }
}
