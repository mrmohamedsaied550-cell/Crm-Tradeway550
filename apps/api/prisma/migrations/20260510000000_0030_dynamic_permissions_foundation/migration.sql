-- Phase C — C1: dynamic permissions foundation.
--
-- Single additive migration that lays the groundwork for the role
-- builder, data scopes, and field-level permissions. No service code
-- reads or writes the new tables yet — C2..C12 wire them in.
--
-- Touches:
--   - roles                  + is_system  (mark seeded templates)
--                            + description
--   - new table:   role_scopes              (data scope per (role × resource))
--   - new table:   user_scope_assignments   (user → company/country bindings)
--   - new table:   field_permissions        (per (role × resource × field))
--
-- Backfills:
--   - roles.is_system = TRUE for the 11 system role codes (super_admin,
--     ops_manager, account_manager, tl_sales, tl_activation, tl_driving,
--     qa_specialist, sales_agent, activation_agent, driving_agent, viewer).
--     System roles are fully immutable by C2's service-layer guards.
--   - role_scopes: one row per (role × resource) defaulting to 'global'
--     for every existing role. Resources: lead, captain, followup,
--     whatsapp.conversation. Preserves today's behaviour: all 452
--     existing tests assume global visibility.
--   - field_permissions: 3 explicit deny rows for the `sales_agent`
--     role (lead.id, lead.attribution.campaign, lead.source) with
--     can_read=FALSE. The default for absent rows is read=TRUE/
--     write=TRUE — restrictions are explicit denials, not whitelists.
--     C4 wires the read-side enforcement; until then these rows exist
--     but are unread, so the test suite is unaffected.
--
-- RLS: each new table gets the standard FORCE ROW LEVEL SECURITY
-- policy keyed on `tenant_id = current_tenant_id()`.
--
-- All backfills run inside a NO FORCE / FORCE pair (same pattern as
-- 0027 / 0029) so the migration's owner role can write the rows
-- without a tenant GUC set.

-- ─── 1. roles — is_system + description ──────────────────────────────

ALTER TABLE "roles" ADD COLUMN "is_system"   BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE "roles" ADD COLUMN "description" TEXT NULL;

-- Mark the 11 seeded system roles. The codes match
-- ROLE_DEFINITIONS in apps/api/src/rbac/roles.registry.ts. Any future
-- code added to the registry must be added here as well — the seed
-- (idempotent) keeps it in sync, but this UPDATE is what protects
-- existing rows the moment this migration runs.
ALTER TABLE "roles" NO FORCE ROW LEVEL SECURITY;
UPDATE "roles"
  SET "is_system" = TRUE
  WHERE "code" IN (
    'super_admin',
    'ops_manager',
    'account_manager',
    'tl_sales',
    'tl_activation',
    'tl_driving',
    'qa_specialist',
    'sales_agent',
    'activation_agent',
    'driving_agent',
    'viewer'
  );
ALTER TABLE "roles" FORCE ROW LEVEL SECURITY;

CREATE INDEX "roles_tenant_id_is_system_idx"
  ON "roles" ("tenant_id", "is_system");

-- ─── 2. role_scopes ──────────────────────────────────────────────────

CREATE TABLE "role_scopes" (
    "tenant_id"  UUID NOT NULL,
    "role_id"    UUID NOT NULL,
    "resource"   TEXT NOT NULL,
    "scope"      TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "role_scopes_pkey" PRIMARY KEY ("role_id", "resource"),
    CONSTRAINT "role_scopes_scope_check"
      CHECK ("scope" IN ('own', 'team', 'company', 'country', 'global')),
    CONSTRAINT "role_scopes_resource_check"
      CHECK ("resource" IN ('lead', 'captain', 'followup', 'whatsapp.conversation'))
);

ALTER TABLE "role_scopes"
  ADD CONSTRAINT "role_scopes_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "role_scopes"
  ADD CONSTRAINT "role_scopes_role_id_fkey"
  FOREIGN KEY ("role_id") REFERENCES "roles"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "role_scopes_tenant_id_resource_idx"
  ON "role_scopes" ("tenant_id", "resource");

ALTER TABLE "role_scopes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "role_scopes" FORCE ROW LEVEL SECURITY;

CREATE POLICY "role_scopes_tenant_isolation" ON "role_scopes"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

-- Seed: one row per (role × resource) defaulting to 'global'. Done as
-- a Cartesian-style INSERT so a tenant with N roles gets N×4 rows.
-- Idempotent via the (role_id, resource) PK; ON CONFLICT DO NOTHING
-- covers re-runs and partial backfills.
ALTER TABLE "roles" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "role_scopes" NO FORCE ROW LEVEL SECURITY;

INSERT INTO "role_scopes" ("tenant_id", "role_id", "resource", "scope", "updated_at")
SELECT r."tenant_id", r."id", v."resource", 'global', CURRENT_TIMESTAMP
FROM "roles" r
CROSS JOIN (VALUES
  ('lead'),
  ('captain'),
  ('followup'),
  ('whatsapp.conversation')
) AS v("resource")
ON CONFLICT ("role_id", "resource") DO NOTHING;

