import { mysqlTable, varchar, timestamp, mysqlEnum, index, json } from 'drizzle-orm/mysql-core';
import { relations } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { contacts } from './contacts';
import { stages, leadStatuses, rejectReasons } from './pipeline';
import { users } from './users';
import { companyCountries } from './companies';

/**
 * Enrollments — a contact's registration in a specific (company × country).
 * One contact can have many enrollments (Uber EG, InDrive EG, etc.).
 *
 * In the UI this is displayed as a "Lead", but the underlying split
 * gives us multi-company tracking without duplicating contact data.
 */
export const enrollments = mysqlTable('enrollments', {
  id: varchar('id', { length: 24 }).primaryKey().$defaultFn(() => nanoid()),
  contactId: varchar('contact_id', { length: 24 }).notNull(),
  companyCountryId: varchar('company_country_id', { length: 24 }).notNull(),

  // Stage = high-level driver journey phase
  currentStageId: varchar('current_stage_id', { length: 24 }),
  // Status = sub-status within the stage
  currentStatusId: varchar('current_status_id', { length: 24 }),

  subStatus: mysqlEnum('sub_status', [
    'active',
    'waiting_approval',
    'waiting_customer',
    'cold',
    'paused',
    'completed',
    'dropped',
  ]).notNull().default('active'),

  source: varchar('source', { length: 64 }),
  sourceCode: varchar('source_code', { length: 64 }),
  campaignId: varchar('campaign_id', { length: 24 }),

  assignedUserId: varchar('assigned_user_id', { length: 24 }),
  assignedAt: timestamp('assigned_at'),

  rejectReasonId: varchar('reject_reason_id', { length: 24 }),
  rejectNote: varchar('reject_note', { length: 500 }),

  nextFollowUpAt: timestamp('next_follow_up_at'),
  lastContactAt: timestamp('last_contact_at'),
  firstTripAt: timestamp('first_trip_at'),
  tripsCount: varchar('trips_count', { length: 16 }),

  externalRef: varchar('external_ref', { length: 120 }),
  metadata: json('metadata').$type<Record<string, unknown>>(),

  deletedAt: timestamp('deleted_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
}, (t) => ({
  idxContact: index('idx_enrollment_contact').on(t.contactId),
  idxCompanyCountry: index('idx_enrollment_cc').on(t.companyCountryId),
  idxAssigned: index('idx_enrollment_assigned').on(t.assignedUserId),
  idxStage: index('idx_enrollment_stage').on(t.currentStageId),
  idxStatus: index('idx_enrollment_status').on(t.currentStatusId),
  idxFollowUp: index('idx_enrollment_followup').on(t.nextFollowUpAt),
  idxCampaign: index('idx_enrollment_campaign').on(t.campaignId),
}));

/**
 * Documents uploaded for an enrollment (national ID, driver license, vehicle papers).
 */
export const enrollmentDocuments = mysqlTable('enrollment_documents', {
  id: varchar('id', { length: 24 }).primaryKey().$defaultFn(() => nanoid()),
  enrollmentId: varchar('enrollment_id', { length: 24 }).notNull(),
  type: mysqlEnum('type', ['national_id', 'driver_license', 'vehicle_license', 'criminal_record', 'photo', 'other']).notNull(),
  fileName: varchar('file_name', { length: 255 }).notNull(),
  fileUrl: varchar('file_url', { length: 500 }).notNull(),
  fileSize: varchar('file_size', { length: 32 }),
  mimeType: varchar('mime_type', { length: 64 }),
  uploadedBy: varchar('uploaded_by', { length: 24 }).notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (t) => ({
  idxEnrollment: index('idx_doc_enrollment').on(t.enrollmentId),
}));

export const enrollmentsRelations = relations(enrollments, ({ one, many }) => ({
  contact: one(contacts, {
    fields: [enrollments.contactId],
    references: [contacts.id],
  }),
  companyCountry: one(companyCountries, {
    fields: [enrollments.companyCountryId],
    references: [companyCountries.id],
  }),
  currentStage: one(stages, {
    fields: [enrollments.currentStageId],
    references: [stages.id],
  }),
  currentStatus: one(leadStatuses, {
    fields: [enrollments.currentStatusId],
    references: [leadStatuses.id],
  }),
  assignedUser: one(users, {
    fields: [enrollments.assignedUserId],
    references: [users.id],
  }),
  rejectReason: one(rejectReasons, {
    fields: [enrollments.rejectReasonId],
    references: [rejectReasons.id],
  }),
  documents: many(enrollmentDocuments),
}));

export const enrollmentDocumentsRelations = relations(enrollmentDocuments, ({ one }) => ({
  enrollment: one(enrollments, {
    fields: [enrollmentDocuments.enrollmentId],
    references: [enrollments.id],
  }),
  uploader: one(users, {
    fields: [enrollmentDocuments.uploadedBy],
    references: [users.id],
  }),
}));

export type Enrollment = typeof enrollments.$inferSelect;
export type NewEnrollment = typeof enrollments.$inferInsert;
export type EnrollmentDocument = typeof enrollmentDocuments.$inferSelect;
