-- Phase D3 — D3.1: per-stage SLA and SLA-threshold tracking.
--
-- ARCHITECTURE NOTE:
-- D3 turns the binary "breached / not breached" SLA model into a
-- five-bucket threshold ladder (ok / t75 / t100 / t150 / t200). The
-- threshold engine, scheduler events, rotation, and TL Review Queue
-- all land in later D3 chunks; D3.1 ships the schema seam they need
-- so each later step can be a small, additive commit.
--
-- This migration is purely additive:
--   - new columns on `pipeline_stages`  (per-stage SLA minutes +
--                                         working-hours flag + auto-
--                                         actions JSONB seam)
--   - new columns on `leads`            (slaThreshold ladder bucket
--                                         + last-threshold-cross
--                                         timestamp + last-rotated-at
--                                         denorm pointer)
--   - one new index on `leads`          (the future scheduler's hot
--                                         path — `(tenant, threshold,
--                                         due_at)` — even though no
--                                         service reads it yet)
-- NO existing column or index is dropped or renamed. NO row mutation.
-- Every runtime path is unchanged: D3.1 is a pure foundation commit.
--
-- Touches:
--   - pipeline_stages  + sla_minutes              INT NULL
--                       + sla_business_hours_only BOOL NOT NULL DEFAULT false
--                       + auto_actions            JSONB NULL
--   - leads            + sla_threshold            TEXT NOT NULL DEFAULT 'ok'
--                       + sla_threshold_at        TIMESTAMPTZ NULL
--                       + last_rotated_at         TIMESTAMPTZ NULL
--                       + INDEX (tenant_id, sla_threshold, sla_due_at)
--
-- Inheritance contract (D3.2 will read this; D3.1 only documents it):
--   stage.sla_minutes  ?? tenant_settings.sla_minutes
-- When the stage value is NULL the legacy tenant-wide budget wins —
-- existing tenants therefore see ZERO change in SLA timing until an
-- admin opts in by setting a per-stage value.

-- ─── 1. pipeline_stages — per-stage SLA + auto-action seam ─────────

ALTER TABLE "pipeline_stages"
  ADD COLUMN "sla_minutes"              INTEGER       NULL,
  ADD COLUMN "sla_business_hours_only"  BOOLEAN       NOT NULL DEFAULT FALSE,
  ADD COLUMN "auto_actions"             JSONB         NULL;

-- ─── 2. leads — SLA threshold ladder + rotation pointer ────────────

ALTER TABLE "leads"
  ADD COLUMN "sla_threshold"     TEXT          NOT NULL DEFAULT 'ok',
  ADD COLUMN "sla_threshold_at"  TIMESTAMPTZ(6) NULL,
  ADD COLUMN "last_rotated_at"   TIMESTAMPTZ(6) NULL;

-- ─── 3. leads — scheduler hot-path index ───────────────────────────
--
-- The future threshold-recompute scheduler scans:
--   WHERE tenant_id = $1
--     AND sla_threshold IN ('ok','t75','t100','t150')
--     AND sla_due_at IS NOT NULL
-- This composite index serves both the scanner and the UI's
-- "leads at threshold X or worse" chip filter. The index is INERT
-- in D3.1 — no service reads it yet — but creating it now keeps
-- D3.2 a service-only commit.

CREATE INDEX "leads_tenant_id_sla_threshold_sla_due_at_idx"
  ON "leads" ("tenant_id", "sla_threshold", "sla_due_at");
