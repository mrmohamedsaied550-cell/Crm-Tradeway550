-- P2-07 — Pipeline Builder.
--
-- Promotes the existing tenant-wide stage list into a first-class
-- `Pipeline` entity that admins can create per (Company × Country).
-- Every tenant keeps exactly one "default" pipeline, which the
-- backfill below builds from the existing pipeline_stages rows.
--
-- Steps:
--   1. CREATE the `pipelines` table + RLS.
--   2. INSERT one default pipeline per tenant (idempotent).
--   3. ALTER pipeline_stages: add nullable `pipeline_id`, backfill
--      it to the tenant's default pipeline, then make NOT NULL.
--   4. Drop the old (tenant_id, code) / (tenant_id, order) uniques
--      and add (pipeline_id, code) / (pipeline_id, order).
--   5. Partial unique index forcing exactly one default pipeline
--      per tenant.

-- ─── 1. pipelines table ───────────────────────────────────────────
CREATE TABLE "pipelines" (
    "id"         UUID NOT NULL,
    "tenant_id"  UUID NOT NULL,
    "company_id" UUID,
    "country_id" UUID,
    "name"       TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT FALSE,
    "is_active"  BOOLEAN NOT NULL DEFAULT TRUE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pipelines_pkey" PRIMARY KEY ("id")
);

-- (tenant, company, country) uniqueness — Postgres treats NULLs as
-- distinct, which is fine: the tenant-default lives at
-- (tenant, NULL, NULL) and the partial unique below pins it to one row.
CREATE UNIQUE INDEX "pipelines_tenant_id_company_id_country_id_key"
  ON "pipelines"("tenant_id", "company_id", "country_id");
CREATE INDEX "pipelines_tenant_id_is_active_idx"
  ON "pipelines"("tenant_id", "is_active");

-- Exactly ONE default pipeline per tenant. The partial index covers
-- only `is_default = TRUE` rows, so admins can flip a non-default
-- between active/inactive without bumping into the constraint.
CREATE UNIQUE INDEX "pipelines_tenant_id_is_default_unique_default"
  ON "pipelines"("tenant_id")
  WHERE "is_default" = TRUE;

ALTER TABLE "pipelines"
  ADD CONSTRAINT "pipelines_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pipelines"
  ADD CONSTRAINT "pipelines_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pipelines"
  ADD CONSTRAINT "pipelines_country_id_fkey"
  FOREIGN KEY ("country_id") REFERENCES "countries"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── 2. seed one default pipeline per tenant ──────────────────────
-- Done BEFORE enabling RLS so the seed insert isn't blocked by the
-- "USING (tenant_id = current_tenant_id())" policy — the migration
-- runs without an `app.tenant_id` GUC. Once RLS is enabled below,
-- every subsequent write must come through a tenant context.
INSERT INTO "pipelines" (
  "id", "tenant_id", "company_id", "country_id",
  "name", "is_default", "is_active", "created_at", "updated_at"
)
SELECT
  gen_random_uuid(),
  t.id,
  NULL,
  NULL,
  'Default',
  TRUE,
  TRUE,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "tenants" t
WHERE NOT EXISTS (
  SELECT 1 FROM "pipelines" p
  WHERE p.tenant_id = t.id AND p.is_default = TRUE
);

-- ─── 3. add pipeline_id to pipeline_stages + backfill ─────────────
-- We run the backfill BEFORE enabling RLS on `pipelines` because the
-- UPDATE's FROM-clause SELECTs from the pipelines table, and a freshly
-- enabled "USING current_tenant_id()" policy returns 0 rows when the
-- migration's GUC is unset. Same reason we toggle FORCE off on
-- pipeline_stages: the migration role bypasses RLS only when the
-- table isn't FORCE'd.
ALTER TABLE "pipeline_stages" ADD COLUMN "pipeline_id" UUID;
ALTER TABLE "pipeline_stages" NO FORCE ROW LEVEL SECURITY;

UPDATE "pipeline_stages" ps
   SET "pipeline_id" = p.id
  FROM "pipelines" p
 WHERE p.tenant_id = ps.tenant_id
   AND p.is_default = TRUE
   AND ps.pipeline_id IS NULL;

ALTER TABLE "pipeline_stages" ALTER COLUMN "pipeline_id" SET NOT NULL;
ALTER TABLE "pipeline_stages" FORCE ROW LEVEL SECURITY;

ALTER TABLE "pipeline_stages"
  ADD CONSTRAINT "pipeline_stages_pipeline_id_fkey"
  FOREIGN KEY ("pipeline_id") REFERENCES "pipelines"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── 4. swap the unique indexes onto the pipeline scope ───────────
DROP INDEX IF EXISTS "pipeline_stages_tenant_id_code_key";
DROP INDEX IF EXISTS "pipeline_stages_tenant_id_order_key";

CREATE UNIQUE INDEX "pipeline_stages_pipeline_id_code_key"
  ON "pipeline_stages"("pipeline_id", "code");
CREATE UNIQUE INDEX "pipeline_stages_pipeline_id_order_key"
  ON "pipeline_stages"("pipeline_id", "order");
CREATE INDEX "pipeline_stages_pipeline_id_idx"
  ON "pipeline_stages"("pipeline_id");

-- ─── 5. enable RLS on pipelines (deferred until after backfill) ───
ALTER TABLE "pipelines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pipelines" FORCE  ROW LEVEL SECURITY;
CREATE POLICY "pipelines_tenant_isolation" ON "pipelines"
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
