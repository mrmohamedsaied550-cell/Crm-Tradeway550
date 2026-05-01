import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { requireTenantId } from '../tenants/tenant-context';
import type {
  CreateCompetitionDto,
  UpdateCompetitionDto,
  CompetitionStatus,
} from './competition.dto';

export interface LeaderboardEntry {
  userId: string | null;
  name: string;
  email: string | null;
  score: number;
}

/**
 * C33 — Competitions CRUD + a best-effort leaderboard.
 *
 * The leaderboard counts events from existing data (leads,
 * lead_activities, captains) inside the competition's date window and
 * tenant scope. It's intentionally simple — a richer materialised
 * view + period accruals land later.
 */
@Injectable()
export class CompetitionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  list() {
    const tenantId = requireTenantId();
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.competition.findMany({
        orderBy: [{ status: 'asc' }, { startDate: 'desc' }],
      }),
    );
  }

  async findByIdOrThrow(id: string) {
    const tenantId = requireTenantId();
    const row = await this.prisma.withTenant(tenantId, (tx) =>
      tx.competition.findUnique({ where: { id } }),
    );
    if (!row) {
      throw new NotFoundException({
        code: 'competition.not_found',
        message: `Competition ${id} not found in active tenant`,
      });
    }
    return row;
  }

  async create(dto: CreateCompetitionDto, actorUserId: string | null = null) {
    const tenantId = requireTenantId();
    return this.prisma.withTenant(tenantId, async (tx) => {
      const row = await tx.competition.create({
        data: {
          tenantId,
          name: dto.name,
          companyId: dto.companyId ?? null,
          countryId: dto.countryId ?? null,
          teamId: dto.teamId ?? null,
          startDate: new Date(dto.startDate),
          endDate: new Date(dto.endDate),
          metric: dto.metric,
          reward: dto.reward,
          status: dto.status ?? 'draft',
        },
      });
      await this.audit.writeInTx(tx, tenantId, {
        action: 'competition.create',
        entityType: 'competition',
        entityId: row.id,
        actorUserId,
        payload: { name: row.name, metric: row.metric, status: row.status },
      });
      return row;
    });
  }

  async update(id: string, dto: UpdateCompetitionDto, actorUserId: string | null = null) {
    await this.findByIdOrThrow(id);
    const tenantId = requireTenantId();
    return this.prisma.withTenant(tenantId, async (tx) => {
      const row = await tx.competition.update({
        where: { id },
        data: {
          ...(dto.name !== undefined && { name: dto.name }),
          ...(dto.companyId !== undefined && { companyId: dto.companyId }),
          ...(dto.countryId !== undefined && { countryId: dto.countryId }),
          ...(dto.teamId !== undefined && { teamId: dto.teamId }),
          ...(dto.startDate !== undefined && { startDate: new Date(dto.startDate) }),
          ...(dto.endDate !== undefined && { endDate: new Date(dto.endDate) }),
          ...(dto.metric !== undefined && { metric: dto.metric }),
          ...(dto.reward !== undefined && { reward: dto.reward }),
          ...(dto.status !== undefined && { status: dto.status }),
        },
      });
      await this.audit.writeInTx(tx, tenantId, {
        action: 'competition.update',
        entityType: 'competition',
        entityId: id,
        actorUserId,
        payload: dto as unknown as Prisma.InputJsonValue,
      });
      return row;
    });
  }

  async setStatus(id: string, status: CompetitionStatus, actorUserId: string | null = null) {
    await this.findByIdOrThrow(id);
    const tenantId = requireTenantId();
    return this.prisma.withTenant(tenantId, async (tx) => {
      const row = await tx.competition.update({ where: { id }, data: { status } });
      await this.audit.writeInTx(tx, tenantId, {
        action: 'competition.status_change',
        entityType: 'competition',
        entityId: id,
        actorUserId,
        payload: { status },
      });
      return row;
    });
  }

  async remove(id: string, actorUserId: string | null = null) {
    await this.findByIdOrThrow(id);
    const tenantId = requireTenantId();
    await this.prisma.withTenant(tenantId, async (tx) => {
      await tx.competition.delete({ where: { id } });
      await this.audit.writeInTx(tx, tenantId, {
        action: 'competition.delete',
        entityType: 'competition',
        entityId: id,
        actorUserId,
      });
    });
  }

  /**
   * Best-effort leaderboard. Currently supports only `leads_created`
   * and `activations` (captain creation) in a tenant-scoped manner.
   * `first_trips` and `conversion_rate` are returned as empty arrays
   * since the trip + funnel-stage data they need will land later.
   */
  async leaderboard(id: string): Promise<LeaderboardEntry[]> {
    const competition = await this.findByIdOrThrow(id);
    const tenantId = requireTenantId();
    const start = competition.startDate;
    const end = competition.endDate;

    return this.prisma.withTenant(tenantId, async (tx) => {
      if (competition.metric === 'leads_created') {
        const grouped = await tx.lead.groupBy({
          by: ['createdById'],
          where: {
            createdAt: { gte: start, lte: end },
            ...(competition.teamId ? { assignedTo: { teamId: competition.teamId } } : {}),
          },
          _count: { _all: true },
        });
        if (grouped.length === 0) return [];
        const userIds = grouped
          .map((g) => g.createdById)
          .filter((v): v is string => typeof v === 'string');
        const users = userIds.length
          ? await tx.user.findMany({
              where: { id: { in: userIds } },
              select: { id: true, name: true, email: true },
            })
          : [];
        const byId = new Map(users.map((u) => [u.id, u]));
        return grouped
          .map((g) => {
            const u = g.createdById ? byId.get(g.createdById) : null;
            return {
              userId: g.createdById ?? null,
              name: u?.name ?? 'Unknown',
              email: u?.email ?? null,
              score: g._count._all,
            };
          })
          .sort((a, b) => b.score - a.score);
      }

      if (competition.metric === 'activations') {
        const grouped = await tx.captain.groupBy({
          by: ['leadId'],
          where: {
            activatedAt: { gte: start, lte: end },
            ...(competition.teamId ? { teamId: competition.teamId } : {}),
          },
          _count: { _all: true },
        });
        if (grouped.length === 0) return [];
        // Map each captain → its lead's assignedToId (the agent who owned it).
        const leadIds = grouped.map((g) => g.leadId);
        const leads = await tx.lead.findMany({
          where: { id: { in: leadIds } },
          select: { id: true, assignedToId: true },
        });
        const ownerByLead = new Map(leads.map((l) => [l.id, l.assignedToId]));
        const tally = new Map<string, number>();
        for (const g of grouped) {
          const ownerId = ownerByLead.get(g.leadId);
          if (!ownerId) continue;
          tally.set(ownerId, (tally.get(ownerId) ?? 0) + g._count._all);
        }
        const userIds = [...tally.keys()];
        const users = userIds.length
          ? await tx.user.findMany({
              where: { id: { in: userIds } },
              select: { id: true, name: true, email: true },
            })
          : [];
        return users
          .map((u) => ({
            userId: u.id,
            name: u.name,
            email: u.email,
            score: tally.get(u.id) ?? 0,
          }))
          .sort((a, b) => b.score - a.score);
      }

      // first_trips / conversion_rate: not yet wired (no trip data).
      return [];
    });
  }
}
