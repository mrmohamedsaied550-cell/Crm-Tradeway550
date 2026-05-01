-- C37 — Discipline tracking on `leads`.
--
-- Adds two denormalised columns + a covering index for the agent
-- workspace's overdue / due-today queries:
--   * `last_activity_at`     = MAX(lead_activities.created_at) per lead.
--   * `next_action_due_at`   = MIN(lead_followups.due_at) WHERE
--                              completed_at IS NULL, per lead.
--
-- Both are nullable. Sync is service-level: LeadsService bumps
-- `last_activity_at` after every activity insert; FollowUpsService
-- recomputes `next_action_due_at` after create / complete / delete.

ALTER TABLE "leads" ADD COLUMN "last_activity_at"    TIMESTAMPTZ(6);
ALTER TABLE "leads" ADD COLUMN "next_action_due_at"  TIMESTAMPTZ(6);

-- Backfill last_activity_at from existing activity rows.
UPDATE "leads" l
SET    "last_activity_at" = a.max_created
FROM   (
  SELECT "lead_id" AS lead_id, MAX("created_at") AS max_created
  FROM   "lead_activities"
  GROUP BY "lead_id"
) a
WHERE  a.lead_id = l.id;

-- Backfill next_action_due_at from pending follow-ups (none exist
-- before C36, but the SQL is idempotent for fresh installs).
UPDATE "leads" l
SET    "next_action_due_at" = f.min_due
FROM   (
  SELECT "lead_id" AS lead_id, MIN("due_at") AS min_due
  FROM   "lead_followups"
  WHERE  "completed_at" IS NULL
  GROUP BY "lead_id"
) f
WHERE  f.lead_id = l.id;

CREATE INDEX "leads_tenant_id_assigned_to_id_next_action_due_at_idx"
  ON "leads"("tenant_id", "assigned_to_id", "next_action_due_at");
