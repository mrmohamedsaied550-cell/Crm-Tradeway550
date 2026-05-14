-- Sprint 10 (D10) — User presence (online / away / busy / offline).
--
-- One row per (tenant, user). The presence row is greenfield —
-- there is no pre-existing data to migrate. Heartbeat / activity
-- endpoints create the row on first contact; a missing row
-- resolves to "offline" at read time so this table never blocks
-- a login.
--
-- Reversible: every column / index here is `DROP TABLE` reversible.
-- No constraints touch existing tables.

CREATE TABLE "user_presence" (
  "id"                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"           uuid        NOT NULL,
  "user_id"             uuid        NOT NULL UNIQUE,
  "last_seen_at"        timestamptz NOT NULL DEFAULT now(),
  "last_active_at"      timestamptz,
  "connected_at"        timestamptz,
  -- Sprint 10 — when set in the future, the user renders as `busy`
  -- (e.g. "in Add Action"). Auto-expires at read time when now()
  -- passes this value, so no separate cleanup pass is needed.
  "busy_until"          timestamptz,
  "current_context"     text,
  "current_entity_type" text,
  "current_entity_id"   uuid,
  "metadata"            jsonb,
  "updated_at"          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT "user_presence_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "user_presence_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);

-- "Who's online in this tenant right now?" — the Organization KPI
-- and Roles Members chip both filter by tenant + recent
-- lastSeenAt, so a composite index here keeps both cheap.
CREATE INDEX "user_presence_tenant_id_last_seen_at_idx"
  ON "user_presence" ("tenant_id", "last_seen_at");

-- "Who's busy right now?" — partial index so it only carries rows
-- that have a forward-looking busy_until value. Cheap because most
-- rows will have NULL here outside an active Add Action.
CREATE INDEX "user_presence_tenant_id_busy_until_idx"
  ON "user_presence" ("tenant_id", "busy_until")
  WHERE "busy_until" IS NOT NULL;
