import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { requireCapability } from '../../lib/rbac.js';
import { conflict } from '../../lib/errors.js';

const createBody = z.object({
  name: z.string().min(1),
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/),
  active: z.boolean().optional(),
});

const routes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', async (req) => {
    const user = await fastify.requireAuth(req);
    requireCapability(user, 'company.read');
    return prisma.company.findMany({ orderBy: { name: 'asc' } });
  });

  fastify.post('/', async (req, reply) => {
    const user = await fastify.requireAuth(req);
    requireCapability(user, 'company.write');
    const body = createBody.parse(req.body);
    const exists = await prisma.company.findFirst({
      where: { OR: [{ name: body.name }, { slug: body.slug }] },
    });
    if (exists) throw conflict('Company with this name or slug already exists');
    const created = await prisma.company.create({ data: body });
    return reply.status(201).send(created);
  });
};

export default routes;
