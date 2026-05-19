-- Sprint M1: Meta OAuth Connection + Lead Attribution
--
-- Adds:
--   1. `meta_oauth_connections` table (long-lived Facebook User Access Token)
--   2. Additive columns on `meta_lead_sources` (OAuth link, page/form names, taxonomy)
--   3. Additive columns on `leads` (Meta campaign/adset/ad attribution)
--   4. Supporting indexes

-- 1. Create meta_oauth_connections table
CREATE TABLE "meta_oauth_connections" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "facebook_user_id" TEXT NOT NULL,
    "facebook_name" TEXT NOT NULL,
    "access_token" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "meta_oauth_connections_pkey" PRIMARY KEY ("id")
);

-- Indexes on meta_oauth_connections
CREATE UNIQUE INDEX "meta_oauth_connections_tenant_id_facebook_user_id_key"
  ON "meta_oauth_connections"("tenant_id", "facebook_user_id");
CREATE INDEX "meta_oauth_connections_tenant_id_revoked_at_idx"
  ON "meta_oauth_connections"("tenant_id", "revoked_at");

-- FK: meta_oauth_connections → tenants
ALTER TABLE "meta_oauth_connections"
  ADD CONSTRAINT "meta_oauth_connections_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- 2. Additive columns on meta_lead_sources
ALTER TABLE "meta_lead_sources"
  ADD COLUMN "oauth_connection_id" UUID,
  ADD COLUMN "page_name" TEXT,
  ADD COLUMN "form_name" TEXT,
  ADD COLUMN "project" TEXT,
  ADD COLUMN "channel" TEXT,
  ADD COLUMN "campaign" TEXT;

-- FK: meta_lead_sources.oauth_connection_id → meta_oauth_connections
ALTER TABLE "meta_lead_sources"
  ADD CONSTRAINT "meta_lead_sources_oauth_connection_id_fkey"
  FOREIGN KEY ("oauth_connection_id") REFERENCES "meta_oauth_connections"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Indexes on meta_lead_sources (new)
CREATE INDEX "meta_lead_sources_tenant_id_oauth_connection_id_idx"
  ON "meta_lead_sources"("tenant_id", "oauth_connection_id");
CREATE INDEX "meta_lead_sources_tenant_id_project_channel_idx"
  ON "meta_lead_sources"("tenant_id", "project", "channel");

-- 3. Additive columns on leads (Meta attribution)
ALTER TABLE "leads"
  ADD COLUMN "meta_campaign_id" TEXT,
  ADD COLUMN "meta_campaign_name" TEXT,
  ADD COLUMN "meta_adset_id" TEXT,
  ADD COLUMN "meta_adset_name" TEXT,
  ADD COLUMN "meta_ad_id" TEXT,
  ADD COLUMN "meta_ad_name" TEXT;

-- Indexes on leads (Meta attribution rollups)
CREATE INDEX "leads_tenant_id_meta_campaign_id_idx"
  ON "leads"("tenant_id", "meta_campaign_id");
CREATE INDEX "leads_tenant_id_meta_adset_id_idx"
  ON "leads"("tenant_id", "meta_adset_id");
