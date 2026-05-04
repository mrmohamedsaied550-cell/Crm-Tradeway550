-- Phase C — C10B-1: WhatsApp ownership schema, Contact identity, and
-- Lead linkage foundation.
--
-- Single additive migration. NO inbound/routing/scope code reads or
-- writes the new columns yet — C10B-2 backfills, C10B-3 wires the
-- inbound flow, C10B-4 wires scope + writes. Until then, every new
-- column is NULL on every existing row (or carries a sane TEXT default
-- 'lead' for action_source) and the existing 555-test baseline must
-- stay green.
--
-- Touches:
--   - new table: contacts                       — stable phone identity
--   - new table: whatsapp_conversation_reviews  — duplicate / captain
--                                                 review queue
--   - whatsapp_conversations  + contact_id  + assigned_to_id
--                             + team_id     + company_id
--                             + country_id  + assignment_source
--                             + assigned_at + 5 new indexes
--   - leads                   + contact_id  + primary_conversation_id
--                             + 1 new index
--   - lead_activities         + action_source TEXT DEFAULT 'lead'
--   - lead_followups          + action_source TEXT DEFAULT 'lead'
--
-- RLS: contacts + whatsapp_conversation_reviews get the standard
-- FORCE ROW LEVEL SECURITY policy keyed on
-- `tenant_id = current_tenant_id()`, matching every other tenant-
-- scoped table in the schema.

-- ─── 1. contacts ────────────────────────────────────────────────────

