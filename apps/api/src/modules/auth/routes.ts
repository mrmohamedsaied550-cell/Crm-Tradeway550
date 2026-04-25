import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import crypto from 'node:crypto';
import { prisma } from '../../lib/prisma.js';
import { verifyPassword } from '../../lib/password.js';
import {
  hashToken,
  refreshExpiry,
  signAccess,
  signRefresh,
  verifyRefresh,
} from '../../lib/jwt.js';
import { unauthorized } from '../../lib/errors.js';
import { buildScope, hasCapability } from '../../lib/rbac.js';
import { CAPABILITIES } from '@crm/shared';

const loginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const refreshBody = z.object({
  refreshToken: z.string().min(1),
});

async function issueTokensFor(userId: string, role: string, email: string, rotatedFromId?: string) {
  const sid = crypto.randomUUID();
  const jti = crypto.randomUUID();
  const accessToken = signAccess({ sub: userId, role: role as never, email });
  const refreshToken = signRefresh({ sub: userId, sid, jti });
  await prisma.userSession.create({
    data: {
      id: sid,
      userId,
      refreshTokenHash: hashToken(refreshToken),
      expiresAt: refreshExpiry(),
      rotatedFromId: rotatedFromId ?? null,
    },
  });
  return { accessToken, refreshToken };
}

const routes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/login', async (req) => {
    const { email, password } = loginBody.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !user.active) throw unauthorized('Invalid credentials');
    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) throw unauthorized('Invalid credentials');
    const tokens = await issueTokensFor(user.id, user.role, user.email);
    return {
      ...tokens,
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
    };
  });

  fastify.post('/refresh', async (req) => {
    const { refreshToken } = refreshBody.parse(req.body);
    let payload;
    try {
      payload = verifyRefresh(refreshToken);
    } catch {
      throw unauthorized('Invalid refresh token');
    }
    const session = await prisma.userSession.findUnique({
      where: { id: payload.sid },
    });
    if (!session || session.revoked) throw unauthorized('Session revoked');
    if (session.refreshTokenHash !== hashToken(refreshToken))
      throw unauthorized('Token mismatch');
    if (session.expiresAt < new Date()) throw unauthorized('Refresh expired');

    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || !user.active) throw unauthorized('User inactive');

    // rotate: revoke old, mint new
    await prisma.userSession.update({
      where: { id: session.id },
      data: { revoked: true },
    });
    const tokens = await issueTokensFor(user.id, user.role, user.email, session.id);
    return tokens;
  });

  fastify.post('/logout', async (req, reply) => {
    const user = await fastify.requireAuth(req);
    const body = z.object({ refreshToken: z.string().optional() }).parse(req.body ?? {});
    if (body.refreshToken) {
      try {
        const payload = verifyRefresh(body.refreshToken);
        if (payload.sub === user.id) {
          await prisma.userSession.updateMany({
            where: { id: payload.sid, userId: user.id, revoked: false },
            data: { revoked: true },
          });
        }
      } catch {
        // ignore — already invalid
      }
    }
    return reply.send({ ok: true });
  });

  fastify.post('/logout-all', async (req, reply) => {
    const user = await fastify.requireAuth(req);
    await prisma.userSession.updateMany({
      where: { userId: user.id, revoked: false },
      data: { revoked: true },
    });
    return reply.send({ ok: true });
  });

  fastify.get('/me', async (req) => {
    const user = await fastify.requireAuth(req);
    const dbUser = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        active: true,
        onLeave: true,
      },
    });
    const scope = await buildScope(user);
    const caps = CAPABILITIES.filter((c) => hasCapability(user.role, c));
    return { user: dbUser, capabilities: caps, scope };
  });
};

export default routes;
