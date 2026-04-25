import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, desc } from 'drizzle-orm';
import crypto from 'node:crypto';
import { db } from '../../db/client';
import { campaigns } from '../../db/schema/campaigns';
import { authenticate, requireCapability } from '../../middleware/auth';
import { NotFoundError } from '../../lib/errors';

const createSchema = z.object({
  name: z.string().min(2).max(160),
  code: z.string().min(2).max(64),
  platform: z.enum(['meta', 'tiktok', 'google', 'referral', 'manual', 'sheet', 'other']),
  companyCountryId: z.string(),
  budget: z.number().nonnegative().optional(),
  currency: z.string().length(3).optional(),
  routingMode: z.enum(['round_robin', 'percentage', 'capacity', 'performance', 'manual', 'hybrid']).default('round_robin'),
  routingConfig: z.object({
    weights: z.record(z.number()).optional(),
    percentages: z.record(z.number()).optional(),
    fallbackUserId: z.string().optional(),
    excludeOnLeave: z.boolean().optional(),
    respectDailyCap: z.boolean().optional(),
  }).optional(),
  externalCampaignId: z.string().optional(),
  startsAt: z.coerce.date().optional(),
  endsAt: z.coerce.date().optional(),
});

export async function campaignsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  app.get('/', async (req, reply) => {
    const q = z.object({
      companyCountryId: z.string().optional(),
      platform: z.string().optional(),
    }).parse(req.query);

    const conds = [];
    if (q.companyCountryId) conds.push(eq(campaigns.companyCountryId, q.companyCountryId));
    if (q.platform) conds.push(eq(campaigns.platform, q.platform as 'meta'));

    const list = await db
      .select()
      .from(campaigns)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(campaigns.createdAt));
    return reply.send({ items: list });
  });

  app.get('/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, id)).limit(1);
    if (!campaign) throw new NotFoundError('Campaign');
    return reply.send(campaign);
  });

  app.post('/', { preHandler: requireCapability('campaigns.manage') }, async (req, reply) => {
    const body = createSchema.parse(req.body);
    const decimalBody = {
      ...body,
      budget: body.budget !== undefined ? body.budget.toString() : undefined,
    };
    await db.insert(campaigns).values({
      ...decimalBody,
      webhookSecret: crypto.randomBytes(24).toString('hex'),
      createdBy: req.actor!.id,
    });
    const [created] = await db
      .select()
      .from(campaigns)
      .where(eq(campaigns.code, body.code))
      .limit(1);
    return reply.status(201).send(created);
  });

  app.put('/:id', { preHandler: requireCapability('campaigns.manage') }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = createSchema.partial().parse(req.body);
    const decimalBody = {
      ...body,
      budget: body.budget !== undefined ? body.budget.toString() : undefined,
    };
    await db.update(campaigns).set(decimalBody).where(eq(campaigns.id, id));
    const [updated] = await db.select().from(campaigns).where(eq(campaigns.id, id)).limit(1);
    if (!updated) throw new NotFoundError('Campaign');
    return reply.send(updated);
  });

  app.post('/:id/rotate-secret', { preHandler: requireCapability('campaigns.manage') }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const secret = crypto.randomBytes(24).toString('hex');
    await db.update(campaigns).set({ webhookSecret: secret }).where(eq(campaigns.id, id));
    return reply.send({ webhookSecret: secret });
  });
}
