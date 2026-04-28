-- C6 — foundations.
-- Establishes the cross-tenant `tenants` registry and the RLS helper that
-- downstream chunks (C8 onward) reuse on every tenant-scoped table.

-- ---------------------------------------------------------------------------
-- RLS helper: read the per-session tenant id from the GUC `app.tenant_id`.
-- Returns NULL when the GUC is unset (system-level queries that bypass
-- tenant scoping, e.g. the cross-tenant `tenants` lookup itself).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', TRUE), '')::uuid;
$$;

COMMENT ON FUNCTION current_tenant_id() IS
  'Reads app.tenant_id GUC set by TenantContextMiddleware via PrismaService.withTenant(). Returns NULL when unset.';

-- ---------------------------------------------------------------------------
-- Cross-tenant registry. Intentionally NOT row-level-security'd: this table
-- is consulted before tenant context is established (e.g. resolving a user's
-- tenant during login).
-- ---------------------------------------------------------------------------
CREATE TABLE "tenants" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tenants_code_key" ON "tenants"("code");

-- ---------------------------------------------------------------------------
-- RLS template (illustrative — applied to real tables in future migrations).
--
-- Every tenant-scoped table introduced from C8 onward will look like:
--
--   CREATE TABLE foo (
--     id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
--     tenant_id UUID NOT NULL REFERENCES tenants(id),
--     ...
--   );
--   CREATE INDEX foo_tenant_id_idx ON foo(tenant_id);
--   ALTER TABLE foo ENABLE  ROW LEVEL SECURITY;
--   ALTER TABLE foo FORCE   ROW LEVEL SECURITY;          -- enforce on owner too
--   CREATE POLICY foo_tenant_isolation ON foo
--     USING      (tenant_id = current_tenant_id())
--     WITH CHECK (tenant_id = current_tenant_id());
--
-- C6 ships only the helper; no scoped tables exist yet.
-- ---------------------------------------------------------------------------
