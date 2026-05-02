-- Phase 1A — Distribution Engine (A1).
--
-- Adds three new tables that move lead distribution from the simple
-- PL-3 JSONB (source → user) to a full multi-dimensional rule engine:
--
--   distribution_rules       — the rule definitions themselves
--   agent_capacities         — per-user capacity / availability config
--   lead_routing_logs        — append-only log of every routing decision
--
-- Plus two columns on existing tables:
--
--   users.last_assigned_at         — drives true round-robin (turn-based)
--   tenant_settings.default_strategy — fallback strategy when no rule matches
--
-- A1 is schema-only. Service wiring lands in A3+; backfill from the
-- legacy JSONB column lands in A2. The legacy column itself is left
-- intact so a rollback within the same release is non-destructive.
--
-- Tenant isolation: all three tables enable RLS with the standard
-- `tenant_id = current_tenant_id()` policy. The pattern matches
-- 0021_pipeline_builder + 0022_tenant_settings.

-- ─── 1. distribution_rules ─────────────────────────────────────────
-- One row per rule. NULL on a match column means "wildcard". The
-- service picks the highest-priority active rule whose non-NULL
-- conditions all match the lead's context. Lower `priority` =
-- higher precedence (matches the operator's mental model: priority
-- 1 wins over priority 50).
CREATE TABLE "distribution_rules" (
    "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "tenant_id"      UUID NOT NULL,
    "name"           TEXT NOT NULL,
    "is_active"      BOOLEAN NOT NULL DEFAULT TRUE,
    "priority"       INTEGER NOT NULL DEFAULT 100,

    -- Match conditions (NULL = any).
    "source"         TEXT,
    "company_id"     UUID,
    "country_id"     UUID,
    "target_team_id" UUID,

    -- Strategy. Enum-as-text so adding a future strategy doesn't
    -- need a migration.
    "strategy"       TEXT NOT NULL,
    "target_user_id" UUID,

    "created_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"     TIMESTAMPTZ(6) NOT NULL,
    "created_by_id"  UUID
);

ALTER TABLE "distribution_rules"
  ADD CONSTRAINT "distribution_rules_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "distribution_rules"
  ADD CONSTRAINT "distribution_rules_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "distribution_rules"
  ADD CONSTRAINT "distribution_rules_country_id_fkey"
  FOREIGN KEY ("country_id") REFERENCES "countries"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "distribution_rules"
  ADD CONSTRAINT "distribution_rules_target_team_id_fkey"
  FOREIGN KEY ("target_team_id") REFERENCES "teams"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "distribution_rules"
  ADD CONSTRAINT "distribution_rules_target_user_id_fkey"
  FOREIGN KEY ("target_user_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "distribution_rules"
  ADD CONSTRAINT "distribution_rules_created_by_id_fkey"
  FOREIGN KEY ("created_by_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Lookup index used on every autoAssign. The match-priority order is
-- (priority ASC, is_active=TRUE) within a tenant — putting tenant_id
-- first keeps every read partitioned. A secondary index on source
-- speeds the most common predicate.
CREATE INDEX "distribution_rules_tenant_priority_active_idx"
  ON "distribution_rules" ("tenant_id", "priority", "is_active");
CREATE INDEX "distribution_rules_tenant_source_idx"
  ON "distribution_rules" ("tenant_id", "source");

ALTER TABLE "distribution_rules" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "distribution_rules" FORCE  ROW LEVEL SECURITY;
CREATE POLICY "distribution_rules_tenant_isolation" ON "distribution_rules"
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());


-- ─── 2. agent_capacities ───────────────────────────────────────────
-- Optional per-user configuration consumed by the candidate filter
-- and the weighted strategy. A user without a row uses the defaults
-- (unlimited capacity, weight=1, available, no OOF, no working-hour
-- restriction). The service synthesises the default in-memory so we
-- don't have to backfill on user create.
CREATE TABLE "agent_capacities" (
    "user_id"             UUID PRIMARY KEY,
    "tenant_id"           UUID NOT NULL,
    "max_active_leads"    INTEGER,
    "weight"              INTEGER NOT NULL DEFAULT 1,
    "is_available"        BOOLEAN NOT NULL DEFAULT TRUE,
    "out_of_office_until" TIMESTAMPTZ(6),
    "working_hours"       JSONB,
    "created_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"          TIMESTAMPTZ(6) NOT NULL
);

ALTER TABLE "agent_capacities"
  ADD CONSTRAINT "agent_capacities_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "agent_capacities"
  ADD CONSTRAINT "agent_capacities_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "agent_capacities_tenant_available_idx"
  ON "agent_capacities" ("tenant_id", "is_available");

ALTER TABLE "agent_capacities" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_capacities" FORCE  ROW LEVEL SECURITY;
CREATE POLICY "agent_capacities_tenant_isolation" ON "agent_capacities"
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());


