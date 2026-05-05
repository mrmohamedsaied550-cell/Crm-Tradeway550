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
-- DEFENSIVE DROP (D2 fix-up, 2026-05-05):
--   The original migration assumed the prior UNIQUE was named
--   `leads_tenant_id_phone_key` — Prisma's typical default. CI
--   environments and staging branches that pre-date Prisma's naming
--   convention may carry the constraint under a different name (or
--   as a stand-alone unique index not backed by a constraint). We
--   now discover the matching object by COLUMN SET — exactly
--   {tenant_id, phone} — instead of by name, so the migration runs
--   cleanly across every environment. The new partial-unique is
--   created with `IF NOT EXISTS` so a partial prior run that left
--   it behind is also safe to re-run. We deliberately exclude
--   partial indexes (`indpred IS NULL`) from the dropper so the
--   new `leads_open_phone_uniq` itself is never targeted. We also
--   exclude any unique index that backs a constraint (those are
--   handled by the constraint-drop loop) so we don't double-drop.
--
-- Touches:
--   - leads — DROP any UNIQUE constraint on (tenant_id, phone)
--             DROP any standalone non-partial UNIQUE index on (tenant_id, phone)
--             CREATE UNIQUE INDEX leads_open_phone_uniq
--               ON leads (tenant_id, phone)
--               WHERE lifecycle_state = 'open'
-- All other constraints, indexes, columns, RLS policies — UNCHANGED.

-- ─── 1. drop the lifelong UNIQUE — defensively, by column set ─────

DO $$
DECLARE
  v_name TEXT;
BEGIN
  -- 1a. Drop any UNIQUE constraint on `leads` whose column set is
  --     EXACTLY {tenant_id, phone}. We compare alphabetically-sorted
  --     column-name aggregates so column ORDER inside the constraint
  --     definition is irrelevant — Prisma's default and a hand-rolled
  --     UNIQUE in either order both match.
  FOR v_name IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class cls ON cls.oid = con.conrelid
    WHERE cls.relname = 'leads'
      AND con.contype = 'u'
      AND (
        SELECT string_agg(att.attname, ',' ORDER BY att.attname)
        FROM pg_attribute att
        WHERE att.attrelid = con.conrelid
          AND att.attnum = ANY(con.conkey)
      ) = 'phone,tenant_id'
  LOOP
    EXECUTE 'ALTER TABLE "leads" DROP CONSTRAINT ' || quote_ident(v_name);
  END LOOP;

  -- 1b. Also drop any STANDALONE UNIQUE INDEX on (tenant_id, phone)
  --     that isn't backed by a constraint (so step 1a didn't catch
  --     it) and isn't partial (so the new `leads_open_phone_uniq`
  --     — which has `WHERE lifecycle_state = 'open'` — is preserved
  --     if it already exists from a prior partial run).
  --
  --     `pg_index.indkey` is `int2vector`; we go via its text
  --     representation ("1 2 …") + `string_to_array` so the lookup
  --     is portable across every Postgres version we deploy on,
  --     without depending on the implicit cast to `int2[]`.
  FOR v_name IN
    SELECT cls.relname
    FROM pg_index idx
    JOIN pg_class cls ON cls.oid = idx.indexrelid
    JOIN pg_class tbl ON tbl.oid = idx.indrelid
    WHERE tbl.relname = 'leads'
      AND idx.indisunique = TRUE
      AND idx.indpred IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM pg_constraint con
        WHERE con.conindid = idx.indexrelid
      )
      AND (
        SELECT string_agg(att.attname, ',' ORDER BY att.attname)
        FROM pg_attribute att
        WHERE att.attrelid = idx.indrelid
          AND att.attnum = ANY(
            string_to_array(idx.indkey::text, ' ')::int2[]
          )
      ) = 'phone,tenant_id'
  LOOP
    EXECUTE 'DROP INDEX ' || quote_ident(v_name);
  END LOOP;
END $$;

-- ─── 2. add the partial-unique-on-open ────────────────────────────
--
-- `IF NOT EXISTS` makes the migration idempotent against partial
-- prior runs. The new index name `leads_open_phone_uniq` is unique
-- to D2.3 — no earlier migration uses it — so the only way it
-- already exists is a re-run of THIS migration.

CREATE UNIQUE INDEX IF NOT EXISTS "leads_open_phone_uniq"
  ON "leads" ("tenant_id", "phone")
  WHERE "lifecycle_state" = 'open';
