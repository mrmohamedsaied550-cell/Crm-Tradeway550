-- Sprint 8 (D8) — Role.is_team_leader explicit flag.
--
-- Replaces the heuristic the UI used in Sprints 6 + 7 to detect
-- team-leader roles (`code LIKE 'tl_%' OR level >= 70`) with a
-- persisted, authoritative boolean. Org tree, People table,
-- distribution, and dashboards all read this single signal from
-- Sprint 8 onwards.
--
-- The column is additive and reversible:
--   * `NOT NULL DEFAULT false` so existing rows stay valid.
--   * Backfilled in the same transaction with the exact UI
--     heuristic so behaviour at the moment of cutover is
--     identical to pre-Sprint 8.
--   * No data loss path. `ALTER TABLE roles DROP COLUMN
--     is_team_leader` reverses it cleanly.
--
-- The flag is read/use only in Sprint 8 — no editing UX yet. A
-- future sprint (paired with the D5 risk preview) will introduce
-- a guarded edit control; until then the value is set only by
-- this backfill or by direct DB write.

ALTER TABLE "roles"
  ADD COLUMN "is_team_leader" boolean NOT NULL DEFAULT false;

-- Backfill using the same heuristic the UI shipped with in
-- Sprints 6 + 7. The LIKE pattern uses a literal underscore so
-- the only roles caught are the `tl_<discipline>` codes
-- (tl_sales, tl_activation, tl_driving, …). Level 70+ catches
-- any custom TL template that follows the seeded convention.
UPDATE "roles"
SET    "is_team_leader" = true
WHERE  "code" LIKE 'tl\_%' ESCAPE '\'
   OR  "level" >= 70;

-- Composite index for "every TL role in this tenant", used by
-- the Roles overview filter chip and the Organization people
-- table's TL chip. Partial keeps the index tiny since most
-- tenants will have a handful of TL roles at most.
CREATE INDEX "roles_tenant_id_is_team_leader_idx"
  ON "roles" ("tenant_id", "is_team_leader")
  WHERE "is_team_leader" = true;
