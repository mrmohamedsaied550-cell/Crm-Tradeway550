import { mysqlTable, varchar, timestamp, mysqlEnum, boolean, json, decimal, index } from 'drizzle-orm/mysql-core';
import { relations } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { companyCountries } from './companies.js';

/**
 * Marketing campaigns — Meta, TikTok, manual, referrals.
 * Routing rules drive how leads from this campaign get assigned.
 */
export const campaigns = mysqlTable('campaigns', {
  id: varchar('id', { length: 24 }).primaryKey().$defaultFn(() => nanoid()),
  name: varchar('name', { length: 160 }).notNull(),
  code: varchar('code', { length: 64 }).notNull().unique(),
  platform: mysqlEnum('platform', ['meta', 'tiktok', 'google', 'referral', 'manual', 'sheet', 'other']).notNull(),
  companyCountryId: varchar('company_country_id', { length: 24 }).notNull(),

  budget: decimal('budget', { precision: 12, scale: 2 }),
  currency: varchar('currency', { length: 3 }),

  routingMode: mysqlEnum('routing_mode', [
    'round_robin',
    'percentage',
    'capacity',
    'performance',
    'manual',
    'hybrid',
  ]).notNull().default('round_robin'),

  routingConfig: json('routing_config').$type<{
    weights?: Record<string, number>;
    percentages?: Record<string, number>;
    fallbackUserId?: string;
    excludeOnLeave?: boolean;
    respectDailyCap?: boolean;
  }>(),

  webhookSecret: varchar('webhook_secret', { length: 64 }),
  externalCampaignId: varchar('external_campaign_id', { length: 120 }),

  isActive: boolean('is_active').notNull().default(true),
  startsAt: timestamp('starts_at'),
  endsAt: timestamp('ends_at'),

  createdBy: varchar('created_by', { length: 24 }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
}, (t) => ({
  idxCompanyCountry: index('idx_campaign_cc').on(t.companyCountryId),
  idxPlatform: index('idx_campaign_platform').on(t.platform),
}));

/**
 * Tracks the round-robin pointer per campaign so distribution is fair across requests.
 */
export const campaignRoutingState = mysqlTable('campaign_routing_state', {
  campaignId: varchar('campaign_id', { length: 24 }).primaryKey(),
  lastAssignedUserId: varchar('last_assigned_user_id', { length: 24 }),
  totalAssigned: varchar('total_assigned', { length: 16 }).notNull().default('0'),
  updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
});

export const campaignsRelations = relations(campaigns, ({ one }) => ({
  companyCountry: one(companyCountries, {
    fields: [campaigns.companyCountryId],
    references: [companyCountries.id],
  }),
}));

export type Campaign = typeof campaigns.$inferSelect;
export type NewCampaign = typeof campaigns.$inferInsert;
export type CampaignRoutingState = typeof campaignRoutingState.$inferSelect;
