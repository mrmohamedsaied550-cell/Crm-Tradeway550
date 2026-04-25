import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AuthService } from './auth.service.js';
import { authenticate } from '../../middleware/auth.js';
import { UnauthorizedError } from '../../lib/errors.js';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

export async function authRoutes(app: FastifyInstance) {
  const service = new AuthService(app);

  app.post('/login', async (req, reply) => {
    const body = loginSchema.parse(req.body);
    const result = await service.login({
      email: body.email,
      password: body.password,
      userAgent: req.headers['user-agent'],
      ipAddress: req.ip,
    });
    return reply.send(result);
  });

  app.post('/refresh', async (req, reply) => {
    const body = refreshSchema.parse(req.body);
    const result = await service.refresh({
      refreshToken: body.refreshToken,
      userAgent: req.headers['user-agent'],
      ipAddress: req.ip,
    });
    return reply.send(result);
  });

  app.post('/logout', async (req, reply) => {
    const body = refreshSchema.parse(req.body);
    await service.logout(body.refreshToken);
    return reply.status(204).send();
  });

  app.post('/logout-all', { preHandler: authenticate }, async (req, reply) => {
    if (!req.actor) throw new UnauthorizedError();
    await service.logoutAll(req.actor.id);
    return reply.status(204).send();
  });

  app.get('/me', { preHandler: authenticate }, async (req, reply) => {
    if (!req.actor) throw new UnauthorizedError();
    const user = await service.getMe(req.actor.id);
    return reply.send({ user });
  });
}
