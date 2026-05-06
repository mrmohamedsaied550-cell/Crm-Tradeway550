-- Phase D5 — D5.7: ownership-history visibility via field permissions.
--
-- Replaces the hardcoded `lead.write` gate that previously controlled
-- visibility of rotation history (fromUser / toUser / actor / notes /
-- handoverSummary / internalPayload) and the lead attempts surface
-- (previousOwner / ownerHistory) by installing explicit
-- `field_permissions` deny rows for the agent cohort.
--
-- Behaviour after this migration:
--   - sales_agent / activation_agent / driving_agent → DO NOT see
--     rotation owner names, rotation notes, handover summary,
--     internal payload, lead previous-owner, or lead owner-history.
--   - tl / account_manager / ops_manager / super_admin → unchanged
--     (no deny rows written, default `defaultRead: true` applies).
--
-- The new D5.7 gate (`OwnershipVisibilityService`) consults this
-- table directly. Admins can grant any role visibility per-field via
-- the role-builder UI — the deny rows installed here are the safe
-- D4-era defaults, not a hard floor.
--
-- Idempotent: ON CONFLICT DO NOTHING ensures re-running the
-- migration on an already-migrated database is a no-op. The seed
-- script (`prisma/seed.ts`) installs the same rows for fresh
-- tenants created after the migration ran.
--
-- RLS — same `ALTER TABLE ... NO FORCE` / `FORCE` dance as
-- migration 0030 (which installed the original sales_agent deny
-- rows) so the cross-tenant SELECT can run inside the migration's
-- own transaction.

ALTER TABLE "field_permissions" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "roles" NO FORCE ROW LEVEL SECURITY;

INSERT INTO "field_permissions"
  ("tenant_id", "role_id", "resource", "field", "can_read", "can_write", "updated_at")
SELECT r."tenant_id", r."id", v."resource", v."field", FALSE, FALSE, CURRENT_TIMESTAMP
FROM "roles" r
CROSS JOIN (VALUES
  ('rotation', 'fromUser'),
  ('rotation', 'toUser'),
  ('rotation', 'actor'),
  ('rotation', 'notes'),
  ('rotation', 'handoverSummary'),
  ('rotation', 'internalPayload'),
  ('lead', 'previousOwner'),
  ('lead', 'ownerHistory')
) AS v("resource", "field")
WHERE r."code" IN ('sales_agent', 'activation_agent', 'driving_agent')
ON CONFLICT ("role_id", "resource", "field") DO NOTHING;

ALTER TABLE "field_permissions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "roles" FORCE ROW LEVEL SECURITY;
