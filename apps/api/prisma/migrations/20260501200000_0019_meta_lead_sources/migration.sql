-- P2-06 — Meta Lead Ads ingestion source.
--
-- One row per Facebook Page (or Page+Form) the tenant runs lead ads on.
-- The public `/webhooks/meta/leadgen` endpoint is cross-tenant, so the
-- routing lookup happens against this table BEFORE any tenant context
-- exists for the request. We therefore intentionally DO NOT enable RLS
-- on `meta_lead_sources`:
--   - the table holds only routing + transformation config (no user PII,
--     no auth tokens — verify token + app secret are the only sensitive
--     fields and they're necessary for the cross-tenant webhook auth),
--   - admin CRUD enforces tenant scope in the service layer via an
--     explicit `WHERE tenant_id = $tenantId` filter.
--
-- This mirrors the `whatsapp_routes` pattern (migration 0009), but
-- collapses the routes table into the source-of-truth row since
-- there's no second access-token-bearing table to mirror.

CREATE TABLE "meta_lead_sources" (
    "id"             UUID NOT NULL,
    "tenant_id"      UUID NOT NULL,
    "display_name"   TEXT NOT NULL,
    "page_id"        TEXT NOT NULL,
    "form_id"        TEXT,
    "verify_token"   TEXT NOT NULL,
    "app_secret"     TEXT,
    "default_source" TEXT NOT NULL DEFAULT 'meta',
    "field_mapping"  JSONB NOT NULL,
    "is_active"      BOOLEAN NOT NULL DEFAULT TRUE,
    "created_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"     TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "meta_lead_sources_pkey" PRIMARY KEY ("id")
);

-- One row per (tenant, page, form). `form_id` may be NULL when the
-- tenant only runs a single form per page.
CREATE UNIQUE INDEX "meta_lead_sources_tenant_id_page_id_form_id_key"
  ON "meta_lead_sources"("tenant_id", "page_id", "form_id");
CREATE INDEX "meta_lead_sources_tenant_id_is_active_idx"
  ON "meta_lead_sources"("tenant_id", "is_active");
-- Cross-tenant routing lookup keys for the public webhook.
CREATE INDEX "meta_lead_sources_page_id_is_active_idx"
  ON "meta_lead_sources"("page_id", "is_active");
CREATE INDEX "meta_lead_sources_verify_token_idx"
  ON "meta_lead_sources"("verify_token");

ALTER TABLE "meta_lead_sources"
  ADD CONSTRAINT "meta_lead_sources_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Intentionally NO `ENABLE ROW LEVEL SECURITY` — see header comment.
