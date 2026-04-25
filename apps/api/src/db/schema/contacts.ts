import { mysqlTable, varchar, timestamp, mysqlEnum, index, uniqueIndex } from 'drizzle-orm/mysql-core';
import { relations } from 'drizzle-orm';
import { nanoid } from 'nanoid';

/**
 * Contacts (الكباتن) — single record per person regardless of how many companies they enroll in.
 * Unique by phone.
 */
export const contacts = mysqlTable('contacts', {
  id: varchar('id', { length: 24 }).primaryKey().$defaultFn(() => nanoid()),
  fullName: varchar('full_name', { length: 160 }).notNull(),
  phone: varchar('phone', { length: 32 }).notNull(),
  whatsapp: varchar('whatsapp', { length: 32 }),
  email: varchar('email', { length: 191 }),
  city: varchar('city', { length: 80 }),
  countryCode: varchar('country_code', { length: 2 }).notNull(),
  vehicleType: mysqlEnum('vehicle_type', ['car', 'motorcycle', 'van', 'other']),
  nationalId: varchar('national_id', { length: 32 }),
  notes: varchar('notes', { length: 1000 }),
  deletedAt: timestamp('deleted_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
}, (t) => ({
  uniqPhone: uniqueIndex('uniq_contact_phone').on(t.phone),
  idxCity: index('idx_contact_city').on(t.city),
  idxCountry: index('idx_contact_country').on(t.countryCode),
}));

export type Contact = typeof contacts.$inferSelect;
export type NewContact = typeof contacts.$inferInsert;
