-- Phase D3 — D3.4: lead-rotation engine — append-only history.
--
-- ARCHITECTURE NOTE:
-- D3.4 introduces the first-class concept of a "lead rotation" —
-- changing the lead owner in a controlled, audited, permission-aware
-- way. This migration adds the structured query surface; the engine
-- + endpoints land in the same commit but as service / controller
-- changes (no schema impact beyond this table).
--
-- This migration is purely additive:
--   - new table `lead_rotation_logs` (FORCE'd RLS, tenant-scoped).
-- NO existing column or index is dropped or renamed. NO row mutation.
-- Every runtime path is unchanged under D3_ENGINE_V1=false; the
-- engine + manual endpoint only fire when the flag resolves true.
--
-- Touches:
--   - new table:
--     lead_rotation_logs — append-only history per (tenant, lead).
--                          Fields: from_user_id, to_user_id, trigger,
--                          handover_mode, reason_code, notes, payload,
--                          attempt_index, actor_user_id, created_at.
--                          FORCE RLS keyed on tenant_id =
--                          current_tenant_id(). Three indexes for the
--                          three hot-path queries.

-- ─── 1. lead_rotation_logs ─────────────────────────────────────────

CREATE TABLE "lead_rotation_logs" (
    "id"             UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    "tenant_id"      UUID            NOT NULL,
    "lead_id"        UUID            NOT NULL,
    "from_user_id"   UUID            NULL,
    "to_user_id"     UUID            NULL,
    "trigger"        TEXT            NOT NULL,
    "handover_mode"  TEXT            NOT NULL,
    "reason_code"    TEXT            NULL,
    "notes"          TEXT            NULL,
    "payload"        JSONB           NULL,
    "attempt_index"  INTEGER         NOT NULL,
    "actor_user_id"  UUID            NULL,
    "created_at"     TIMESTAMPTZ(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_rotation_logs_tenant_id_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id")
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "lead_rotation_logs_lead_id_fkey"
        FOREIGN KEY ("lead_id") REFERENCES "leads" ("id")
        ON DELETE CASCADE ON UPDATE CASCADE,
    -- SetNull on the three user FKs so disabling/deleting an agent
    -- never destroys the audit trail. Same pattern as
    -- DuplicateDecisionLog.actor_user_id and the C40 audit_events.
    CONSTRAINT "lead_rotation_logs_from_user_id_fkey"
        FOREIGN KEY ("from_user_id") REFERENCES "users" ("id")
        ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "lead_rotation_logs_to_user_id_fkey"
        FOREIGN KEY ("to_user_id") REFERENCES "users" ("id")
        ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "lead_rotation_logs_actor_user_id_fkey"
        FOREIGN KEY ("actor_user_id") REFERENCES "users" ("id")
        ON DELETE SET NULL ON UPDATE CASCADE
);

-- Hot-path indexes:
--   • Per-lead newest-first (lead-detail rotation history card).
--   • "rotated to me recently" (agent-workspace banner D3.7 ships).
--   • Per-trigger reporting (Ops breach / capacity dashboards).
CREATE INDEX "lead_rotation_logs_tenant_id_lead_id_created_at_idx"
  ON "lead_rotation_logs" ("tenant_id", "lead_id", "created_at" DESC);
CREATE INDEX "lead_rotation_logs_tenant_id_to_user_id_created_at_idx"
  ON "lead_rotation_logs" ("tenant_id", "to_user_id", "created_at" DESC);
CREATE INDEX "lead_rotation_logs_tenant_id_trigger_created_at_idx"
  ON "lead_rotation_logs" ("tenant_id", "trigger", "created_at" DESC);

-- FORCE RLS — same policy shape as every other tenant-scoped table.
ALTER TABLE "lead_rotation_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "lead_rotation_logs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "lead_rotation_logs_tenant_isolation"
  ON "lead_rotation_logs"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());
