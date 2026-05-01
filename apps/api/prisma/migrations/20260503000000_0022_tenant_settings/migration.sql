-- P2-08 — Tenant Settings.
--
-- 1:1 row per tenant carrying timezone / slaMinutes / defaultDialCode.
-- The seed inserts one row per existing tenant BEFORE RLS is enabled
-- (the migration role has no `app.tenant_id` GUC and the
-- USING (tenant_id = current_tenant_id()) policy would block the
-- INSERT otherwise — same pattern as 0021_pipeline_builder).
--
-- Defaults match the prior environment-variable behaviour:
--   timezone = "Africa/Cairo" (Egypt-first deploy)
--   sla_minutes = 60          (matches a typical LEAD_SLA_MINUTES)
--   default_dial_code = "+20" (Egypt)
-- Operators tweak per tenant via the new admin UI.

CREATE TABLE "tenant_settings" (
    "tenant_id"         UUID NOT NULL,
    "timezone"          TEXT NOT NULL DEFAULT 'Africa/Cairo',
    "sla_minutes"       INTEGER NOT NULL DEFAULT 60,
    "default_dial_code" TEXT NOT NULL DEFAULT '+20',
    "created_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"        TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tenant_settings_pkey" PRIMARY KEY ("tenant_id")
);

ALTER TABLE "tenant_settings"
  ADD CONSTRAINT "tenant_settings_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed one row per tenant BEFORE enabling RLS.
INSERT INTO "tenant_settings" ("tenant_id", "updated_at")
SELECT t.id, CURRENT_TIMESTAMP
FROM "tenants" t
WHERE NOT EXISTS (
  SELECT 1 FROM "tenant_settings" s WHERE s.tenant_id = t.id
);

ALTER TABLE "tenant_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_settings" FORCE  ROW LEVEL SECURITY;
CREATE POLICY "tenant_settings_tenant_isolation" ON "tenant_settings"
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
