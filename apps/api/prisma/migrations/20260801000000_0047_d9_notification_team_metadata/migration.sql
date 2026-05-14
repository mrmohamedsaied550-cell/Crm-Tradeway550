-- Sprint 9 (D9) — notification team variant + severity + actionUrl.
--
-- Extends the existing P2-02 `notifications` table without changing
-- any existing row. The bell + API surface continues to function
-- exactly as before; the new columns are purely additive and let
-- Sprint 9's event hooks attach the metadata the UI needs to
-- render severity color, click-through navigation, and team-wide
-- inbox entries (e.g. "approver queue, anyone on Cairo A").
--
-- Reversible: every change here is `DROP COLUMN` / `DROP INDEX` /
-- `ALTER COLUMN ... SET NOT NULL` reversible. No data loss path.

-- 1. Recipient nullable + new team-recipient column.
--    The check constraint guarantees every row still targets at
--    least one of (user, team) so we can't lose track of a row's
--    audience by accident.
ALTER TABLE "notifications"
  ALTER COLUMN "recipient_user_id" DROP NOT NULL,
  ADD COLUMN "recipient_team_id" uuid;

ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_target_check"
  CHECK ("recipient_user_id" IS NOT NULL OR "recipient_team_id" IS NOT NULL);

ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_recipient_team_id_fkey"
  FOREIGN KEY ("recipient_team_id") REFERENCES "teams"("id") ON DELETE CASCADE;

-- 2. Severity (info|success|warning|danger) — guarded by an allow-
--    list CHECK so the bell never has to render an unknown value.
--    Nullable for back-compat with pre-Sprint-9 rows that didn't
--    carry severity at write time.
ALTER TABLE "notifications"
  ADD COLUMN "severity" text;

ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_severity_check"
  CHECK ("severity" IS NULL
      OR "severity" IN ('info', 'success', 'warning', 'danger'));

-- 3. Action URL — relative path the bell click navigates to. Free-
--    text by design so we can encode `?queue=…` query strings
--    without a separate schema field.
ALTER TABLE "notifications"
  ADD COLUMN "action_url" text;

-- 4. Team inbox lookup. Partial index keeps it tiny since most rows
--    will continue to be user-targeted.
CREATE INDEX "notifications_tenant_id_recipient_team_id_read_at_created_at_idx"
  ON "notifications" ("tenant_id", "recipient_team_id", "read_at", "created_at")
  WHERE "recipient_team_id" IS NOT NULL;
