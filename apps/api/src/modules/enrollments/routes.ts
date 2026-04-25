import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import {
  buildScope,
  enrollmentScopeWhere,
  requireCapability,
} from '../../lib/rbac.js';
import { writeTimeline } from '../../utils/timeline.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';

const createBody = z.object({
  contactId: z.string().uuid(),
  companyCountryId: z.string().uuid(),
  source: z.string().optional(),
  assigneeId: z.string().uuid().optional(),
});

const updateBody = z.object({
  source: z.string().optional(),
  assigneeId: z.string().uuid().nullable().optional(),
});

const stageBody = z.object({
  toStageId: z.string().uuid(),
  reason: z.string().optional(),
});

const assignBody = z.object({
  assigneeId: z.string().uuid().nullable(),
  reason: z.string().optional(),
});

const noteBody = z.object({
  text: z.string().min(1),
});

const enrollmentInclude = {
  contact: { select: { id: true, fullName: true, phone: true, countryId: true } },
  companyCountry: {
    select: {
      id: true,
      company: { select: { name: true, slug: true } },
      country: { select: { code: true, name: true } },
    },
  },
  stage: { select: { id: true, key: true, name: true, requiresApproval: true } },
  assignee: { select: { id: true, name: true, email: true, role: true } },
} as const;

