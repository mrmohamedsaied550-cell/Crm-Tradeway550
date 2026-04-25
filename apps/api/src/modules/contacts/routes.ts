import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { requireCapability } from '../../lib/rbac.js';
import { notFound } from '../../lib/errors.js';

const createBody = z.object({
  countryId: z.string().uuid(),
  phone: z.string().min(4),
  fullName: z.string().min(1),
  nationalId: z.string().optional(),
  notes: z.string().optional(),
});

const updateBody = createBody.partial();

const dupBody = z.object({
  countryId: z.string().uuid(),
  phone: z.string().min(4),
});

const contactInclude = {
  enrollments: {
    select: {
      id: true,
      companyCountryId: true,
      stageId: true,
      assigneeId: true,
      createdAt: true,
    },
  },
} as const;

const routes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', async (req) => {
    const user = await fastify.requireAuth(req);
    requireCapability(user, 'contact.read');
    return prisma.contact.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  });

  fastify.get('/:id', async (req) => {
    const user = await fastify.requireAuth(req);
    requireCapability(user, 'contact.read');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const found = await prisma.contact.findUnique({ where: { id }, include: contactInclude });
    if (!found) throw notFound('Contact not found');
    return found;
  });

  fastify.post('/', async (req, reply) => {
    const user = await fastify.requireAuth(req);
    requireCapability(user, 'contact.write');
    const body = createBody.parse(req.body);
    const existing = await prisma.contact.findUnique({
      where: { countryId_phone: { countryId: body.countryId, phone: body.phone } },
      include: contactInclude,
    });
    if (existing) return reply.status(200).send(existing); // idempotent
    const created = await prisma.contact.create({ data: body, include: contactInclude });
    return reply.status(201).send(created);
  });

  fastify.post('/check-duplicate', async (req) => {
    const user = await fastify.requireAuth(req);
    requireCapability(user, 'contact.read');
    const body = dupBody.parse(req.body);
    const found = await prisma.contact.findUnique({
      where: { countryId_phone: { countryId: body.countryId, phone: body.phone } },
      include: {
        enrollments: {
          select: {
            id: true,
            companyCountryId: true,
            companyCountry: {
              select: {
                company: { select: { name: true, slug: true } },
                country: { select: { code: true, name: true } },
              },
            },
            stage: { select: { key: true, name: true } },
            assigneeId: true,
            createdAt: true,
          },
        },
      },
    });
    return {
      duplicate: !!found,
      contact: found ?? null,
      enrollmentCount: found?.enrollments.length ?? 0,
    };
  });

  fastify.put('/:id', async (req) => {
    const user = await fastify.requireAuth(req);
    requireCapability(user, 'contact.write');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = updateBody.parse(req.body);
    return prisma.contact.update({ where: { id }, data: body });
  });
};

export default routes;
