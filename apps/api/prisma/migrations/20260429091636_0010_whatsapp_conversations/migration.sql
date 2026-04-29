-- C22 — WhatsApp conversations (threading).
--
-- Adds:
--   * whatsapp_conversations: one thread per (tenant_id, account_id, phone),
--     with a soft `status` flag and denormalised lastMessage summary.
--   * whatsapp_messages.conversation_id: foreign key linking every message
--     to its conversation. Added nullable, backfilled, then promoted to NOT NULL.
--   * partial unique index enforcing "one OPEN conversation per
--     (tenant, account, phone)" — closed threads can coexist with a new open one.
--   * RLS policy on whatsapp_conversations matching the rest of the
--     tenant-scoped surface (FORCE'd, current_tenant_id() comparison).

-- ── Conversations table ─────────────────────────────────────────────────────
CREATE TABLE "whatsapp_conversations" (
    "id"                UUID NOT NULL,
    "tenant_id"         UUID NOT NULL,
    "account_id"        UUID NOT NULL,
    "phone"             TEXT NOT NULL,
    "status"            TEXT NOT NULL DEFAULT 'open',
    "last_message_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_message_text" TEXT NOT NULL DEFAULT '',
    "created_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"        TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "whatsapp_conversations_pkey" PRIMARY KEY ("id")
);

-- Read-side indexes for the inbox list (newest-first per account).
CREATE INDEX "whatsapp_conversations_tenant_id_account_id_last_message_at_idx"
  ON "whatsapp_conversations"("tenant_id", "account_id", "last_message_at");
CREATE INDEX "whatsapp_conversations_tenant_id_status_last_message_at_idx"
  ON "whatsapp_conversations"("tenant_id", "status", "last_message_at");

-- Partial unique index: at most one OPEN conversation per
-- (tenant, account, phone). Closed conversations don't block a new thread.
CREATE UNIQUE INDEX "whatsapp_conversations_open_unique"
  ON "whatsapp_conversations"("tenant_id", "account_id", "phone")
  WHERE "status" = 'open';

-- FK to tenants + account.
ALTER TABLE "whatsapp_conversations"
  ADD CONSTRAINT "whatsapp_conversations_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "whatsapp_conversations"
  ADD CONSTRAINT "whatsapp_conversations_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "whatsapp_accounts"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ── conversation_id on whatsapp_messages ────────────────────────────────────
-- Nullable first so the backfill below can populate it from existing rows.
ALTER TABLE "whatsapp_messages" ADD COLUMN "conversation_id" UUID;

-- Backfill: for every distinct (tenant_id, account_id, phone) that has any
-- existing message, create one open conversation seeded with the most-recent
-- message's timestamp + text, then attach every message in that group to it.
INSERT INTO "whatsapp_conversations"
  (id, tenant_id, account_id, phone, status,
   last_message_at, last_message_text,
   created_at, updated_at)
SELECT
  gen_random_uuid(),
  m.tenant_id,
  m.account_id,
  m.phone,
  'open',
  MAX(m.created_at),
  -- Pick the most recent message's text as the seed summary. DISTINCT ON
  -- would be simpler but requires PG syntax we avoid in the same SELECT;
  -- a correlated subquery against `id = (SELECT id … LIMIT 1)` is fine
  -- since this only runs once at migrate time.
  (
    SELECT m2.text
    FROM whatsapp_messages m2
    WHERE m2.tenant_id = m.tenant_id
      AND m2.account_id = m.account_id
      AND m2.phone = m.phone
    ORDER BY m2.created_at DESC
    LIMIT 1
  ),
  MIN(m.created_at),
  NOW()
FROM whatsapp_messages m
GROUP BY m.tenant_id, m.account_id, m.phone;

-- Attach every existing message to its newly-created conversation.
UPDATE whatsapp_messages m
SET    conversation_id = c.id
FROM   whatsapp_conversations c
WHERE  c.tenant_id  = m.tenant_id
  AND  c.account_id = m.account_id
  AND  c.phone      = m.phone;

-- Now that every row has a conversation_id, promote to NOT NULL + add FK.
ALTER TABLE "whatsapp_messages" ALTER COLUMN "conversation_id" SET NOT NULL;
ALTER TABLE "whatsapp_messages"
  ADD CONSTRAINT "whatsapp_messages_conversation_id_fkey"
  FOREIGN KEY ("conversation_id") REFERENCES "whatsapp_conversations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "whatsapp_messages_conversation_id_created_at_idx"
  ON "whatsapp_messages"("conversation_id", "created_at");

-- ── RLS on whatsapp_conversations ───────────────────────────────────────────
-- Same FORCE'd tenant_isolation policy as every prior tenant-scoped table.
ALTER TABLE "whatsapp_conversations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "whatsapp_conversations" FORCE  ROW LEVEL SECURITY;
CREATE POLICY "whatsapp_conversations_tenant_isolation" ON "whatsapp_conversations"
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
