import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, gte, isNull, sql } from 'drizzle-orm';
import { db } from '../../db/client';
import { enrollments } from '../../db/schema/enrollments';
import { contacts } from '../../db/schema/contacts';
import { authenticate, actorScope } from '../../middleware/auth';

export async function dashboardRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  app.get('/kpis', async (req, reply) => {
    const q = z.object({
      from: z.coerce.date().optional(),
      to: z.coerce.date().optional(),
      companyCountryId: z.string().optional(),
    }).parse(req.query);

    const scope = actorScope(req);
    const conds = [isNull(enrollments.deletedAt)];
    if (scope.type === 'self') conds.push(eq(enrollments.assignedUserId, scope.userId));
    if (q.from) conds.push(gte(enrollments.createdAt, q.from));
    if (q.companyCountryId) conds.push(eq(enrollments.companyCountryId, q.companyCountryId));

    const where = and(...conds);

    const [totals] = await db
      .select({
        total: sql<number>`count(*)`,
        active: sql<number>`sum(case when ${enrollments.subStatus} = 'active' then 1 else 0 end)`,
        completed: sql<number>`sum(case when ${enrollments.subStatus} = 'completed' then 1 else 0 end)`,
        dropped: sql<number>`sum(case when ${enrollments.subStatus} = 'dropped' then 1 else 0 end)`,
        firstTrips: sql<number>`sum(case when ${enrollments.firstTripAt} is not null then 1 else 0 end)`,
      })
      .from(enrollments)
      .where(where);

    const total = Number(totals?.total ?? 0);
    const completed = Number(totals?.completed ?? 0);
    const conversion = total > 0 ? (completed / total) * 100 : 0;

    return reply.send({
      total,
      active: Number(totals?.active ?? 0),
      completed,
      dropped: Number(totals?.dropped ?? 0),
      firstTrips: Number(totals?.firstTrips ?? 0),
      conversionRate: Number(conversion.toFixed(2)),
    });
  });

  app.get('/by-source', async (req, reply) => {
    const scope = actorScope(req);
    const conds = [isNull(enrollments.deletedAt)];
    if (scope.type === 'self') conds.push(eq(enrollments.assignedUserId, scope.userId));

    const rows = await db
      .select({
        source: enrollments.source,
        count: sql<number>`count(*)`,
      })
      .from(enrollments)
      .where(and(...conds))
      .groupBy(enrollments.source);
    return reply.send({
      items: rows.map((r) => ({ source: r.source ?? 'manual', count: Number(r.count) })),
    });
  });

  app.get('/by-stage', async (req, reply) => {
    const scope = actorScope(req);
    const conds = [isNull(enrollments.deletedAt)];
    if (scope.type === 'self') conds.push(eq(enrollments.assignedUserId, scope.userId));

    const rows = await db
      .select({
        stageId: enrollments.currentStageId,
        count: sql<number>`count(*)`,
      })
      .from(enrollments)
      .where(and(...conds))
      .groupBy(enrollments.currentStageId);

    return reply.send({
      items: rows.map((r) => ({ stageId: r.stageId, count: Number(r.count) })),
    });
  });
}
