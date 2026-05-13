-- Sprint 1 (D6.1) — Captain Masr lifecycle classifier on pipeline_stages.
--
-- Adds an optional `lifecycle_category` column that buckets each
-- pipeline stage into one of the four canonical journey steps
-- (Fresh Lead → Signup → Active → DFT). NULL is valid and means
-- "this stage is not part of the captain-acquisition journey"; the
-- Journey Bar in Lead Detail simply doesn't light a step when the
-- current stage's category is NULL. Reports and dashboards in
-- later sprints roll up counts by category.
--
-- Backward-compatible: every existing row defaults to NULL; no
-- service code currently writes the column, so no migrations of
-- behaviour. Admins populate it via Pipeline Builder once Sprint 1
-- ships.
--
-- A CHECK constraint enforces the allow-list so misconfigured rows
-- can't bleed into the UI's switch statement. Adding the values is
-- a schema change by design — the lifecycle is a product invariant,
-- not a tenant-configurable list.

ALTER TABLE "pipeline_stages"
  ADD COLUMN "lifecycle_category" TEXT;

ALTER TABLE "pipeline_stages"
  ADD CONSTRAINT "pipeline_stages_lifecycle_category_check"
  CHECK ("lifecycle_category" IS NULL
      OR "lifecycle_category" IN ('fresh_lead', 'signup', 'active', 'dft'));

-- Composite index for tenant-scoped lookups like
-- "all stages in this tenant that map to lifecycle = 'signup'".
-- Partial index keeps it small since most rows will be NULL until
-- admins fill the column in.
CREATE INDEX "pipeline_stages_tenant_id_lifecycle_category_idx"
  ON "pipeline_stages" ("tenant_id", "lifecycle_category")
  WHERE "lifecycle_category" IS NOT NULL;
