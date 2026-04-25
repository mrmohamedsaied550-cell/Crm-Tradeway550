import { mysqlTable, varchar, timestamp, boolean, int, json, mysqlEnum } from 'drizzle-orm/mysql-core';
import { relations } from 'drizzle-orm';
import { nanoid } from 'nanoid';

/**
 * Lead statuses (sub-status within a stage).
 * Configurable per (company × country).
 * Examples: new, no_answer, contacted, follow_up, rejected.
 */
export const leadStatuses = mysqlTable('lead_statuses', {
  id: varchar('id', { length: 24 }).primaryKey().$defaultFn(() => nanoid()),
  companyCountryId: varchar('company_country_id', { length: 24 }),
  code: varchar('code', { length: 64 }).notNull(),
  nameAr: varchar('name_ar', { length: 80 }).notNull(),
  nameEn: varchar('name_en', { length: 80 }).notNull(),
  color: varchar('color', { length: 32 }).notNull().default('#94a3b8'),
  icon: varchar('icon', { length: 64 }),
  order: int('order').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  isTerminal: boolean('is_terminal').notNull().default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
});

/**
 * Driver journey stages (high-level phases).
 * Examples: awaiting_docs, awaiting_activation, active, dft.
 */
export const stages = mysqlTable('stages', {
  id: varchar('id', { length: 24 }).primaryKey().$defaultFn(() => nanoid()),
  companyCountryId: varchar('company_country_id', { length: 24 }),
  code: varchar('code', { length: 64 }).notNull(),
  nameAr: varchar('name_ar', { length: 80 }).notNull(),
  nameEn: varchar('name_en', { length: 80 }).notNull(),
  color: varchar('color', { length: 32 }).notNull().default('#3b82f6'),
  icon: varchar('icon', { length: 64 }),
  teamType: mysqlEnum('team_type', ['sales', 'activation', 'driving', 'none']).notNull().default('sales'),
  order: int('order').notNull().default(0),
  requiredFields: json('required_fields').$type<string[]>(),
  approvalRequired: mysqlEnum('approval_required', ['none', 'team_leader', 'manager', 'admin']).notNull().default('none'),
  slaMinutes: int('sla_minutes'),
  isActive: boolean('is_active').notNull().default(true),
  isTerminal: boolean('is_terminal').notNull().default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
});

/**
 * Standardized rejection reasons.
 * Used to power accurate analytics.
 */
export const rejectReasons = mysqlTable('reject_reasons', {
  id: varchar('id', { length: 24 }).primaryKey().$defaultFn(() => nanoid()),
  code: varchar('code', { length: 64 }).notNull().unique(),
  nameAr: varchar('name_ar', { length: 120 }).notNull(),
  nameEn: varchar('name_en', { length: 120 }).notNull(),
  category: varchar('category', { length: 64 }),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const leadStatusesRelations = relations(leadStatuses, ({ one }) => ({
  // companyCountry relation declared in companies module via FK if needed
}));

export type LeadStatus = typeof leadStatuses.$inferSelect;
export type NewLeadStatus = typeof leadStatuses.$inferInsert;
export type Stage = typeof stages.$inferSelect;
export type NewStage = typeof stages.$inferInsert;
export type RejectReason = typeof rejectReasons.$inferSelect;
