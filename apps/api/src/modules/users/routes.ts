import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { hashPassword } from '../../lib/password.js';
import { buildScope, requireCapability, userScopeWhere } from '../../lib/rbac.js';
import { notFound, conflict } from '../../lib/errors.js';
import { ROLES } from '@crm/shared';

const roleEnum = z.enum(ROLES);

const createBody = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  password: z.string().min(8),
  role: roleEnum,
  assignments: z
    .array(
      z.object({
        companyCountryId: z.string().uuid(),
        parentUserId: z.string().uuid().nullable().optional(),
      }),
    )
    .default([]),
});

const updateBody = z.object({
  name: z.string().min(1).optional(),
  active: z.boolean().optional(),
  role: roleEnum.optional(),
  password: z.string().min(8).optional(),
});

const assignmentBody = z.object({
  companyCountryId: z.string().uuid(),
  parentUserId: z.string().uuid().nullable().optional(),
});

const leaveBody = z.object({ onLeave: z.boolean() });

const userSelect = {
  id: true,
  email: true,
  name: true,
  role: true,
  active: true,
  onLeave: true,
  createdAt: true,
  assignments: {
    select: {
      id: true,
      companyCountryId: true,
      parentUserId: true,
    },
  },
} as const;

const routes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', async (req) => {
    const user = await fastify.requireAuth(req);
    requireCapability(user, 'user.read');
    const scope = await buildScope(user);
    return prisma.user.findMany({
      where: userScopeWhere(scope),
      select: userSelect,
      orderBy: { createdAt: 'desc' },
    });
  });

  fastify.get('/:id', async (req) => {
    const user = await fastify.requireAuth(req);
    requireCapability(user, 'user.read');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const scope = await buildScope(user);
    const where = { ...userScopeWhere(scope), id };
    const found = await prisma.user.findFirst({ where, select: userSelect });
    if (!found) throw notFound('User not found');
    return found;
  });

  fastify.post('/', async (req, reply) => {
    const actor = await fastify.requireAuth(req);
    requireCapability(actor, 'user.create');
    const data = createBody.parse(req.body);
    const exists = await prisma.user.findUnique({ where: { email: data.email } });
    if (exists) throw conflict('Email already exists');
    const passwordHash = await hashPassword(data.password);
    const created = await prisma.user.create({
      data: {
        email: data.email,
        name: data.name,
        passwordHash,
        role: data.role,
        assignments: data.assignments.length
          ? {
              create: data.assignments.map((a) => ({
                companyCountryId: a.companyCountryId,
                parentUserId: a.parentUserId ?? null,
              })),
            }
          : undefined,
      },
      select: userSelect,
    });
    return reply.status(201).send(created);
  });

  fastify.put('/:id', async (req) => {
    const actor = await fastify.requireAuth(req);
    requireCapability(actor, 'user.update');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = updateBody.parse(req.body);
    const data: Record<string, unknown> = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.active !== undefined) data.active = body.active;
    if (body.role !== undefined) data.role = body.role;
    if (body.password !== undefined) data.passwordHash = await hashPassword(body.password);
    return prisma.user.update({ where: { id }, data, select: userSelect });
  });

  fastify.post('/:id/assignments', async (req, reply) => {
    const actor = await fastify.requireAuth(req);
    requireCapability(actor, 'user.assign');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = assignmentBody.parse(req.body);
    const created = await prisma.userAssignment.create({
      data: {
        userId: id,
        companyCountryId: body.companyCountryId,
        parentUserId: body.parentUserId ?? null,
      },
    });
    return reply.status(201).send(created);
  });

  fastify.delete('/:id/assignments/:assignmentId', async (req, reply) => {
    const actor = await fastify.requireAuth(req);
    requireCapability(actor, 'user.assign');
    const { assignmentId } = z
      .object({ id: z.string().uuid(), assignmentId: z.string().uuid() })
      .parse(req.params);
    await prisma.userAssignment.delete({ where: { id: assignmentId } });
    return reply.status(204).send();
  });

  fastify.put('/:id/leave', async (req) => {
    const actor = await fastify.requireAuth(req);
    requireCapability(actor, 'user.update');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { onLeave } = leaveBody.parse(req.body);
    return prisma.user.update({
      where: { id },
      data: { onLeave },
      select: userSelect,
    });
  });
};

export default routes;
