-- C32 + C33 — Bonus rules & Competitions
--
-- Two tenant-scoped admin tables sharing the same RLS pattern as the rest
-- of the CRM core: FORCE'd row-level security with `current_tenant_id()`.
-- Both tables are MVP — payout engine + leaderboard materialisation come
-- in a later chunk; this migration just lays down the schema.

-- ── bonus_rules ────────────────────────────────────────────────────────
CREATE TABLE "bonus_rules" (
    "id"          UUID NOT NULL,
    "tenant_id"   UUID NOT NULL,
    "company_id"  UUID NOT NULL,
    "country_id"  UUID NOT NULL,
    "team_id"     UUID,
    "role_id"     UUID,
    "bonus_type"  TEXT NOT NULL,
    "trigger"     TEXT NOT NULL,
    "amount"      DECIMAL(12,2) NOT NULL,
    "is_active"   BOOLEAN NOT NULL DEFAULT true,
    "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"  TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "bonus_rules_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "bonus_rules_tenant_id_is_active_idx"
  ON "bonus_rules"("tenant_id", "is_active");
CREATE INDEX "bonus_rules_tenant_id_company_id_country_id_idx"
  ON "bonus_rules"("tenant_id", "company_id", "country_id");

ALTER TABLE "bonus_rules"
  ADD CONSTRAINT "bonus_rules_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bonus_rules"
  ADD CONSTRAINT "bonus_rules_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bonus_rules"
  ADD CONSTRAINT "bonus_rules_country_id_fkey"
  FOREIGN KEY ("country_id") REFERENCES "countries"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bonus_rules"
  ADD CONSTRAINT "bonus_rules_team_id_fkey"
  FOREIGN KEY ("team_id") REFERENCES "teams"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "bonus_rules"
  ADD CONSTRAINT "bonus_rules_role_id_fkey"
  FOREIGN KEY ("role_id") REFERENCES "roles"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "bonus_rules" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "bonus_rules" FORCE  ROW LEVEL SECURITY;
CREATE POLICY "bonus_rules_tenant_isolation" ON "bonus_rules"
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- ── competitions ───────────────────────────────────────────────────────
CREATE TABLE "competitions" (
    "id"          UUID NOT NULL,
    "tenant_id"   UUID NOT NULL,
    "name"        TEXT NOT NULL,
    "company_id"  UUID,
    "country_id"  UUID,
    "team_id"     UUID,
    "start_date"  TIMESTAMPTZ(6) NOT NULL,
    "end_date"    TIMESTAMPTZ(6) NOT NULL,
    "metric"      TEXT NOT NULL,
    "reward"      TEXT NOT NULL,
    "status"      TEXT NOT NULL DEFAULT 'draft',
    "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"  TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "competitions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "competitions_tenant_id_status_start_date_idx"
  ON "competitions"("tenant_id", "status", "start_date");

ALTER TABLE "competitions"
  ADD CONSTRAINT "competitions_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "competitions"
  ADD CONSTRAINT "competitions_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "competitions"
  ADD CONSTRAINT "competitions_country_id_fkey"
  FOREIGN KEY ("country_id") REFERENCES "countries"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "competitions"
  ADD CONSTRAINT "competitions_team_id_fkey"
  FOREIGN KEY ("team_id") REFERENCES "teams"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "competitions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "competitions" FORCE  ROW LEVEL SECURITY;
CREATE POLICY "competitions_tenant_isolation" ON "competitions"
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
