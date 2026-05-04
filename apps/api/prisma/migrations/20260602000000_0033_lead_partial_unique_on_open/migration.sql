-- Phase D2 — D2.3: replace the lifelong (tenant_id, phone) UNIQUE
-- on `leads` with a PARTIAL UNIQUE INDEX scoped to OPEN leads only.
--
-- ARCHITECTURE NOTE:
-- This is the first migration that allows multiple historical Lead
-- rows to share a phone within the same tenant. Closed / lost / won
-- / archived leads coexist as historical attempts; only ONE row per
-- (tenant, phone) may have lifecycle_state = 'open' at a time.
--
-- The partial-unique index is the database-level guarantee behind
-- the D2.2 DuplicateDecisionService — every "should I create a new
-- attempt or reject as duplicate" decision the engine makes is
-- backed by this constraint. The service-layer engine evaluates
-- BEFORE the insert; the partial index catches concurrent racers
-- that pass the engine's check simultaneously.
--
-- Reversibility:
--   The reverse migration drops the partial index and re-creates
--   the original UNIQUE constraint:
--     DROP INDEX leads_open_phone_uniq;
--     ALTER TABLE leads
--       ADD CONSTRAINT leads_tenant_id_phone_key UNIQUE (tenant_id, phone);
--   That reverse FAILS if any (tenant, phone) pair has more than one
--   row by then — i.e., once D2.3 is live in production and
--   reactivations have created multi-attempt rows, the constraint
--   cannot be re-added without a data merge step. This is expected
--   and matches the locked Option B architecture: once we're in
--   multi-attempt land, we stay there.
--
-- Pre-flight invariant (verified by tests, not by the migration):
--   Before this migration runs, the existing UNIQUE constraint
--   guarantees zero (tenant, phone) duplicates exist. The new
--   partial index therefore CAN be created without violating itself
--   on day one. If staging has dirty data (from manual SQL edits),
--   the CREATE INDEX call below will fail with a unique-violation —
--   which is the correct, loud failure mode.
--
-- Touches:
--   - leads — DROP CONSTRAINT leads_tenant_id_phone_key
--             CREATE UNIQUE INDEX leads_open_phone_uniq
--               ON leads (tenant_id, phone)
--               WHERE lifecycle_state = 'open'
-- All other constraints, indexes, columns, RLS policies — UNCHANGED.

-- ─── 1. drop the lifelong UNIQUE ──────────────────────────────────

ALTER TABLE "leads"
  DROP CONSTRAINT "leads_tenant_id_phone_key";

-- ─── 2. add the partial-unique-on-open ────────────────────────────

CREATE UNIQUE INDEX "leads_open_phone_uniq"
  ON "leads" ("tenant_id", "phone")
  WHERE "lifecycle_state" = 'open';
