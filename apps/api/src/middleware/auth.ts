import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Role, Capability } from '../lib/rbac';
import { computeScope, hasCapability } from '../lib/rbac';
import { ForbiddenError, UnauthorizedError } from '../lib/errors';

declare module 'fastify' {
  interface FastifyRequest {
    actor?: {
      id: string;
      email: string;
      role: Role;
      countryCode: string | null;
      teamId: string | null;
    };
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: {
      sub: string;
      email: string;
      role: Role;
      countryCode?: string | null;
      teamId?: string | null;
    };
    user: {
      sub: string;
      email: string;
      role: Role;
      countryCode?: string | null;
      teamId?: string | null;
    };
  }
}

export async function authenticate(req: FastifyRequest, _reply: FastifyReply) {
  try {
    await req.jwtVerify();
    const decoded = req.user;
    req.actor = {
      id: decoded.sub,
      email: decoded.email,
      role: decoded.role,
      countryCode: decoded.countryCode ?? null,
      teamId: decoded.teamId ?? null,
    };
  } catch {
    throw new UnauthorizedError('Invalid or expired token');
  }
}

export function requireCapability(capability: Capability) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    if (!req.actor) throw new UnauthorizedError();
    if (!hasCapability(req.actor.role, capability)) {
      throw new ForbiddenError(`Missing capability: ${capability}`);
    }
  };
}

export function actorScope(req: FastifyRequest) {
  if (!req.actor) throw new UnauthorizedError();
  return computeScope({
    id: req.actor.id,
    role: req.actor.role,
    countryCode: req.actor.countryCode,
    teamId: req.actor.teamId,
  });
}
