-- C40 — admin audit events.
--
-- Non-lead-scoped events (bonus / competition / follow-up CRUD).
-- Lead-scoped events stay on `lead_activities`; the unified /audit
-- endpoint joins them at read time.

CREATE TABLE "audit_events" (
    "id"             UUID NOT NULL,
    "tenant_id"      UUID NOT NULL,
    "action"         TEXT NOT NULL,
    "entity_type"    TEXT,
    "entity_id"      UUID,
    "payload"        JSONB,
    "actor_user_id"  UUID,
    "created_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "audit_events_tenant_id_created_at_idx"
  ON "audit_events"("tenant_id", "created_at");
CREATE INDEX "audit_events_tenant_id_action_created_at_idx"
  ON "audit_events"("tenant_id", "action", "created_at");

ALTER TABLE "audit_events"
  ADD CONSTRAINT "audit_events_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "audit_events"
  ADD CONSTRAINT "audit_events_actor_user_id_fkey"
  FOREIGN KEY ("actor_user_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "audit_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_events" FORCE  ROW LEVEL SECURITY;
CREATE POLICY "audit_events_tenant_isolation" ON "audit_events"
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
