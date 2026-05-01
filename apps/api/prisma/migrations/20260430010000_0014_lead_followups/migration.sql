-- C36 — Lead follow-ups (scheduled "next action" per lead).
--
-- One row per scheduled action on a lead. `action_type` is a free
-- string (call / whatsapp / visit / other). `assigned_to_id` is the
-- agent who owns the follow-up (defaults to the lead's current
-- assignee at create time but may be overridden). `completed_at`
-- flips when the action is marked done; overdue = NULL completed_at
-- && due_at < now.
--
-- Tenant-scoped via the same FORCE'd RLS pattern as the rest of the
-- CRM core.

CREATE TABLE "lead_followups" (
    "id"             UUID NOT NULL,
    "tenant_id"      UUID NOT NULL,
    "lead_id"        UUID NOT NULL,
    "action_type"    TEXT NOT NULL,
    "due_at"         TIMESTAMPTZ(6) NOT NULL,
    "note"           TEXT,
    "completed_at"   TIMESTAMPTZ(6),
    "assigned_to_id" UUID,
    "created_by_id"  UUID,
    "created_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"     TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "lead_followups_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "lead_followups_tenant_id_lead_id_due_at_idx"
  ON "lead_followups"("tenant_id", "lead_id", "due_at");
CREATE INDEX "lead_followups_tenant_id_assigned_to_id_completed_at_due_at_idx"
  ON "lead_followups"("tenant_id", "assigned_to_id", "completed_at", "due_at");

ALTER TABLE "lead_followups"
  ADD CONSTRAINT "lead_followups_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "lead_followups"
  ADD CONSTRAINT "lead_followups_lead_id_fkey"
  FOREIGN KEY ("lead_id") REFERENCES "leads"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "lead_followups"
  ADD CONSTRAINT "lead_followups_assigned_to_id_fkey"
  FOREIGN KEY ("assigned_to_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "lead_followups"
  ADD CONSTRAINT "lead_followups_created_by_id_fkey"
  FOREIGN KEY ("created_by_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "lead_followups" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "lead_followups" FORCE  ROW LEVEL SECURITY;
CREATE POLICY "lead_followups_tenant_isolation" ON "lead_followups"
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
