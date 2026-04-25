import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { LeadsService } from './leads.service.js';
import { actorScope, authenticate, requireCapability } from '../../middleware/auth.js';
import { UnauthorizedError } from '../../lib/errors.js';

const listQuery = z.object({
  search: z.string().optional(),
  companyCountryId: z.string().optional(),
  stageId: z.string().optional(),
  statusId: z.string().optional(),
  assignedUserId: z.string().optional(),
  subStatus: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(25),
  sortBy: z.enum(['createdAt', 'updatedAt', 'nextFollowUpAt']).default('createdAt'),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
});

const createSchema = z.object({
  contact: z.object({
    fullName: z.string().min(2).max(160),
    phone: z.string().min(6).max(32),
    whatsapp: z.string().max(32).optional(),
    email: z.string().email().optional(),
    city: z.string().max(80).optional(),
    countryCode: z.string().length(2),
    vehicleType: z.enum(['car', 'motorcycle', 'van', 'other']).optional(),
  }),
  enrollment: z.object({
    companyCountryId: z.string(),
    source: z.string().max(64).optional(),
    sourceCode: z.string().max(64).optional(),
    campaignId: z.string().optional(),
    assignedUserId: z.string().optional(),
    currentStageId: z.string().optional(),
    currentStatusId: z.string().optional(),
  }),
  allowExistingContact: z.boolean().default(false),
});

const updateSchema = z.object({
  currentStageId: z.string().optional(),
  currentStatusId: z.string().optional(),
  subStatus: z.enum(['active', 'waiting_approval', 'waiting_customer', 'cold', 'paused', 'completed', 'dropped']).optional(),
  assignedUserId: z.string().nullable().optional(),
  rejectReasonId: z.string().nullable().optional(),
  rejectNote: z.string().nullable().optional(),
  nextFollowUpAt: z.coerce.date().nullable().optional(),
});

const noteSchema = z.object({
  body: z.string().min(1).max(2000),
});

const callSchema = z.object({
  outcome: z.string().min(1).max(120),
  durationSec: z.number().int().nonnegative().optional(),
  notes: z.string().max(2000).optional(),
});

export async function leadsRoutes(app: FastifyInstance) {
  const service = new LeadsService();
  app.addHook('preHandler', authenticate);

  app.get('/', { preHandler: requireCapability('leads.read') }, async (req, reply) => {
    const query = listQuery.parse(req.query);
    const result = await service.list({ ...query, scope: actorScope(req) });
    return reply.send(result);
  });

  app.post('/check-duplicate', async (req, reply) => {
    const { phone } = z.object({ phone: z.string().min(6) }).parse(req.body);
    return reply.send(await service.checkDuplicate(phone));
  });

  app.post('/', { preHandler: requireCapability('leads.create') }, async (req, reply) => {
    if (!req.actor) throw new UnauthorizedError();
    const body = createSchema.parse(req.body);
    const created = await service.create({ ...body, actorId: req.actor.id });
    return reply.status(201).send(created);
  });

  app.get('/:id', { preHandler: requireCapability('leads.read') }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    return reply.send(await service.get(id));
  });

  app.put('/:id', { preHandler: requireCapability('leads.update') }, async (req, reply) => {
    if (!req.actor) throw new UnauthorizedError();
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = updateSchema.parse(req.body);
    return reply.send(await service.update(id, req.actor.id, body));
  });

  app.post('/:id/notes', { preHandler: requireCapability('leads.update') }, async (req, reply) => {
    if (!req.actor) throw new UnauthorizedError();
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = noteSchema.parse(req.body);
    await service.addNote(id, req.actor.id, body.body);
    return reply.status(201).send({ ok: true });
  });

  app.post('/:id/calls', { preHandler: requireCapability('leads.update') }, async (req, reply) => {
    if (!req.actor) throw new UnauthorizedError();
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = callSchema.parse(req.body);
    await service.logCall(id, req.actor.id, body);
    return reply.status(201).send({ ok: true });
  });

  app.get('/:id/timeline', { preHandler: requireCapability('leads.read') }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    return reply.send({ items: await service.getTimeline(id) });
  });

  app.delete('/:id', { preHandler: requireCapability('leads.delete') }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await service.softDelete(id);
    return reply.status(204).send();
  });
}