ALTER TABLE "roles" FORCE ROW LEVEL SECURITY;
ALTER TABLE "role_scopes" FORCE ROW LEVEL SECURITY;

-- ─── 3. user_scope_assignments ───────────────────────────────────────
--
-- Binds users to (company?, country?) tuples for the `company` and
-- `country` data scopes. Either `company_id` or `country_id` (or
-- both) must be set — a row with both NULL would be meaningless. A
-- user can be assigned to N tuples (multi-country / multi-company
-- managers).

CREATE TABLE "user_scope_assignments" (
    "id"         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "tenant_id"  UUID NOT NULL,
    "user_id"    UUID NOT NULL,
    "company_id" UUID NULL,
    "country_id" UUID NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "user_scope_assignments_at_least_one_check"
      CHECK ("company_id" IS NOT NULL OR "country_id" IS NOT NULL)
);

ALTER TABLE "user_scope_assignments"
  ADD CONSTRAINT "user_scope_assignments_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_scope_assignments"
  ADD CONSTRAINT "user_scope_assignments_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_scope_assignments"
  ADD CONSTRAINT "user_scope_assignments_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_scope_assignments"
  ADD CONSTRAINT "user_scope_assignments_country_id_fkey"
  FOREIGN KEY ("country_id") REFERENCES "countries"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Composite uniqueness: a (user × company × country) tuple appears at
-- most once. NULLs are distinct in PostgreSQL by default — that's
-- fine here (a user with company-only and country-only scopes is a
-- separate combination). NULLS NOT DISTINCT would also work but the
-- default behaviour is sufficient.
CREATE UNIQUE INDEX "user_scope_assignments_user_company_country_key"
  ON "user_scope_assignments" ("user_id", "company_id", "country_id");

CREATE INDEX "user_scope_assignments_tenant_user_idx"
  ON "user_scope_assignments" ("tenant_id", "user_id");
CREATE INDEX "user_scope_assignments_tenant_company_idx"
  ON "user_scope_assignments" ("tenant_id", "company_id");
CREATE INDEX "user_scope_assignments_tenant_country_idx"
  ON "user_scope_assignments" ("tenant_id", "country_id");

ALTER TABLE "user_scope_assignments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_scope_assignments" FORCE ROW LEVEL SECURITY;

CREATE POLICY "user_scope_assignments_tenant_isolation" ON "user_scope_assignments"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

-- No backfill — existing users have no scope assignments. They keep
-- their current behaviour because every role defaults to 'global'
-- scope from the role_scopes seed above. Admins create assignments
-- only when they switch a role's scope to 'company' or 'country'.

-- ─── 4. field_permissions ────────────────────────────────────────────
--
-- Per (role × resource × field) read/write toggles. Default for
-- absent rows is read=TRUE / write=TRUE — restrictions are explicit
-- denials, not whitelists. This keeps the 452 tests passing without
-- seed gymnastics: only rows that flip a default to FALSE need to
-- exist. Field paths use dot-syntax for nested JSON (e.g.
-- 'attribution.campaign.id').

CREATE TABLE "field_permissions" (
    "tenant_id"  UUID NOT NULL,
    "role_id"    UUID NOT NULL,
    "resource"   TEXT NOT NULL,
    "field"      TEXT NOT NULL,
    "can_read"   BOOLEAN NOT NULL DEFAULT TRUE,
    "can_write"  BOOLEAN NOT NULL DEFAULT TRUE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "field_permissions_pkey" PRIMARY KEY ("role_id", "resource", "field")
);

ALTER TABLE "field_permissions"
  ADD CONSTRAINT "field_permissions_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "field_permissions"
  ADD CONSTRAINT "field_permissions_role_id_fkey"
  FOREIGN KEY ("role_id") REFERENCES "roles"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "field_permissions_tenant_resource_idx"
  ON "field_permissions" ("tenant_id", "resource");

ALTER TABLE "field_permissions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "field_permissions" FORCE ROW LEVEL SECURITY;

CREATE POLICY "field_permissions_tenant_isolation" ON "field_permissions"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

-- Seed: explicit deny rows for sales_agent — id, attribution.campaign,
-- and source on the lead resource. Read-side enforcement lands in C4;
-- until then these rows exist but are unread, so existing tests are
-- unaffected. INSERT is keyed on the role's id (resolved per tenant)
-- so a tenant without `sales_agent` simply gets zero rows.
ALTER TABLE "field_permissions" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "roles" NO FORCE ROW LEVEL SECURITY;

INSERT INTO "field_permissions"
  ("tenant_id", "role_id", "resource", "field", "can_read", "can_write", "updated_at")
SELECT r."tenant_id", r."id", v."resource", v."field", FALSE, FALSE, CURRENT_TIMESTAMP
FROM "roles" r
CROSS JOIN (VALUES
  ('lead', 'id'),
  ('lead', 'attribution.campaign'),
  ('lead', 'source')
) AS v("resource", "field")
WHERE r."code" = 'sales_agent'
ON CONFLICT ("role_id", "resource", "field") DO NOTHING;

ALTER TABLE "field_permissions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "roles" FORCE ROW LEVEL SECURITY;
