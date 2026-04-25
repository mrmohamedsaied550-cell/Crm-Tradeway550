import { mysqlTable, varchar, timestamp, mysqlEnum, json, index, int } from 'drizzle-orm/mysql-core';
import { relations } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { enrollments } from './enrollments.js';
import { users } from './users.js';

/**
 * Activity log — every event for an enrollment lands here.
 * Powers the Timeline in the slide-over panel.
 */
export const activities = mysqlTable('activities', {
  id: varchar('id', { length: 24 }).primaryKey().$defaultFn(() => nanoid()),
  enrollmentId: varchar('enrollment_id', { length: 24 }).notNull(),
  actorId: varchar('actor_id', { length: 24 }),
  type: mysqlEnum('type', [
    'call',
    'note',
    'sms',
    'whatsapp',
    'email',
    'stage_change',
    'status_change',
    'assignment_change',
    'approval_request',
    'approval_response',
    'document_upload',
    'field_update',
    'sheet_sync',
    'system_event',
    'created',
  ]).notNull(),
  summary: varchar('summary', { length: 500 }),
  data: json('data').$type<Record<string, unknown>>(),
  durationSec: int('duration_sec'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (t) => ({
  idxEnrollment: index('idx_activity_enrollment').on(t.enrollmentId),
  idxActor: index('idx_activity_actor').on(t.actorId),
  idxType: index('idx_activity_type').on(t.type),
  idxCreatedAt: index('idx_activity_created').on(t.createdAt),
}));

export const activitiesRelations = relations(activities, ({ one }) => ({
  enrollment: one(enrollments, {
    fields: [activities.enrollmentId],
    references: [enrollments.id],
  }),
  actor: one(users, {
    fields: [activities.actorId],
    references: [users.id],
  }),
}));

export type Activity = typeof activities.$inferSelect;
export type NewActivity = typeof activities.$inferInsert;
