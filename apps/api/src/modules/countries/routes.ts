import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { requireCapability } from '../../lib/rbac.js';
import { conflict } from '../../lib/errors.js';

const createBody = z.object({
  code: z.string().length(2).toUpperCase(),
  name: z.string().min(1),
  currency: z.string().optional(),
  active: z.boolean().optional(),
});

const holidayBody = z.object({
  date: z.coerce.date(),
  name: z.string().min(1),
});

const routes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', async (req) => {
    const user = await fastify.requireAuth(req);
    requireCapability(user, 'country.read');
    return prisma.country.findMany({ orderBy: { code: 'asc' } });
  });

  fastify.post('/', async (req, reply) => {
    const user = await fastify.requireAuth(req);
    requireCapability(user, 'country.write');
    const body = createBody.parse(req.body);
    const exists = await prisma.country.findUnique({ where: { code: body.code } });
    if (exists) throw conflict('Country code already exists');
    const created = await prisma.country.create({ data: body });
    return reply.status(201).send(created);
  });

  fastify.post('/:id/holidays', async (req, reply) => {
    const user = await fastify.requireAuth(req);
    requireCapability(user, 'country.write');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = holidayBody.parse(req.body);
    const created = await prisma.holiday.create({
      data: { countryId: id, date: body.date, name: body.name },
    });
    return reply.status(201).send(created);
  });
};

export default routes;
