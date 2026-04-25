import { eq, and, isNull, gt } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { users, type User } from '../../db/schema/users.js';
import { userSessions } from '../../db/schema/sessions.js';
import { hashPassword, verifyPassword } from '../../lib/password.js';
import { generateRefreshToken, hashToken } from '../../lib/jwt.js';
import { parseDuration } from '../../lib/duration.js';
import { env } from '../../lib/env.js';
import { ConflictError, NotFoundError, UnauthorizedError } from '../../lib/errors.js';
import type { FastifyInstance } from 'fastify';

export class AuthService {
  constructor(private readonly app: FastifyInstance) {}

  async register(input: {
    name: string;
    email: string;
    password: string;
    role: 'super_admin' | 'manager' | 'team_leader' | 'sales_agent';
    countryCode?: string;
  }): Promise<User> {
    const existing = await db.select().from(users).where(eq(users.email, input.email)).limit(1);
    if (existing.length > 0) {
      throw new ConflictError('Email already in use');
    }
    const passwordHash = await hashPassword(input.password);
    await db.insert(users).values({
      name: input.name,
      email: input.email,
      passwordHash,
      role: input.role,
      countryCode: input.countryCode,
    });
    const [created] = await db.select().from(users).where(eq(users.email, input.email)).limit(1);
    if (!created) throw new Error('Failed to create user');
    return created;
  }

  async login(input: { email: string; password: string; userAgent?: string; ipAddress?: string }) {
    const [user] = await db.select().from(users).where(eq(users.email, input.email)).limit(1);
    if (!user || !user.isActive) {
      throw new UnauthorizedError('Invalid credentials');
    }
    const ok = await verifyPassword(user.passwordHash, input.password);
    if (!ok) throw new UnauthorizedError('Invalid credentials');

    await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));

    return this.issueTokens(user, input.userAgent, input.ipAddress);
  }

  async refresh(input: { refreshToken: string; userAgent?: string; ipAddress?: string }) {
    const tokenHash = hashToken(input.refreshToken);
    const [session] = await db
      .select()
      .from(userSessions)
      .where(
        and(
          eq(userSessions.refreshTokenHash, tokenHash),
          isNull(userSessions.revokedAt),
          gt(userSessions.expiresAt, new Date()),
        ),
      )
      .limit(1);
    if (!session) throw new UnauthorizedError('Invalid refresh token');

    const [user] = await db.select().from(users).where(eq(users.id, session.userId)).limit(1);
    if (!user || !user.isActive) throw new UnauthorizedError();

    // Rotate: revoke this session, issue a new pair.
    await db
      .update(userSessions)
      .set({ revokedAt: new Date() })
      .where(eq(userSessions.id, session.id));

    return this.issueTokens(user, input.userAgent, input.ipAddress);
  }

  async logout(refreshToken: string) {
    const tokenHash = hashToken(refreshToken);
    await db
      .update(userSessions)
      .set({ revokedAt: new Date() })
      .where(eq(userSessions.refreshTokenHash, tokenHash));
  }

  async logoutAll(userId: string) {
    await db
      .update(userSessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(userSessions.userId, userId), isNull(userSessions.revokedAt)));
  }

  async getMe(userId: string) {
    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) throw new NotFoundError('User');
    const { passwordHash: _ph, ...safe } = user;
    return safe;
  }

  private async issueTokens(user: User, userAgent?: string, ipAddress?: string) {
    const accessToken = await this.app.jwt.sign(
      {
        sub: user.id,
        email: user.email,
        role: user.role,
        countryCode: user.countryCode,
        teamId: user.teamId,
      },
      { expiresIn: env.JWT_ACCESS_TTL },
    );

    const refreshToken = generateRefreshToken();
    const expiresAt = new Date(Date.now() + parseDuration(env.JWT_REFRESH_TTL));
    await db.insert(userSessions).values({
      userId: user.id,
      refreshTokenHash: hashToken(refreshToken),
      userAgent: userAgent?.slice(0, 500),
      ipAddress,
      expiresAt,
    });

    const { passwordHash: _ph, ...safe } = user;
    return { accessToken, refreshToken, user: safe };
  }
}
