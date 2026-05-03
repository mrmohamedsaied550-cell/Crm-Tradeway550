-- Phase 1B — B1: link Lead to (company, country, pipeline).
--
-- Today every lead carries a `stage_id` FK to `pipeline_stages`, but the
-- system has no way to know which *pipeline* the lead belongs to without
-- a JOIN, and the lead carries no (company, country) — so the
-- Pipeline Builder, which lets admins create per-(company × country)
-- pipelines, has no consumer in the lead lifecycle. Every lead implicitly
-- runs against the tenant's default pipeline.
--
-- This migration is purely additive:
--   * adds `company_id`, `country_id`, `pipeline_id` to `leads`
--   * leaves all three nullable
--   * backfills `pipeline_id` from the existing `stage_id` (deterministic,
--     because every stage row knows its parent pipeline)
--   * leaves `company_id` + `country_id` NULL on existing rows — they fall
--     back to the tenant default pipeline at read time, exactly as today
--   * adds covering indexes for the future Kanban + reporting queries:
--       - (tenant_id, pipeline_id, stage_id) → Kanban "all leads in
--         pipeline X grouped by stage"
--       - (tenant_id, company_id, country_id) → reporting + audit
--
-- Behavioural impact in this migration: none. No service reads the new
-- columns yet. B2 adds the pipeline resolver, B3 starts populating the
-- columns on writes, B4–B6 expose them through the API + UI.
--
-- Forward compatibility:
--   * `pipeline_id` will eventually be promoted to NOT NULL once every
--     lead row has a value (after the B3 cutover ships and a backfill
--     window passes). For now nullable lets old rows continue to flow.
--   * `company_id` + `country_id` stay nullable forever — a tenant
--     without per-(company × country) scoping should be able to operate
--     entirely on the default pipeline.
--   * Schema is shaped so future columns (lost_reason_id, score, tags)
--     plug in without touching this layout.
--
-- RLS: `leads` already has FORCE ROW LEVEL SECURITY enabled with
-- `tenant_id = current_tenant_id()`. New columns inherit that policy
-- automatically; no policy changes needed.

-- ─── 1. Add nullable columns + foreign keys ────────────────────────

ALTER TABLE "leads" ADD COLUMN "company_id"  UUID;
ALTER TABLE "leads" ADD COLUMN "country_id"  UUID;
ALTER TABLE "leads" ADD COLUMN "pipeline_id" UUID;

ALTER TABLE "leads"
  ADD CONSTRAINT "leads_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "leads"
  ADD CONSTRAINT "leads_country_id_fkey"
  FOREIGN KEY ("country_id") REFERENCES "countries"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "leads"
  ADD CONSTRAINT "leads_pipeline_id_fkey"
  FOREIGN KEY ("pipeline_id") REFERENCES "pipelines"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── 2. Backfill pipeline_id from stage_id ─────────────────────────
-- Every existing lead has a `stage_id` that resolves to exactly one
-- pipeline (PipelineStage.pipeline_id is NOT NULL). Owner role
-- bypasses RLS naturally; the migration runs as the table owner so
-- this UPDATE sees every row regardless of tenant context.

UPDATE "leads" l
SET    "pipeline_id" = ps."pipeline_id"
FROM   "pipeline_stages" ps
WHERE  ps."id" = l."stage_id"
  AND  l."pipeline_id" IS NULL;

-- ─── 3. Indexes for Kanban + reporting ─────────────────────────────
-- The Kanban groupBy is `WHERE tenant_id=? AND pipeline_id=? GROUP BY stage_id`
-- ordered by `pipeline_stages.order`. The composite index serves the
-- WHERE clause; the GROUP BY runs against the rows already filtered
-- to one pipeline, which is small enough to be cheap.
CREATE INDEX "leads_tenant_id_pipeline_id_stage_id_idx"
  ON "leads" ("tenant_id", "pipeline_id", "stage_id");

-- Reporting + admin filters by (company, country).
CREATE INDEX "leads_tenant_id_company_id_country_id_idx"
  ON "leads" ("tenant_id", "company_id", "country_id");
