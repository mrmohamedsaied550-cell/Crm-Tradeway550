import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { users, teams } from '../../db/schema/users.js';
import { authenticate, requireCapability } from '../../middleware/auth.js';
import { hashPassword } from '../../lib/password.js';
import { ConflictError, NotFoundError } from '../../lib/errors.js';

const createUserSchema = z.object({
  name: z.string().min(2).max(120),
  email: z.string().email(),
  password: z.string().min(6).max(128),
  phone: z.string().max(32).optional(),
  role: z.enum(['super_admin', 'manager', 'team_leader', 'sales_agent']),
  countryCode: z.string().length(2).optional(),
  teamId: z.string().optional(),
  managerId: z.string().optional(),
  dailyLeadCap: z.number().int().positive().optional(),
});

const updateUserSchema = createUserSchema.partial().omit({ password: true }).extend({
  isActive: z.boolean().optional(),
  isOnLeave: z.boolean().optional(),
});

const teamSchema = z.object({
  name: z.string().min(2).max(120),
  type: z.enum(['sales', 'activation', 'driving']).default('sales'),
  countryCode: z.string().length(2),
  companyId: z.string().optional(),
  leaderId: z.string().optional(),
});

const sanitize = <T extends { passwordHash?: string }>(u: T) => {
  const { passwordHash: _ph, ...safe } = u;
  return safe;
};

export async function usersRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  app.get('/', async (req, reply) => {
    const q = z.object({
      role: z.enum(['super_admin', 'manager', 'team_leader', 'sales_agent']).optional(),
      countryCode: z.string().length(2).optional(),
      teamId: z.string().optional(),
    }).parse(req.query);

    const conditions = [];
    if (q.role) conditions.push(eq(users.role, q.role));
    if (q.countryCode) conditions.push(eq(users.countryCode, q.countryCode));
    if (q.teamId) conditions.push(eq(users.teamId, q.teamId));

    const list = await db
      .select()
      .from(users)
      .where(conditions.length > 0 ? and(...conditions) : undefined);

    return reply.send({ items: list.map(sanitize) });
  });

  app.get('/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!user) throw new NotFoundError('User');
    return reply.send(sanitize(user));
  });

  app.post('/', { preHandler: requireCapability('users.manage') }, async (req, reply) => {
    const body = createUserSchema.parse(req.body);
    const existing = await db.select().from(users).where(eq(users.email, body.email)).limit(1);
    if (existing.length > 0) throw new ConflictError('Email already in use');

    const passwordHash = await hashPassword(body.password);
    await db.insert(users).values({
      name: body.name,
      email: body.email,
      phone: body.phone,
      passwordHash,
      role: body.role,
      countryCode: body.countryCode,
      teamId: body.teamId,
      managerId: body.managerId,
      dailyLeadCap: body.dailyLeadCap,
    });
    const [created] = await db.select().from(users).where(eq(users.email, body.email)).limit(1);
    return reply.status(201).send(sanitize(created!));
  });

  app.put('/:id', { preHandler: requireCapability('users.manage') }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = updateUserSchema.parse(req.body);
    await db.update(users).set(body).where(eq(users.id, id));
    const [updated] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!updated) throw new NotFoundError('User');
    return reply.send(sanitize(updated));
  });

  // ===== Teams =====
  app.get('/teams/list', async (req, reply) => {
    const q = z.object({ countryCode: z.string().length(2).optional() }).parse(req.query);
    const list = await db
      .select()
      .from(teams)
      .where(q.countryCode ? eq(teams.countryCode, q.countryCode) : undefined);
    return reply.send({ items: list });
  });

  app.post('/teams', { preHandler: requireCapability('users.manage') }, async (req, reply) => {
    const body = teamSchema.parse(req.body);
    await db.insert(teams).values(body);
    return reply.status(201).send({ ok: true });
  });
}
