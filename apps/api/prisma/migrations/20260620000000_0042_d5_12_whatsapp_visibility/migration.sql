-- Phase D5 — D5.12-A: WhatsApp conversation field-permission defaults.
--
-- Installs explicit deny rows for the agent cohort
-- (`sales_agent` / `activation_agent` / `driving_agent`) on
-- four `whatsapp.conversation` fields:
--
--   • handoverChain      — the structured chain of handover events.
--   • priorAgentMessages — messages older than `assignedAt`,
--                           gated by `WhatsAppVisibilityService`.
--   • reviewNotes        — TL/admin handover review notes.
--   • internalMetadata   — assignmentSource + the assignee's
--                           email + other debug payload.
--
-- The `handoverSummary` and `conversationHistory` catalogue
-- entries are deliberately NOT denied here — they are gated at
-- the read-path layer (`WhatsAppVisibilityService.shouldHidePriorMessages`)
-- which combines the role's field permission with the
-- transfer-mode floor (clean / summary always hides; full
-- defers to field permission). Future tenant-customisation can
-- toggle them via the role builder; the migration ships the
-- conservative agent-cohort defaults.
--
-- Idempotent: ON CONFLICT DO NOTHING ensures re-running the
-- migration on an already-migrated database is a no-op. The
-- seed script (`prisma/seed.ts`) installs the same rows for
-- fresh tenants created after this migration ran.
--
-- TL+ / Ops Manager / Account Manager / Super Admin keep
-- visibility because no deny row is written for them. Combined
-- with the transfer-mode floor in code, this preserves the
-- pre-D5.12-A UX exactly for the elevated cohort.
--
-- RLS — same NO FORCE / FORCE dance migrations 0030 / 0040 /
-- 0041 use so the cross-tenant SELECT can run inside the
-- migration's own transaction.

ALTER TABLE "field_permissions" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "roles" NO FORCE ROW LEVEL SECURITY;

INSERT INTO "field_permissions"
  ("tenant_id", "role_id", "resource", "field", "can_read", "can_write", "updated_at")
SELECT r."tenant_id", r."id", v."resource", v."field", FALSE, FALSE, CURRENT_TIMESTAMP
FROM "roles" r
CROSS JOIN (VALUES
  ('whatsapp.conversation', 'handoverChain'),
  ('whatsapp.conversation', 'priorAgentMessages'),
  ('whatsapp.conversation', 'reviewNotes'),
  ('whatsapp.conversation', 'internalMetadata')
) AS v("resource", "field")
WHERE r."code" IN ('sales_agent', 'activation_agent', 'driving_agent')
ON CONFLICT ("role_id", "resource", "field") DO NOTHING;

ALTER TABLE "field_permissions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "roles" FORCE ROW LEVEL SECURITY;
