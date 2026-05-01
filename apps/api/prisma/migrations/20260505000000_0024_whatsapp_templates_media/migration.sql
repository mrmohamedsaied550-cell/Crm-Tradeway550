-- P2-12 — WhatsApp templates + media support.
--
-- Three changes:
--   1. New `whatsapp_templates` table — admin-recorded list of
--      Meta-approved templates per account.
--   2. New columns on `whatsapp_messages`: messageType, mediaUrl,
--      mediaMimeType, templateName, templateLanguage. Existing rows
--      backfill to messageType='text' and NULL for the rest.
--   3. New `last_inbound_at` column + index on
--      `whatsapp_conversations` so the service layer can enforce
--      Meta's 24-hour customer-service window. Backfill from the
--      latest inbound row per conversation; future inbound writes
--      keep it in sync.

-- ─── 1. whatsapp_templates ───────────────────────────────────────
CREATE TABLE "whatsapp_templates" (
    "id"              UUID NOT NULL,
    "tenant_id"       UUID NOT NULL,
    "account_id"      UUID NOT NULL,
    "name"            TEXT NOT NULL,
    "language"        TEXT NOT NULL,
    "category"        TEXT NOT NULL,
    "body_text"       TEXT NOT NULL,
    "variable_count"  INTEGER NOT NULL DEFAULT 0,
    "status"          TEXT NOT NULL DEFAULT 'approved',
    "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"      TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "whatsapp_templates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "whatsapp_templates_account_id_name_language_key"
  ON "whatsapp_templates"("account_id", "name", "language");
CREATE INDEX "whatsapp_templates_tenant_id_status_idx"
  ON "whatsapp_templates"("tenant_id", "status");

ALTER TABLE "whatsapp_templates"
  ADD CONSTRAINT "whatsapp_templates_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "whatsapp_templates"
  ADD CONSTRAINT "whatsapp_templates_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "whatsapp_accounts"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "whatsapp_templates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "whatsapp_templates" FORCE  ROW LEVEL SECURITY;
CREATE POLICY "whatsapp_templates_tenant_isolation" ON "whatsapp_templates"
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- ─── 2. whatsapp_messages — media + template columns ─────────────
ALTER TABLE "whatsapp_messages"
  ADD COLUMN "message_type"      TEXT NOT NULL DEFAULT 'text',
  ADD COLUMN "media_url"          TEXT,
  ADD COLUMN "media_mime_type"    TEXT,
  ADD COLUMN "template_name"      TEXT,
  ADD COLUMN "template_language"  TEXT;

-- ─── 3. whatsapp_conversations.last_inbound_at + backfill ────────
ALTER TABLE "whatsapp_conversations"
  ADD COLUMN "last_inbound_at" TIMESTAMPTZ(6);

-- Backfill: for each conversation, find the most recent inbound
-- message timestamp and stamp it. Toggle FORCE off for the duration
-- of the UPDATE so the migration role can see rows across tenants
-- without an `app.tenant_id` GUC (mirrors the 0021_pipeline_builder
-- pattern).
ALTER TABLE "whatsapp_conversations" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "whatsapp_messages"      NO FORCE ROW LEVEL SECURITY;

UPDATE "whatsapp_conversations" c
SET    "last_inbound_at" = sub.max_at
FROM (
  SELECT m."conversation_id" AS conv_id, MAX(m."created_at") AS max_at
  FROM   "whatsapp_messages" m
  WHERE  m."direction" = 'inbound'
  GROUP  BY m."conversation_id"
) sub
WHERE c."id" = sub.conv_id;

ALTER TABLE "whatsapp_conversations" FORCE ROW LEVEL SECURITY;
ALTER TABLE "whatsapp_messages"      FORCE ROW LEVEL SECURITY;

CREATE INDEX "whatsapp_conversations_tenant_id_last_inbound_at_idx"
  ON "whatsapp_conversations"("tenant_id", "last_inbound_at");
