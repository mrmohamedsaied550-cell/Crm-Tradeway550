-- Sprint 15 (D15) — Branding & Asset Settings.
--
-- Additive only. Three independent column groups:
--   1. tenant_settings — 9 branding columns + audit columns.
--   2. users — avatar_url (URL-based; binary upload deferred).
--   3. partner_sources — logo_url + brand_color.
--
-- All columns are nullable; no defaults so existing rows are untouched.
-- The brand_updated_by_id FK is ON DELETE SET NULL so deleting an
-- operator doesn't cascade-delete the branding row.

ALTER TABLE "tenant_settings"
  ADD COLUMN "brand_system_name" TEXT,
  ADD COLUMN "brand_workspace_name" TEXT,
  ADD COLUMN "brand_logo_url" TEXT,
  ADD COLUMN "brand_favicon_url" TEXT,
  ADD COLUMN "brand_login_image_url" TEXT,
  ADD COLUMN "brand_primary_color" TEXT,
  ADD COLUMN "brand_accent_color" TEXT,
  ADD COLUMN "brand_sidebar_bg_color" TEXT,
  ADD COLUMN "brand_sidebar_hover_color" TEXT,
  ADD COLUMN "brand_updated_at" TIMESTAMPTZ(6),
  ADD COLUMN "brand_updated_by_id" UUID;

ALTER TABLE "tenant_settings"
  ADD CONSTRAINT "tenant_settings_brand_updated_by_id_fkey"
  FOREIGN KEY ("brand_updated_by_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "users"
  ADD COLUMN "avatar_url" TEXT;

ALTER TABLE "partner_sources"
  ADD COLUMN "logo_url" TEXT,
  ADD COLUMN "brand_color" TEXT;
