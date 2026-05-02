-- PL-3 — per-tenant lead distribution rules.
--
-- Adds a JSONB column to `tenant_settings` carrying a list of
--   { "source": "meta" | "tiktok" | "whatsapp" | "import" | "manual",
--     "assigneeUserId": "<uuid>" }
-- entries. When a lead is auto-assigned and its `source` matches a
-- rule, the auto-assigner picks that user directly (provided they're
-- still active + role-eligible). When no rule matches, the existing
-- round-robin fallback runs.
--
-- Default `[]` so:
--   - existing rows tolerate the column without a backfill,
--   - the service can read `distributionRules ?? []` everywhere
--     without a null check on every callsite.
-- The shape is validated at the application layer (DTO + service);
-- there's deliberately no DB-side check so a future rule variant
-- (e.g. team-based) can extend the JSON without a migration.

ALTER TABLE "tenant_settings"
  ADD COLUMN "distribution_rules" JSONB NOT NULL DEFAULT '[]'::jsonb;
