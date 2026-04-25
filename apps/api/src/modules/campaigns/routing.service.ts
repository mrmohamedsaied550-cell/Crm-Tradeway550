import { and, eq, isNull, sql, asc } from 'drizzle-orm';
import { db } from '../../db/client';
import { users } from '../../db/schema/users';
import { enrollments } from '../../db/schema/enrollments';
import { campaigns, campaignRoutingState } from '../../db/schema/campaigns';

/**
 * Auto-assignment engine: picks the next sales agent for a given campaign.
 * Modes: round_robin, percentage, capacity, performance, manual, hybrid.
 *
 * Phase 1 supports round_robin and capacity. Others fall back to round_robin.
 */
export class RoutingService {
  async pickAssignee(campaignId: string): Promise<string | null> {
    const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
    if (!campaign) return null;

    const eligible = await this.eligibleAgents(campaign.companyCountryId);
    if (eligible.length === 0) return null;

    switch (campaign.routingMode) {
      case 'capacity':
        return this.pickByCapacity(eligible);
      case 'round_robin':
      case 'percentage':
      case 'performance':
      case 'hybrid':
      case 'manual':
      default:
        return this.pickRoundRobin(campaignId, eligible);
    }
  }

  private async eligibleAgents(_companyCountryId: string): Promise<string[]> {
    // For now: all active sales agents not on leave.
    // Future: filter by team assigned to this company-country.
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.role, 'sales_agent'),
          eq(users.isActive, true),
          eq(users.isOnLeave, false),
        ),
      );
    return rows.map((r) => r.id);
  }

  private async pickRoundRobin(campaignId: string, agents: string[]): Promise<string> {
    const [state] = await db
      .select()
      .from(campaignRoutingState)
      .where(eq(campaignRoutingState.campaignId, campaignId))
      .limit(1);

    const lastIdx = state?.lastAssignedUserId ? agents.indexOf(state.lastAssignedUserId) : -1;
    const nextIdx = (lastIdx + 1) % agents.length;
    const picked = agents[nextIdx]!;

    if (state) {
      await db
        .update(campaignRoutingState)
        .set({
          lastAssignedUserId: picked,
          totalAssigned: String(Number(state.totalAssigned ?? '0') + 1),
        })
        .where(eq(campaignRoutingState.campaignId, campaignId));
    } else {
      await db.insert(campaignRoutingState).values({
        campaignId,
        lastAssignedUserId: picked,
        totalAssigned: '1',
      });
    }

    return picked;
  }

  private async pickByCapacity(agents: string[]): Promise<string> {
    const counts = await db
      .select({
        userId: enrollments.assignedUserId,
        openCount: sql<number>`count(*)`,
      })
      .from(enrollments)
      .where(
        and(
          isNull(enrollments.deletedAt),
          eq(enrollments.subStatus, 'active'),
        ),
      )
      .groupBy(enrollments.assignedUserId);

    const map = new Map<string, number>();
    for (const c of counts) if (c.userId) map.set(c.userId, Number(c.openCount));

    let best = agents[0]!;
    let bestCount = map.get(best) ?? 0;
    for (const a of agents.slice(1)) {
      const c = map.get(a) ?? 0;
      if (c < bestCount) {
        best = a;
        bestCount = c;
      }
    }
    return best;
  }
}