-- ─── 3. lead_routing_logs ──────────────────────────────────────────
-- Append-only audit. One row per call into DistributionService.route
-- (including no-eligible-agent outcomes — those are the rows ops
-- needs to see most). `excluded_reasons` is keyed by user id so the
-- UI can show "candidate Bob excluded — out_of_office". Indexed on
-- (tenant_id, lead_id, decided_at DESC) so the lead-detail panel
-- pulls the most recent decision in O(log n).
CREATE TABLE "lead_routing_logs" (
    "id"               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "tenant_id"        UUID NOT NULL,
    "lead_id"          UUID NOT NULL,
    "rule_id"          UUID,
    "strategy"         TEXT NOT NULL,
    "chosen_user_id"   UUID,
    "candidate_count"  INTEGER NOT NULL,
    "excluded_count"   INTEGER NOT NULL,
    "excluded_reasons" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "decided_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "request_id"       TEXT
);

ALTER TABLE "lead_routing_logs"
  ADD CONSTRAINT "lead_routing_logs_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "lead_routing_logs"
  ADD CONSTRAINT "lead_routing_logs_lead_id_fkey"
  FOREIGN KEY ("lead_id") REFERENCES "leads"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "lead_routing_logs"
  ADD CONSTRAINT "lead_routing_logs_rule_id_fkey"
  FOREIGN KEY ("rule_id") REFERENCES "distribution_rules"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "lead_routing_logs"
  ADD CONSTRAINT "lead_routing_logs_chosen_user_id_fkey"
  FOREIGN KEY ("chosen_user_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "lead_routing_logs_tenant_lead_decided_idx"
  ON "lead_routing_logs" ("tenant_id", "lead_id", "decided_at" DESC);
CREATE INDEX "lead_routing_logs_tenant_decided_idx"
  ON "lead_routing_logs" ("tenant_id", "decided_at" DESC);

ALTER TABLE "lead_routing_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "lead_routing_logs" FORCE  ROW LEVEL SECURITY;
CREATE POLICY "lead_routing_logs_tenant_isolation" ON "lead_routing_logs"
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());


-- ─── 4. users.last_assigned_at ─────────────────────────────────────
-- Feeds the round_robin strategy. NULL on every existing row means
-- "never assigned via this engine" — the strategy treats NULL as
-- "oldest" so legacy users get picked first when the engine starts
-- making decisions.
ALTER TABLE "users"
  ADD COLUMN "last_assigned_at" TIMESTAMPTZ(6);


-- ─── 5. tenant_settings.default_strategy ───────────────────────────
-- Fallback strategy when DistributionService.route() finds no rule
-- matching the lead context. 'capacity' matches today's behaviour
-- (lowest active-lead count among eligible agents); operators can
-- flip to 'round_robin' or 'weighted' from the admin UI without a
-- code change. 'specific_user' is excluded from the default — it
-- requires a target_user_id which is per-rule, not tenant-wide.
ALTER TABLE "tenant_settings"
  ADD COLUMN "default_strategy" TEXT NOT NULL DEFAULT 'capacity';