CREATE TABLE "contacts" (
    "id"                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "tenant_id"             UUID NOT NULL,
    "phone"                 TEXT NOT NULL,
    "display_name"          TEXT NULL,
    "language"              TEXT NULL,
    "raw_profile"           JSONB NULL,
    "original_phone"        TEXT NOT NULL,
    "original_display_name" TEXT NULL,
    "first_seen_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "is_captain"            BOOLEAN NOT NULL DEFAULT FALSE,
    "has_open_lead"         BOOLEAN NOT NULL DEFAULT FALSE,
    "created_at"            TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"            TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE "contacts"
  ADD CONSTRAINT "contacts_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "contacts_tenant_id_phone_key"
  ON "contacts" ("tenant_id", "phone");
CREATE INDEX "contacts_tenant_id_last_seen_at_idx"
  ON "contacts" ("tenant_id", "last_seen_at");
CREATE INDEX "contacts_tenant_id_is_captain_idx"
  ON "contacts" ("tenant_id", "is_captain");
CREATE INDEX "contacts_tenant_id_has_open_lead_idx"
  ON "contacts" ("tenant_id", "has_open_lead");

ALTER TABLE "contacts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "contacts" FORCE ROW LEVEL SECURITY;

CREATE POLICY "contacts_tenant_isolation" ON "contacts"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

-- ─── 2. whatsapp_conversations — ownership + contact link ───────────
--
-- Every new column is NULLABLE so the migration is non-breaking.
-- The C10B-2 backfill writes contact_id (and the four ownership
-- columns where derivable from the linked lead); C10B-5 will flip
-- contact_id to NOT NULL after the backfill is verified.

ALTER TABLE "whatsapp_conversations"
  ADD COLUMN "contact_id"         UUID NULL,
  ADD COLUMN "assigned_to_id"     UUID NULL,
  ADD COLUMN "team_id"            UUID NULL,
  ADD COLUMN "company_id"         UUID NULL,
  ADD COLUMN "country_id"         UUID NULL,
  ADD COLUMN "assignment_source"  TEXT NULL,
  ADD COLUMN "assigned_at"        TIMESTAMPTZ(6) NULL;

ALTER TABLE "whatsapp_conversations"
  ADD CONSTRAINT "whatsapp_conversations_contact_id_fkey"
  FOREIGN KEY ("contact_id") REFERENCES "contacts"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "whatsapp_conversations"
  ADD CONSTRAINT "whatsapp_conversations_assigned_to_id_fkey"
  FOREIGN KEY ("assigned_to_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "whatsapp_conversations"
  ADD CONSTRAINT "whatsapp_conversations_team_id_fkey"
  FOREIGN KEY ("team_id") REFERENCES "teams"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "whatsapp_conversations"
  ADD CONSTRAINT "whatsapp_conversations_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "whatsapp_conversations"
  ADD CONSTRAINT "whatsapp_conversations_country_id_fkey"
  FOREIGN KEY ("country_id") REFERENCES "countries"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Scope-resolver hot paths. The scope service AND-s on (tenantId,
-- assignedToId|teamId|companyId|countryId, status) — one composite
-- index per dimension keeps each scope evaluation single-index.
CREATE INDEX "whatsapp_conversations_tenant_id_assigned_to_id_status_idx"
  ON "whatsapp_conversations" ("tenant_id", "assigned_to_id", "status");
CREATE INDEX "whatsapp_conversations_tenant_id_team_id_status_idx"
  ON "whatsapp_conversations" ("tenant_id", "team_id", "status");
CREATE INDEX "whatsapp_conversations_tenant_id_company_id_status_idx"
  ON "whatsapp_conversations" ("tenant_id", "company_id", "status");
CREATE INDEX "whatsapp_conversations_tenant_id_country_id_status_idx"
  ON "whatsapp_conversations" ("tenant_id", "country_id", "status");
CREATE INDEX "whatsapp_conversations_tenant_id_contact_id_idx"
  ON "whatsapp_conversations" ("tenant_id", "contact_id");

-- ─── 3. whatsapp_conversation_reviews ───────────────────────────────

CREATE TABLE "whatsapp_conversation_reviews" (
    "id"                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "tenant_id"            UUID NOT NULL,
    "conversation_id"      UUID NOT NULL,
    "contact_id"           UUID NOT NULL,
    "reason"               TEXT NOT NULL,
    "candidate_lead_ids"   UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
    "candidate_captain_id" UUID NULL,
    "context_snapshot"     JSONB NULL,
    "created_at"           TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at"          TIMESTAMPTZ(6) NULL,
    "resolved_by_id"       UUID NULL,
    "resolution"           TEXT NULL,
    CONSTRAINT "whatsapp_conversation_reviews_reason_check"
      CHECK ("reason" IN ('captain_active', 'duplicate_lead', 'unmatched_after_routing')),
    CONSTRAINT "whatsapp_conversation_reviews_resolution_check"
      CHECK ("resolution" IS NULL OR
             "resolution" IN ('linked_to_lead', 'linked_to_captain', 'new_lead', 'dismissed'))
);

ALTER TABLE "whatsapp_conversation_reviews"
  ADD CONSTRAINT "whatsapp_conversation_reviews_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "whatsapp_conversation_reviews"
  ADD CONSTRAINT "whatsapp_conversation_reviews_conversation_id_fkey"
  FOREIGN KEY ("conversation_id") REFERENCES "whatsapp_conversations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "whatsapp_conversation_reviews"
  ADD CONSTRAINT "whatsapp_conversation_reviews_contact_id_fkey"
  FOREIGN KEY ("contact_id") REFERENCES "contacts"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "whatsapp_conversation_reviews_conversation_id_key"
  ON "whatsapp_conversation_reviews" ("conversation_id");
CREATE INDEX "whatsapp_conversation_reviews_tenant_id_resolved_at_idx"
  ON "whatsapp_conversation_reviews" ("tenant_id", "resolved_at");
CREATE INDEX "whatsapp_conversation_reviews_tenant_id_reason_idx"
  ON "whatsapp_conversation_reviews" ("tenant_id", "reason");

ALTER TABLE "whatsapp_conversation_reviews" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "whatsapp_conversation_reviews" FORCE ROW LEVEL SECURITY;

CREATE POLICY "whatsapp_conversation_reviews_tenant_isolation"
  ON "whatsapp_conversation_reviews"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

-- ─── 4. leads — link to contact + primary conversation ──────────────

ALTER TABLE "leads"
  ADD COLUMN "contact_id"              UUID NULL,
  ADD COLUMN "primary_conversation_id" UUID NULL;

ALTER TABLE "leads"
  ADD CONSTRAINT "leads_contact_id_fkey"
  FOREIGN KEY ("contact_id") REFERENCES "contacts"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "leads"
  ADD CONSTRAINT "leads_primary_conversation_id_fkey"
  FOREIGN KEY ("primary_conversation_id") REFERENCES "whatsapp_conversations"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "leads_tenant_id_contact_id_idx"
  ON "leads" ("tenant_id", "contact_id");

-- ─── 5. action_source provenance ────────────────────────────────────
--
-- New columns get NOT NULL DEFAULT 'lead' so every existing activity
-- and follow-up backfills to the legacy ("written from the lead
-- detail page") provenance. The inbound flow (B3) and chat send/
-- receive (B4) write 'whatsapp'; system jobs write 'system'.

ALTER TABLE "lead_activities"
  ADD COLUMN "action_source" TEXT NOT NULL DEFAULT 'lead';

ALTER TABLE "lead_followups"
  ADD COLUMN "action_source" TEXT NOT NULL DEFAULT 'lead';
