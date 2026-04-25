import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { verifyAccess } from '../lib/jwt.js';
import { unauthorized } from '../lib/errors.js';
import type { AuthUser } from '../lib/rbac.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
  }
  interface FastifyInstance {
    requireAuth: (req: FastifyRequest) => Promise<AuthUser>;
  }
}

const authPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.decorate('requireAuth', async (req: FastifyRequest): Promise<AuthUser> => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) throw unauthorized('Missing bearer token');
    const token = header.slice('Bearer '.length).trim();
    try {
      const payload = verifyAccess(token);
      const user: AuthUser = { id: payload.sub, role: payload.role, email: payload.email };
      req.user = user;
      return user;
    } catch {
      throw unauthorized('Invalid or expired token');
    }
  });
};

export default fp(authPlugin, { name: 'auth' });
