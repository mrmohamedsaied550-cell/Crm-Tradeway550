import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { requireCapability } from '../../lib/rbac.js';
import { badRequest, notFound } from '../../lib/errors.js';

const ccParam = z.object({ ccId: z.string().uuid() });
const stageParam = z.object({ ccId: z.string().uuid(), id: z.string().uuid() });

const createBody = z.object({
  key: z.string().min(1).regex(/^[a-z0-9_]+$/),
  name: z.string().min(1),
  order: z.number().int().nonnegative(),
  requiresApproval: z.boolean().optional(),
  triggersEvent: z.string().nullable().optional(),
  isTerminal: z.boolean().optional(),
  active: z.boolean().optional(),
});

const updateBody = createBody.partial();

const reorderBody = z.object({
  items: z.array(
    z.object({ id: z.string().uuid(), order: z.number().int().nonnegative() }),
  ),
});

const routes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/:ccId/stages', async (req) => {
    const user = await fastify.requireAuth(req);
    requireCapability(user, 'pipeline.read');
    const { ccId } = ccParam.parse(req.params);
    return prisma.pipelineStage.findMany({
      where: { companyCountryId: ccId },
      orderBy: { order: 'asc' },
    });
  });

  fastify.post('/:ccId/stages', async (req, reply) => {
    const user = await fastify.requireAuth(req);
    requireCapability(user, 'pipeline.write');
    const { ccId } = ccParam.parse(req.params);
    const body = createBody.parse(req.body);
    const created = await prisma.pipelineStage.create({
      data: { ...body, companyCountryId: ccId },
    });
    return reply.status(201).send(created);
  });

  fastify.put('/:ccId/stages/reorder', async (req) => {
    const user = await fastify.requireAuth(req);
    requireCapability(user, 'pipeline.write');
    const { ccId } = ccParam.parse(req.params);
    const { items } = reorderBody.parse(req.body);
    if (items.length === 0) throw badRequest('No items to reorder');

    return prisma.$transaction(async (tx) => {
      // two-phase: shift to negative offsets first to avoid unique conflicts
      for (const [i, item] of items.entries()) {
        await tx.pipelineStage.update({
          where: { id: item.id },
          data: { order: -(i + 1) },
        });
      }
      for (const item of items) {
        await tx.pipelineStage.update({
          where: { id: item.id },
          data: { order: item.order },
        });
      }
      return tx.pipelineStage.findMany({
        where: { companyCountryId: ccId },
        orderBy: { order: 'asc' },
      });
    });
  });

  fastify.put('/:ccId/stages/:id', async (req) => {
    const user = await fastify.requireAuth(req);
    requireCapability(user, 'pipeline.write');
    const { id } = stageParam.parse(req.params);
    const body = updateBody.parse(req.body);
    const found = await prisma.pipelineStage.findUnique({ where: { id } });
    if (!found) throw notFound('Stage not found');
    return prisma.pipelineStage.update({ where: { id }, data: body });
  });

  fastify.delete('/:ccId/stages/:id', async (req, reply) => {
    const user = await fastify.requireAuth(req);
    requireCapability(user, 'pipeline.write');
    const { id } = stageParam.parse(req.params);
    const inUse = await prisma.enrollment.count({ where: { stageId: id } });
    if (inUse > 0) throw badRequest('Cannot delete stage with active enrollments');
    await prisma.pipelineStage.delete({ where: { id } });
    return reply.status(204).send();
  });
};

export default routes;
