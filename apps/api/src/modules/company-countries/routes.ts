import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { requireCapability } from '../../lib/rbac.js';
import { conflict, notFound } from '../../lib/errors.js';

const createBody = z.object({
  companyId: z.string().uuid(),
  countryId: z.string().uuid(),
  active: z.boolean().optional(),
});

const ccInclude = {
  company: { select: { id: true, name: true, slug: true } },
  country: { select: { id: true, code: true, name: true } },
} as const;

const routes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', async (req) => {
    const user = await fastify.requireAuth(req);
    requireCapability(user, 'companyCountry.read');
    return prisma.companyCountry.findMany({
      include: ccInclude,
      orderBy: { createdAt: 'asc' },
    });
  });

  fastify.get('/:id', async (req) => {
    const user = await fastify.requireAuth(req);
    requireCapability(user, 'companyCountry.read');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const found = await prisma.companyCountry.findUnique({
      where: { id },
      include: ccInclude,
    });
    if (!found) throw notFound('Company-Country not found');
    return found;
  });

  fastify.post('/', async (req, reply) => {
    const user = await fastify.requireAuth(req);
    requireCapability(user, 'companyCountry.write');
    const body = createBody.parse(req.body);
    const exists = await prisma.companyCountry.findUnique({
      where: {
        companyId_countryId: { companyId: body.companyId, countryId: body.countryId },
      },
    });
    if (exists) throw conflict('Company-Country pair already exists');
    const created = await prisma.companyCountry.create({
      data: body,
      include: ccInclude,
    });
    return reply.status(201).send(created);
  });
};

export default routes;
