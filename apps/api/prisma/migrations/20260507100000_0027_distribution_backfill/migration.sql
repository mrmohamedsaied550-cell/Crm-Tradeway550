-- Phase 1A — A2: backfill legacy PL-3 JSONB rules into the new
-- relational distribution_rules table created by 0026.
--
-- Source: tenant_settings.distribution_rules JSONB array, items shaped
--   { "source": "<LeadSource>", "assigneeUserId": "<uuid>" }
--
-- Target: one INSERT per JSONB item with:
--   strategy        = 'specific_user'
--   priority        = 100              (default; admins can re-prioritise)
--   source          = item.source
--   target_user_id  = item.assigneeUserId
--   target_team_id  = NULL
--   company_id      = NULL             (legacy rules were source-only)
--   country_id      = NULL
--   name            = 'Legacy (PL-3): source=<source>'
--   is_active       = TRUE
--
-- Idempotence: a NOT EXISTS clause on (tenant_id, strategy='specific_user',
-- source, target_user_id) means re-running this migration does nothing
-- on an already-backfilled DB. It also tolerates the case where an
-- admin has, in the meantime, manually created an equivalent
-- specific_user rule via the new admin UI.
--
-- RLS handling: tenant_settings + distribution_rules both FORCE row
-- security. The migration runs as the table owner (the application
-- DB role); without FORCE the owner bypasses RLS naturally. We
-- temporarily NO FORCE both tables for the duration of the
-- single-statement INSERT, then restore. This is the same trick used
-- by 0022_tenant_settings (which inserted seed rows BEFORE enabling
-- RLS) — here we have to invert the order because the target table
-- already exists with FORCE on. The toggle is wrapped in the
-- migration's implicit transaction so no concurrent request can see
-- an unprotected window.
--
-- Live routing behaviour: A5 will switch LeadsService.autoAssign onto
-- the new engine. Until then the legacy JSONB column remains the
-- source of truth, so this migration is purely additive — new rows
-- are written but nothing reads them yet.

ALTER TABLE "tenant_settings"   NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "distribution_rules" NO FORCE ROW LEVEL SECURITY;

INSERT INTO "distribution_rules" (
  "tenant_id", "name", "is_active", "priority",
  "source", "company_id", "country_id", "target_team_id",
  "strategy", "target_user_id",
  "created_at", "updated_at", "created_by_id"
)
SELECT
  ts.tenant_id,
  'Legacy (PL-3): source=' || (elem->>'source'),
  TRUE,
  100,
  elem->>'source',
  NULL, NULL, NULL,
  'specific_user',
  (elem->>'assigneeUserId')::uuid,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP,
  NULL
FROM "tenant_settings" ts,
     jsonb_array_elements(ts."distribution_rules") elem
WHERE jsonb_typeof(ts."distribution_rules") = 'array'
  AND elem ? 'source'
  AND elem ? 'assigneeUserId'
  AND elem->>'source'         IS NOT NULL
  AND elem->>'assigneeUserId' IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "distribution_rules" dr
    WHERE dr."tenant_id"      = ts.tenant_id
      AND dr."strategy"       = 'specific_user'
      AND dr."source"         = (elem->>'source')
      AND dr."target_user_id" = (elem->>'assigneeUserId')::uuid
  );

ALTER TABLE "distribution_rules" FORCE ROW LEVEL SECURITY;
ALTER TABLE "tenant_settings"    FORCE ROW LEVEL SECURITY;
