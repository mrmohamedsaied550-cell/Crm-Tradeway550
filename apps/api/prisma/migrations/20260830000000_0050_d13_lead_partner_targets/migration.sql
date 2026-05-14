-- Sprint 13 (D13) — Lead Partner Targets.
--
-- Operator intent to target one real lead/contact for an
-- additional partner journey without duplicating the Lead /
-- Contact / Captain row. The existing PartnerRecord table is
-- read-side sync data; this table is write-side operator intent.
--
-- Reversible: every column/index/constraint is DROP TABLE
-- reversible.

CREATE TABLE "lead_partner_targets" (
  "id"                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"           uuid        NOT NULL,
  "lead_id"             uuid        NOT NULL,
  "partner_source_id"   uuid        NOT NULL,
  "status"              text        NOT NULL DEFAULT 'target',
  "country_id"          uuid,
  "team_id"             uuid,
  "owner_user_id"       uuid,
  "created_by_id"       uuid        NOT NULL,
  "note"                text,
  "created_at"          timestamptz NOT NULL DEFAULT now(),
  "updated_at"          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT "lead_partner_targets_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "lead_partner_targets_lead_id_fkey"
    FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE,
  CONSTRAINT "lead_partner_targets_partner_source_id_fkey"
    FOREIGN KEY ("partner_source_id") REFERENCES "partner_sources"("id") ON DELETE CASCADE,
  CONSTRAINT "lead_partner_targets_country_id_fkey"
    FOREIGN KEY ("country_id") REFERENCES "countries"("id") ON DELETE SET NULL,
  CONSTRAINT "lead_partner_targets_team_id_fkey"
    FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE SET NULL,
  CONSTRAINT "lead_partner_targets_owner_user_id_fkey"
    FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE SET NULL,
  CONSTRAINT "lead_partner_targets_created_by_id_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT
);

-- Status allow-list. New service paths must extend this CHECK
-- together with any new vocabulary so the DB never holds an
-- invalid label.
ALTER TABLE "lead_partner_targets"
  ADD CONSTRAINT "lead_partner_targets_status_check"
  CHECK ("status" IN (
    'target',
    'not_started',
    'contacted',
    'signup_started',
    'matched',
    'rejected',
    'inactive'
  ));

-- Dedupe contract — exactly one target row per (lead, partner).
-- The service throws lead.partner_target.duplicate on conflict so
-- the UI can render a clean error.
CREATE UNIQUE INDEX "lead_partner_targets_lead_id_partner_source_id_key"
  ON "lead_partner_targets" ("lead_id", "partner_source_id");

-- Lookup indexes for the Lead Detail Partner Presence panel +
-- a future "all open targets for partner X" view.
CREATE INDEX "lead_partner_targets_tenant_id_lead_id_idx"
  ON "lead_partner_targets" ("tenant_id", "lead_id");
CREATE INDEX "lead_partner_targets_tenant_id_partner_source_id_idx"
  ON "lead_partner_targets" ("tenant_id", "partner_source_id");
CREATE INDEX "lead_partner_targets_tenant_id_status_idx"
  ON "lead_partner_targets" ("tenant_id", "status");
CREATE INDEX "lead_partner_targets_tenant_id_owner_user_id_idx"
  ON "lead_partner_targets" ("tenant_id", "owner_user_id");
