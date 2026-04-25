import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, asc, isNull } from 'drizzle-orm';
import { db } from '../../db/client';
import { stages, leadStatuses, rejectReasons } from '../../db/schema/pipeline';
import { authenticate, requireCapability } from '../../middleware/auth';
import { NotFoundError } from '../../lib/errors';

const stageSchema = z.object({
  companyCountryId: z.string().nullable().optional(),
  code: z.string().min(2).max(64),
  nameAr: z.string().min(1).max(80),
  nameEn: z.string().min(1).max(80),
  color: z.string().default('#3b82f6'),
  icon: z.string().optional(),
  teamType: z.enum(['sales', 'activation', 'driving', 'none']).default('sales'),
  order: z.number().int().default(0),
  requiredFields: z.array(z.string()).optional(),
  approvalRequired: z.enum(['none', 'team_leader', 'manager', 'admin']).default('none'),
  slaMinutes: z.number().int().positive().nullable().optional(),
  isTerminal: z.boolean().default(false),
});

const statusSchema = z.object({
  companyCountryId: z.string().nullable().optional(),
  code: z.string().min(2).max(64),
  nameAr: z.string().min(1).max(80),
  nameEn: z.string().min(1).max(80),
  color: z.string().default('#94a3b8'),
  icon: z.string().optional(),
  order: z.number().int().default(0),
  isTerminal: z.boolean().default(false),
});

const reasonSchema = z.object({
  code: z.string().min(2).max(64),
  nameAr: z.string().min(1),
  nameEn: z.string().min(1),
  category: z.string().optional(),
});

export async function pipelineRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  // ===== Stages =====
  app.get('/stages', async (req, reply) => {
    const q = z.object({ companyCountryId: z.string().optional() }).parse(req.query);
    const list = await db
      .select()
      .from(stages)
      .where(q.companyCountryId ? eq(stages.companyCountryId, q.companyCountryId) : isNull(stages.companyCountryId))
      .orderBy(asc(stages.order));
    return reply.send({ items: list });
  });

  app.post('/stages', { preHandler: requireCapability('pipeline.manage') }, async (req, reply) => {
    const body = stageSchema.parse(req.body);
    await db.insert(stages).values(body);
    const [created] = await db
      .select()
      .from(stages)
      .where(and(eq(stages.code, body.code), body.companyCountryId ? eq(stages.companyCountryId, body.companyCountryId) : isNull(stages.companyCountryId)))
      .limit(1);
    return reply.status(201).send(created);
  });

  app.put('/stages/:id', { preHandler: requireCapability('pipeline.manage') }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = stageSchema.partial().parse(req.body);
    await db.update(stages).set(body).where(eq(stages.id, id));
    const [updated] = await db.select().from(stages).where(eq(stages.id, id)).limit(1);
    if (!updated) throw new NotFoundError('Stage');
    return reply.send(updated);
  });

  app.delete('/stages/:id', { preHandler: requireCapability('pipeline.manage') }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await db.update(stages).set({ isActive: false }).where(eq(stages.id, id));
    return reply.status(204).send();
  });

  app.put('/stages/reorder', { preHandler: requireCapability('pipeline.manage') }, async (req, reply) => {
    const body = z.object({
      orders: z.array(z.object({ id: z.string(), order: z.number().int() })),
    }).parse(req.body);
    for (const o of body.orders) {
      await db.update(stages).set({ order: o.order }).where(eq(stages.id, o.id));
    }
    return reply.send({ ok: true });
  });

  // ===== Lead Statuses =====
  app.get('/statuses', async (req, reply) => {
    const q = z.object({ companyCountryId: z.string().optional() }).parse(req.query);
    const list = await db
      .select()
      .from(leadStatuses)
      .where(q.companyCountryId ? eq(leadStatuses.companyCountryId, q.companyCountryId) : isNull(leadStatuses.companyCountryId))
      .orderBy(asc(leadStatuses.order));
    return reply.send({ items: list });
  });

  app.post('/statuses', { preHandler: requireCapability('pipeline.manage') }, async (req, reply) => {
    const body = statusSchema.parse(req.body);
    await db.insert(leadStatuses).values(body);
    const [created] = await db
      .select()
      .from(leadStatuses)
      .where(and(eq(leadStatuses.code, body.code), body.companyCountryId ? eq(leadStatuses.companyCountryId, body.companyCountryId) : isNull(leadStatuses.companyCountryId)))
      .limit(1);
    return reply.status(201).send(created);
  });

  app.put('/statuses/:id', { preHandler: requireCapability('pipeline.manage') }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = statusSchema.partial().parse(req.body);
    await db.update(leadStatuses).set(body).where(eq(leadStatuses.id, id));
    const [updated] = await db.select().from(leadStatuses).where(eq(leadStatuses.id, id)).limit(1);
    if (!updated) throw new NotFoundError('Status');
    return reply.send(updated);
  });

  app.delete('/statuses/:id', { preHandler: requireCapability('pipeline.manage') }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await db.update(leadStatuses).set({ isActive: false }).where(eq(leadStatuses.id, id));
    return reply.status(204).send();
  });

  // ===== Reject Reasons =====
  app.get('/reject-reasons', async (_req, reply) => {
    const list = await db.select().from(rejectReasons).orderBy(asc(rejectReasons.nameAr));
    return reply.send({ items: list });
  });

  app.post('/reject-reasons', { preHandler: requireCapability('pipeline.manage') }, async (req, reply) => {
    const body = reasonSchema.parse(req.body);
    await db.insert(rejectReasons).values(body);
    const [created] = await db.select().from(rejectReasons).where(eq(rejectReasons.code, body.code)).limit(1);
    return reply.status(201).send(created);
  });
}
