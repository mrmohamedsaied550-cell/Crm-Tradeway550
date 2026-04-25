import crypto from 'node:crypto';

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function generateRefreshToken(): string {
  return crypto.randomBytes(48).toString('base64url');
}

export interface JwtPayload {
  sub: string;
  role: string;
  email: string;
  countryCode?: string | null;
  teamId?: string | null;
}
