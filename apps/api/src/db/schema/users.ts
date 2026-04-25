import { mysqlTable, varchar, timestamp, mysqlEnum, boolean, int } from 'drizzle-orm/mysql-core';
import { relations } from 'drizzle-orm';
import { nanoid } from 'nanoid';

export const users = mysqlTable('users', {
  id: varchar('id', { length: 24 }).primaryKey().$defaultFn(() => nanoid()),
  name: varchar('name', { length: 120 }).notNull(),
  email: varchar('email', { length: 191 }).notNull().unique(),
  phone: varchar('phone', { length: 32 }),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  role: mysqlEnum('role', ['super_admin', 'manager', 'team_leader', 'sales_agent']).notNull(),
  countryCode: varchar('country_code', { length: 2 }),
  teamId: varchar('team_id', { length: 24 }),
  managerId: varchar('manager_id', { length: 24 }),
  isActive: boolean('is_active').notNull().default(true),
  isOnLeave: boolean('is_on_leave').notNull().default(false),
  dailyLeadCap: int('daily_lead_cap'),
  lastLoginAt: timestamp('last_login_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
});

export const teams = mysqlTable('teams', {
  id: varchar('id', { length: 24 }).primaryKey().$defaultFn(() => nanoid()),
  name: varchar('name', { length: 120 }).notNull(),
  type: mysqlEnum('type', ['sales', 'activation', 'driving']).notNull().default('sales'),
  countryCode: varchar('country_code', { length: 2 }).notNull(),
  companyId: varchar('company_id', { length: 24 }),
  leaderId: varchar('leader_id', { length: 24 }),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
});

export const usersRelations = relations(users, ({ one }) => ({
  team: one(teams, {
    fields: [users.teamId],
    references: [teams.id],
  }),
  manager: one(users, {
    fields: [users.managerId],
    references: [users.id],
    relationName: 'manager',
  }),
}));

export const teamsRelations = relations(teams, ({ one, many }) => ({
  leader: one(users, {
    fields: [teams.leaderId],
    references: [users.id],
  }),
  members: many(users),
}));

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Team = typeof teams.$inferSelect;
export type NewTeam = typeof teams.$inferInsert;
