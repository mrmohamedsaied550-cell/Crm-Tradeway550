-- Phase D3 — D3.6: TL Review Queue — `lead_reviews` table.
--
-- ARCHITECTURE NOTE:
-- D3.5 staged a `lead.sla.review_pending` audit row whenever a
-- lead's SLA breached for the second time within the policy window.
-- D3.6 materialises that signal into a real, actionable queue row
-- (`lead_reviews`) so a TL / Ops can pick it up, decide between
-- rotate / keep-owner / escalate / dismiss, and close the loop.
--
-- The shape mirrors `whatsapp_conversation_reviews` (proven D1.5
-- pattern) but stays a SEPARATE table — conversation reviews are
-- conversation-anchored 1:1 (UNIQUE on conversation_id); lead
-- reviews can stack multiple per lead lifecycle.
--
-- This migration is purely additive:
--   - new table `lead_reviews` (FORCE'd RLS, tenant-scoped).
-- NO existing column or index is dropped or renamed. NO row
-- mutation. Every runtime path is unchanged under D3_ENGINE_V1=false.
--
-- Touches:
--   - new table:
--     lead_reviews — append-only queue rows. FORCE RLS keyed on
--                    tenant_id = current_tenant_id(). Three indexes
--                    for the TL-queue / per-lead-history /
--                    reason-chip-count hot paths.

-- ─── 1. lead_reviews ──────────────────────────────────────────────

CREATE TABLE "lead_reviews" (
    "id"                UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    "tenant_id"         UUID            NOT NULL,
    "lead_id"           UUID            NOT NULL,
    "reason"            TEXT            NOT NULL,
    "reason_payload"    JSONB           NULL,
    "assigned_tl_id"    UUID            NULL,
    "resolution"        TEXT            NULL,
    "resolved_by_id"    UUID            NULL,
    "resolved_at"       TIMESTAMPTZ(6)  NULL,
    "resolution_notes"  TEXT            NULL,
    "created_at"        TIMESTAMPTZ(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_reviews_tenant_id_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id")
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "lead_reviews_lead_id_fkey"
        FOREIGN KEY ("lead_id") REFERENCES "leads" ("id")
        ON DELETE CASCADE ON UPDATE CASCADE,
    -- SetNull on the two user FKs so disabling/deleting an agent
    -- never destroys the queue history. Same pattern as
    -- DuplicateDecisionLog.actor_user_id and LeadRotationLog.
    CONSTRAINT "lead_reviews_assigned_tl_id_fkey"
        FOREIGN KEY ("assigned_tl_id") REFERENCES "users" ("id")
        ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "lead_reviews_resolved_by_id_fkey"
        FOREIGN KEY ("resolved_by_id") REFERENCES "users" ("id")
        ON DELETE SET NULL ON UPDATE CASCADE
);

-- Hot-path indexes:
--   • TL queue: "open rows assigned to me, newest first".
--   • Per-lead history (lead detail card surfaces it later).
--   • Reason-chip count queries (tenant-wide reporting).
CREATE INDEX "lead_reviews_tenant_id_assigned_tl_id_resolved_at_created_at_idx"
  ON "lead_reviews" ("tenant_id", "assigned_tl_id", "resolved_at", "created_at" DESC);
CREATE INDEX "lead_reviews_tenant_id_lead_id_idx"
  ON "lead_reviews" ("tenant_id", "lead_id");
CREATE INDEX "lead_reviews_tenant_id_reason_resolved_at_idx"
  ON "lead_reviews" ("tenant_id", "reason", "resolved_at");

-- FORCE RLS — same policy shape as every other tenant-scoped table.
ALTER TABLE "lead_reviews" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "lead_reviews" FORCE ROW LEVEL SECURITY;
CREATE POLICY "lead_reviews_tenant_isolation"
  ON "lead_reviews"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());