const routes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', async (req) => {
    const user = await fastify.requireAuth(req);
    requireCapability(user, 'enrollment.read');
    const scope = await buildScope(user);
    return prisma.enrollment.findMany({
      where: enrollmentScopeWhere(scope),
      include: enrollmentInclude,
      orderBy: { updatedAt: 'desc' },
      take: 200,
    });
  });

  fastify.get('/:id', async (req) => {
    const user = await fastify.requireAuth(req);
    requireCapability(user, 'enrollment.read');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const scope = await buildScope(user);
    const where = { ...enrollmentScopeWhere(scope), id };
    const found = await prisma.enrollment.findFirst({ where, include: enrollmentInclude });
    if (!found) throw notFound('Enrollment not found');
    return found;
  });

  fastify.post('/', async (req, reply) => {
    const user = await fastify.requireAuth(req);
    requireCapability(user, 'enrollment.create');
    const body = createBody.parse(req.body);

    const dup = await prisma.enrollment.findUnique({
      where: {
        contactId_companyCountryId: {
          contactId: body.contactId,
          companyCountryId: body.companyCountryId,
        },
      },
    });
    if (dup) throw conflict('Enrollment already exists for this contact in this company-country');

    const firstStage = await prisma.pipelineStage.findFirst({
      where: { companyCountryId: body.companyCountryId, active: true },
      orderBy: { order: 'asc' },
    });
    if (!firstStage) throw badRequest('No pipeline stages defined for this company-country');

    const created = await prisma.$transaction(async (tx) => {
      const enrollment = await tx.enrollment.create({
        data: {
          contactId: body.contactId,
          companyCountryId: body.companyCountryId,
          stageId: firstStage.id,
          assigneeId: body.assigneeId ?? null,
          source: body.source,
          createdById: user.id,
        },
        include: enrollmentInclude,
      });
      await writeTimeline({
        tx,
        enrollmentId: enrollment.id,
        actorId: user.id,
        type: 'created',
        payload: { source: body.source ?? null, stageKey: firstStage.key },
      });
      if (body.assigneeId) {
        await writeTimeline({
          tx,
          enrollmentId: enrollment.id,
          actorId: user.id,
          type: 'assigned',
          payload: { from: null, to: body.assigneeId },
        });
      }
      return enrollment;
    });
    return reply.status(201).send(created);
  });

  fastify.put('/:id', async (req) => {
    const user = await fastify.requireAuth(req);
    requireCapability(user, 'enrollment.update');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = updateBody.parse(req.body);
    const scope = await buildScope(user);
    const found = await prisma.enrollment.findFirst({
      where: { ...enrollmentScopeWhere(scope), id },
    });
    if (!found) throw notFound('Enrollment not found');
    return prisma.enrollment.update({
      where: { id },
      data: body,
      include: enrollmentInclude,
    });
  });

  fastify.put('/:id/stage', async (req, reply) => {
    const user = await fastify.requireAuth(req);
    requireCapability(user, 'enrollment.changeStage');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { toStageId, reason } = stageBody.parse(req.body);

    const scope = await buildScope(user);
    const enrollment = await prisma.enrollment.findFirst({
      where: { ...enrollmentScopeWhere(scope), id },
      include: { stage: true },
    });
    if (!enrollment) throw notFound('Enrollment not found');

    const target = await prisma.pipelineStage.findUnique({ where: { id: toStageId } });
    if (!target || target.companyCountryId !== enrollment.companyCountryId) {
      throw badRequest('Target stage does not belong to this enrollment pipeline');
    }
    if (!target.active) throw badRequest('Target stage is inactive');
    if (target.id === enrollment.stageId) throw badRequest('Already at target stage');

    if (target.requiresApproval) {
      const existing = await prisma.approval.findFirst({
        where: { enrollmentId: enrollment.id, status: 'pending', toStageId: target.id },
      });
      if (existing) throw conflict('Pending approval already requested for this transition');
      const approval = await prisma.$transaction(async (tx) => {
        const a = await tx.approval.create({
          data: {
            enrollmentId: enrollment.id,
            toStageId: target.id,
            requestedById: user.id,
            reason,
          },
        });
        await writeTimeline({
          tx,
          enrollmentId: enrollment.id,
          actorId: user.id,
          type: 'approval_requested',
          payload: { approvalId: a.id, toStageKey: target.key, reason: reason ?? null },
        });
        return a;
      });
      return reply.status(202).send({ approval, status: 'pending_approval' });
    }

    const updated = await prisma.$transaction(async (tx) => {
      const u = await tx.enrollment.update({
        where: { id: enrollment.id },
        data: { stageId: target.id },
        include: enrollmentInclude,
      });
      await writeTimeline({
        tx,
        enrollmentId: enrollment.id,
        actorId: user.id,
        type: 'stage_changed',
        payload: {
          from: enrollment.stage.key,
          to: target.key,
          reason: reason ?? null,
        },
      });
      return u;
    });
    return updated;
  });

  fastify.put('/:id/assign', async (req) => {
    const user = await fastify.requireAuth(req);
    requireCapability(user, 'enrollment.assign');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = assignBody.parse(req.body);

    const scope = await buildScope(user);
    const enrollment = await prisma.enrollment.findFirst({
      where: { ...enrollmentScopeWhere(scope), id },
    });
    if (!enrollment) throw notFound('Enrollment not found');

    if (body.assigneeId) {
      const targetUser = await prisma.userAssignment.findFirst({
        where: { userId: body.assigneeId, companyCountryId: enrollment.companyCountryId },
      });
      if (!targetUser)
        throw forbidden('Target user is not assigned to this company-country');
    }

    return prisma.$transaction(async (tx) => {
      const updated = await tx.enrollment.update({
        where: { id },
        data: { assigneeId: body.assigneeId },
        include: enrollmentInclude,
      });
      await writeTimeline({
        tx,
        enrollmentId: id,
        actorId: user.id,
        type: 'assigned',
        payload: { from: enrollment.assigneeId, to: body.assigneeId, reason: body.reason ?? null },
      });
      return updated;
    });
  });

  fastify.post('/:id/notes', async (req, reply) => {
    const user = await fastify.requireAuth(req);
    requireCapability(user, 'enrollment.note');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = noteBody.parse(req.body);

    const scope = await buildScope(user);
    const enrollment = await prisma.enrollment.findFirst({
      where: { ...enrollmentScopeWhere(scope), id },
    });
    if (!enrollment) throw notFound('Enrollment not found');

    const event = await writeTimeline({
      enrollmentId: id,
      actorId: user.id,
      type: 'note_added',
      payload: { text: body.text },
    });
    return reply.status(201).send(event);
  });

  fastify.get('/:id/timeline', async (req) => {
    const user = await fastify.requireAuth(req);
    requireCapability(user, 'enrollment.read');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const scope = await buildScope(user);
    const enrollment = await prisma.enrollment.findFirst({
      where: { ...enrollmentScopeWhere(scope), id },
      select: { id: true },
    });
    if (!enrollment) throw notFound('Enrollment not found');
    return prisma.enrollmentTimeline.findMany({
      where: { enrollmentId: id },
      include: { actor: { select: { id: true, name: true, role: true } } },
      orderBy: { createdAt: 'asc' },
    });
  });
};

export default routes;
