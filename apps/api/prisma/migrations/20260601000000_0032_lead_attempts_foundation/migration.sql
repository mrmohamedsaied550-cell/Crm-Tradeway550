-- Phase D2 — D2.1: multi-attempt / reactivation schema foundation.
--
-- ARCHITECTURE NOTE:
-- D2 follows Option B from the D2 plan: Contact stays the person
-- identity anchor; Lead becomes one row per acquisition / reactivation
-- attempt. To reach there incrementally without breaking anything,
-- D2.1 ships ONLY additive schema. The existing
-- `leads_tenant_id_phone_key` UNIQUE constraint stays in place for
-- now; it is replaced by a partial-unique-on-open in D2.3 once the
-- DuplicateDecisionService is live (gated behind LEAD_ATTEMPTS_V2).
--
-- This migration is purely additive:
--   - new columns on `leads`     (attempt_index + chain + reactivation
--                                  audit fields), all NULL on legacy
--                                  rows except `attempt_index` which
--                                  defaults to 1.
--   - new column on `tenant_settings` (duplicate_rules JSONB, NULL).
--   - new table `duplicate_decision_log` (FORCE'd RLS, tenant-scoped).
--   - one new index on `leads` to support the future "list attempts
--     for this contact" query (D2.5 lead-detail card).
--
-- NO existing constraint is dropped, NO column is renamed, NO row is
-- mutated. Every runtime path is unchanged; the existing 555-test
-- baseline must stay green.
--
-- Touches:
--   - leads                     + attempt_index INT NOT NULL DEFAULT 1
--                               + previous_lead_id UUID NULL (self-ref FK SetNull)
--                               + reactivated_at TIMESTAMPTZ NULL
--                               + reactivated_by_id UUID NULL (FK users SetNull)
--                               + reactivation_rule TEXT NULL
--                               + 1 new index
--                                 (tenant_id, contact_id, attempt_index)
--   - tenant_settings           + duplicate_rules JSONB NULL
--   - new table:
--     duplicate_decision_log    — append-only audit log (no service
--                                 writes to it yet; D2.2 wires the
--                                 DuplicateDecisionService).

-- ─── 1. leads — multi-attempt columns ──────────────────────────────

ALTER TABLE "leads"
  ADD COLUMN "attempt_index"      INTEGER       NOT NULL DEFAULT 1,
  ADD COLUMN "previous_lead_id"   UUID          NULL,
  ADD COLUMN "reactivated_at"     TIMESTAMPTZ(6) NULL,
  ADD COLUMN "reactivated_by_id"  UUID          NULL,
  ADD COLUMN "reactivation_rule"  TEXT          NULL;

-- Self-reference for the attempt chain. SetNull so deleting an old
-- attempt doesn't cascade-delete its successors.
ALTER TABLE "leads"
  ADD CONSTRAINT "leads_previous_lead_id_fkey"
  FOREIGN KEY ("previous_lead_id") REFERENCES "leads" ("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Reactivator user FK. SetNull on user delete — the audit trail keeps
-- `reactivated_at` even if the user row is later removed.
ALTER TABLE "leads"
  ADD CONSTRAINT "leads_reactivated_by_id_fkey"
  FOREIGN KEY ("reactivated_by_id") REFERENCES "users" ("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- D2.5 read pattern: "list every attempt for this contact ordered by
-- attempt number." The index lets the future Attempts History card
-- skip the sort.
CREATE INDEX "leads_tenant_id_contact_id_attempt_index_idx"
  ON "leads" ("tenant_id", "contact_id", "attempt_index");

-- ─── 2. tenant_settings — duplicate_rules JSON ─────────────────────

ALTER TABLE "tenant_settings"
  ADD COLUMN "duplicate_rules" JSONB NULL;

-- ─── 3. duplicate_decision_log ─────────────────────────────────────

CREATE TABLE "duplicate_decision_log" (
    "id"                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    "tenant_id"           UUID            NOT NULL,
    "contact_id"          UUID            NULL,
    "phone"               TEXT            NOT NULL,
    "trigger"             TEXT            NOT NULL,
    "matched_lead_ids"    UUID[]          NOT NULL DEFAULT ARRAY[]::UUID[],
    "matched_captain_id"  UUID            NULL,
    "rule_applied"        TEXT            NOT NULL,
    "decision"            TEXT            NOT NULL,
    "confidence"          TEXT            NOT NULL DEFAULT 'high',
    "actor_user_id"       UUID            NULL,
    "result_lead_id"      UUID            NULL,
    "result_review_id"    UUID            NULL,
    "payload"             JSONB           NULL,
    "created_at"          TIMESTAMPTZ(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "duplicate_decision_log_tenant_id_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id")
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "duplicate_decision_log_contact_id_fkey"
        FOREIGN KEY ("contact_id") REFERENCES "contacts" ("id")
        ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "duplicate_decision_log_actor_user_id_fkey"
        FOREIGN KEY ("actor_user_id") REFERENCES "users" ("id")
        ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "duplicate_decision_log_result_lead_id_fkey"
        FOREIGN KEY ("result_lead_id") REFERENCES "leads" ("id")
        ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "duplicate_decision_log_tenant_id_contact_id_created_at_idx"
  ON "duplicate_decision_log" ("tenant_id", "contact_id", "created_at");

CREATE INDEX "duplicate_decision_log_tenant_id_decision_created_at_idx"
  ON "duplicate_decision_log" ("tenant_id", "decision", "created_at");

-- FORCE ROW LEVEL SECURITY policy keyed on
-- `tenant_id = current_tenant_id()`, matching every other tenant-
-- scoped table in the schema.
ALTER TABLE "duplicate_decision_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "duplicate_decision_log" FORCE ROW LEVEL SECURITY;

CREATE POLICY "duplicate_decision_log_tenant_isolation"
  ON "duplicate_decision_log"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());
