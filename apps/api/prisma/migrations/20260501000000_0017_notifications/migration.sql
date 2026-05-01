-- P2-02 — in-app notifications inbox.
--
-- One row per delivery. `kind` is a stable verb the UI branches on
-- (sla.breach / followup.due / followup.assigned / whatsapp.handover).
-- Tenant-isolated via the same FORCE'd RLS pattern as the rest of the
-- CRM core.

CREATE TABLE "notifications" (
    "id"                 UUID NOT NULL,
    "tenant_id"          UUID NOT NULL,
    "recipient_user_id"  UUID NOT NULL,
    "kind"               TEXT NOT NULL,
    "title"              TEXT NOT NULL,
    "body"               TEXT,
    "payload"            JSONB,
    "read_at"            TIMESTAMPTZ(6),
    "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "notifications_tenant_id_recipient_user_id_read_at_created_at_idx"
  ON "notifications"("tenant_id", "recipient_user_id", "read_at", "created_at");

ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_recipient_user_id_fkey"
  FOREIGN KEY ("recipient_user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notifications" FORCE  ROW LEVEL SECURITY;
CREATE POLICY "notifications_tenant_isolation" ON "notifications"
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
