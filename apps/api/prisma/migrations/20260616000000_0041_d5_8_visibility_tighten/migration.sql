-- Phase D5 — D5.8: tighten remaining visibility gates.
--
-- Three operations:
--
--   1. Install lead.outOfScopeAttemptCount deny rows for the agent
--      cohort (sales / activation / driving). The `outOfScopeCount`
--      field on `GET /leads/:id/attempts` is now nulled for these
--      roles by `OwnershipVisibilityService.canReadOutOfScopeAttemptCount`,
--      hiding the existence of out-of-scope predecessors entirely.
--      TL+ / Ops / Account Manager / Super Admin keep the count.
--
--   2. Install lead.review.ownerContext + lead.review.partnerContext
--      deny rows for the agent cohort. These rows are dormant
--      defence-in-depth today (the cohort doesn't hold
--      `lead.review.read`), but activate the moment an admin grants
--      review-queue access to a custom agent role: nested
--      `reasonPayload.priorAssigneeId` / `escalatedBy` /
--      `partnerSourceId` / `partnerRecordId` keys are then stripped
--      automatically by `LeadReviewVisibilityService`.
--
--   3. Clean up `rotation.handoverSummary` dead rows that migration
--      0040 left behind. The catalogue entry has been removed
--      because no `LeadRotationLog` column or RotationService
--      response surface emits a `handoverSummary` field; the
--      role-builder UI was therefore exposing a deny toggle for a
--      non-existent field. Clearing the persisted rows aligns the
--      DB with the now-honest catalogue.
--
-- Idempotent: ON CONFLICT DO NOTHING for the inserts; the DELETE
-- is naturally idempotent. Re-running the migration on an
-- already-migrated database is a no-op.
--
-- RLS — same `NO FORCE` / `FORCE` dance as migrations 0030 +
-- 0040 so the cross-tenant SELECT can run inside the migration's
-- own transaction.

ALTER TABLE "field_permissions" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "roles" NO FORCE ROW LEVEL SECURITY;

-- 1 + 2: install D5.8 deny rows for the agent cohort.
INSERT INTO "field_permissions"
  ("tenant_id", "role_id", "resource", "field", "can_read", "can_write", "updated_at")
SELECT r."tenant_id", r."id", v."resource", v."field", FALSE, FALSE, CURRENT_TIMESTAMP
FROM "roles" r
CROSS JOIN (VALUES
  ('lead', 'outOfScopeAttemptCount'),
  ('lead.review', 'ownerContext'),
  ('lead.review', 'partnerContext')
) AS v("resource", "field")
WHERE r."code" IN ('sales_agent', 'activation_agent', 'driving_agent')
ON CONFLICT ("role_id", "resource", "field") DO NOTHING;

-- 3: clean up dead rotation.handoverSummary rows installed by
-- migration 0040 before the catalogue entry was removed.
DELETE FROM "field_permissions"
WHERE "resource" = 'rotation' AND "field" = 'handoverSummary';

ALTER TABLE "field_permissions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "roles" FORCE ROW LEVEL SECURITY;
