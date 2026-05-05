-- Phase D3 — D3.3: stage-specific status foundation.
--
-- ARCHITECTURE NOTE:
-- Pipeline stage answers "where is this lead in the process?". Stage
-- status answers "what is the current outcome inside this stage?".
-- This migration adds the schema to record stage statuses without
-- changing what a "stage" means. Examples (configured per tenant):
--   First Contact   → interested | no_answer | wrong_number | call_later
--   Missing Docs    → missing_license | missing_criminal_record | waiting_customer
--   Activation      → pending_partner | pending_screenshot | waiting_approval
--
-- This migration is purely additive:
--   - new columns on `pipeline_stages`  (allowed_statuses JSONB seam +
--                                         require_status_on_exit flag)
--   - new column on `leads`             (current_stage_status_id FK
--                                         pointer to the latest status
--                                         row for the lead's current
--                                         stage)
--   - new table `lead_stage_statuses`   (FORCE'd RLS; one row per
--                                         status the agent records)
-- NO existing column or index is dropped or renamed. NO row mutation
-- beyond the new column defaults. Every runtime path is unchanged
-- under D3_ENGINE_V1=false; the picker / requireStatusOnExit gate
-- only fire when the flag resolves true.
--
-- Touches:
--   - pipeline_stages   + allowed_statuses          JSONB NULL
--                       + require_status_on_exit    BOOL NOT NULL DEFAULT false
--   - leads             + current_stage_status_id   UUID NULL FK SET NULL
--   - new table:
--     lead_stage_statuses — append-only history per (tenant, lead,
--                            stage, attempt). FORCE RLS keyed on
--                            tenant_id = current_tenant_id().

-- ─── 1. pipeline_stages — allowed-statuses + require-on-exit ───────

ALTER TABLE "pipeline_stages"
  ADD COLUMN "allowed_statuses"        JSONB         NULL,
  ADD COLUMN "require_status_on_exit"  BOOLEAN       NOT NULL DEFAULT FALSE;

-- ─── 2. lead_stage_statuses — append-only status history ───────────

CREATE TABLE "lead_stage_statuses" (
    "id"             UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    "tenant_id"      UUID            NOT NULL,
    "lead_id"        UUID            NOT NULL,
    "stage_id"       UUID            NOT NULL,
    "status"         TEXT            NOT NULL,
    "attempt_index"  INTEGER         NOT NULL,
    "set_by_user_id" UUID            NULL,
    "notes"          TEXT            NULL,
    "created_at"     TIMESTAMPTZ(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_stage_statuses_tenant_id_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id")
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "lead_stage_statuses_lead_id_fkey"
        FOREIGN KEY ("lead_id") REFERENCES "leads" ("id")
        ON DELETE CASCADE ON UPDATE CASCADE,
    -- Restrict so a stage that still has status rows can't be
    -- hard-deleted accidentally. Admins must clear/migrate first.
    CONSTRAINT "lead_stage_statuses_stage_id_fkey"
        FOREIGN KEY ("stage_id") REFERENCES "pipeline_stages" ("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "lead_stage_statuses_set_by_user_id_fkey"
        FOREIGN KEY ("set_by_user_id") REFERENCES "users" ("id")
        ON DELETE SET NULL ON UPDATE CASCADE
);

-- Hot-path indexes:
--   • newest-first per lead (the picker's "current status" lookup)
--   • report-style queries by stage × status (TL coaching dashboards)
CREATE INDEX "lead_stage_statuses_tenant_id_lead_id_created_at_idx"
  ON "lead_stage_statuses" ("tenant_id", "lead_id", "created_at" DESC);
CREATE INDEX "lead_stage_statuses_tenant_id_stage_id_status_idx"
  ON "lead_stage_statuses" ("tenant_id", "stage_id", "status");

-- FORCE RLS — same policy shape as every other tenant-scoped table.
ALTER TABLE "lead_stage_statuses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "lead_stage_statuses" FORCE ROW LEVEL SECURITY;
CREATE POLICY "lead_stage_statuses_tenant_isolation"
  ON "lead_stage_statuses"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

-- ─── 3. leads — denormalised current-status pointer ────────────────
--
-- Cleared by `LeadsService.moveStage` on every stage change (under
-- D3_ENGINE_V1=true) so a stale predecessor-stage status never
-- pollutes the new stage's UI. ON DELETE SET NULL so a hard-deleted
-- history row never cascades through to delete the lead.

ALTER TABLE "leads"
  ADD COLUMN "current_stage_status_id" UUID NULL;

ALTER TABLE "leads"
  ADD CONSTRAINT "leads_current_stage_status_id_fkey"
  FOREIGN KEY ("current_stage_status_id") REFERENCES "lead_stage_statuses" ("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
