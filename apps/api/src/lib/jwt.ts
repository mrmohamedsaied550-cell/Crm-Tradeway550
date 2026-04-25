import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { env } from '../config/env.js';
import type { Role } from '@crm/shared';

export interface AccessPayload {
  sub: string; // user id
  role: Role;
  email: string;
}

export interface RefreshPayload {
  sub: string;
  sid: string; // session id
  jti: string; // unique per token (used for hash)
}

export const signAccess = (payload: AccessPayload) =>
  jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: `${env.JWT_ACCESS_TTL_MIN}m`,
  });

export const verifyAccess = (token: string): AccessPayload =>
  jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessPayload;

export const signRefresh = (payload: RefreshPayload) =>
  jwt.sign(payload, env.JWT_REFRESH_SECRET, {
    expiresIn: `${env.JWT_REFRESH_TTL_DAYS}d`,
  });

export const verifyRefresh = (token: string): RefreshPayload =>
  jwt.verify(token, env.JWT_REFRESH_SECRET) as RefreshPayload;

export const hashToken = (token: string) =>
  crypto.createHash('sha256').update(token).digest('hex');

export const refreshExpiry = () =>
  new Date(Date.now() + env.JWT_REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000);
