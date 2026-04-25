import { mysqlTable, varchar, timestamp, index } from 'drizzle-orm/mysql-core';
import { nanoid } from 'nanoid';

/**
 * Refresh token sessions for JWT auth.
 * Storing the token hash lets us revoke individual sessions ("logout other devices").
 */
export const userSessions = mysqlTable('user_sessions', {
  id: varchar('id', { length: 24 }).primaryKey().$defaultFn(() => nanoid()),
  userId: varchar('user_id', { length: 24 }).notNull(),
  refreshTokenHash: varchar('refresh_token_hash', { length: 191 }).notNull(),
  userAgent: varchar('user_agent', { length: 500 }),
  ipAddress: varchar('ip_address', { length: 64 }),
  expiresAt: timestamp('expires_at').notNull(),
  revokedAt: timestamp('revoked_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (t) => ({
  idxUser: index('idx_session_user').on(t.userId),
  idxToken: index('idx_session_token').on(t.refreshTokenHash),
}));

export type UserSession = typeof userSessions.$inferSelect;
export type NewUserSession = typeof userSessions.$inferInsert;
