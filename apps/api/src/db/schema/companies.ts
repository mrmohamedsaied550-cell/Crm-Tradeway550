import { mysqlTable, varchar, timestamp, boolean, uniqueIndex } from 'drizzle-orm/mysql-core';
import { relations } from 'drizzle-orm';
import { nanoid } from 'nanoid';

export const companies = mysqlTable('companies', {
  id: varchar('id', { length: 24 }).primaryKey().$defaultFn(() => nanoid()),
  code: varchar('code', { length: 32 }).notNull().unique(),
  nameAr: varchar('name_ar', { length: 120 }).notNull(),
  nameEn: varchar('name_en', { length: 120 }).notNull(),
  logoUrl: varchar('logo_url', { length: 500 }),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
});

export const countries = mysqlTable('countries', {
  code: varchar('code', { length: 2 }).primaryKey(),
  nameAr: varchar('name_ar', { length: 80 }).notNull(),
  nameEn: varchar('name_en', { length: 80 }).notNull(),
  currency: varchar('currency', { length: 3 }).notNull(),
  timezone: varchar('timezone', { length: 64 }).notNull(),
  flagEmoji: varchar('flag_emoji', { length: 16 }),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const companyCountries = mysqlTable('company_countries', {
  id: varchar('id', { length: 24 }).primaryKey().$defaultFn(() => nanoid()),
  companyId: varchar('company_id', { length: 24 }).notNull(),
  countryCode: varchar('country_code', { length: 2 }).notNull(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (t) => ({
  uniqCompanyCountry: uniqueIndex('uniq_company_country').on(t.companyId, t.countryCode),
}));

export const companiesRelations = relations(companies, ({ many }) => ({
  companyCountries: many(companyCountries),
}));

export const countriesRelations = relations(countries, ({ many }) => ({
  companyCountries: many(companyCountries),
}));

export const companyCountriesRelations = relations(companyCountries, ({ one }) => ({
  company: one(companies, {
    fields: [companyCountries.companyId],
    references: [companies.id],
  }),
  country: one(countries, {
    fields: [companyCountries.countryCode],
    references: [countries.code],
  }),
}));

export type Company = typeof companies.$inferSelect;
export type NewCompany = typeof companies.$inferInsert;
export type Country = typeof countries.$inferSelect;
export type CompanyCountry = typeof companyCountries.$inferSelect;
