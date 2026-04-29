-- C25 — link WhatsApp conversations to leads.
--
-- Adds an optional `lead_id` FK on `whatsapp_conversations`. Existing rows
-- backfill to NULL (no implicit auto-link at migrate time — auto-linking
-- happens lazily on read via the service). FK is ON DELETE SET NULL so
-- removing a lead does NOT cascade-delete its conversation thread.
--
-- The supporting `(tenant_id, lead_id)` index keeps the lookup
-- "all conversations for this lead" cheap; the existing tenant-isolation
-- RLS policy on whatsapp_conversations already covers reads.

ALTER TABLE "whatsapp_conversations" ADD COLUMN "lead_id" UUID;

ALTER TABLE "whatsapp_conversations"
  ADD CONSTRAINT "whatsapp_conversations_lead_id_fkey"
  FOREIGN KEY ("lead_id") REFERENCES "leads"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "whatsapp_conversations_tenant_id_lead_id_idx"
  ON "whatsapp_conversations"("tenant_id", "lead_id");
