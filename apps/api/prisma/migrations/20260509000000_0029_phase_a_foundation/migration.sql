-- Phase A — A1: foundation schema additions.
--
-- One additive migration that lays the groundwork for the lifecycle /
-- lost-reason / attribution / follow-up-snooze features. No service
-- code reads or writes the new columns yet — A2..A7 wire them in.
--
-- Touches:
--   - new table:   lost_reasons          (per-tenant configurable list)
--   - leads:       + lifecycle_state
--                  + lost_reason_id
--                  + lost_note
--                  + attribution         (JSONB)
--   - pipeline_stages:
--                  + terminal_kind       (null | 'won' | 'lost')
--   - lead_followups:
--                  + snoozed_until
--
-- Backfills:
--   - lost_reasons seeded with the canonical 7 codes per existing
--     tenant (no_vehicle, wrong_phone, not_interested, joined_competitor,
--     disqualified, duplicate, other).
--   - pipeline_stages: terminal_kind set to 'won' for stages with
--     code='converted' (existing system contract) and 'lost' for
--     code='lost'. Other stages keep terminal_kind=NULL even if their
--     isTerminal flag is true (admin can edit later).
--   - leads.lifecycle_state: derived from the joined stage's new
--     terminal_kind. Default 'open'; rows on a 'won' terminal
--     terminal stage become 'won'; rows on 'lost' become 'lost'.
--   - leads.attribution: '{ "source": <leads.source> }' so existing
--     rows have a non-null payload that mirrors their flat source.
--
-- RLS: lost_reasons gets the standard FORCE ROW LEVEL SECURITY
-- policy keyed on `tenant_id = current_tenant_id()`. The other
-- columns inherit their parent tables' policies automatically.

-- ─── 1. lost_reasons table ───────────────────────────────────────────

CREATE TABLE "lost_reasons" (
    "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "tenant_id"      UUID NOT NULL,
    "code"           TEXT NOT NULL,
    "label_en"       TEXT NOT NULL,
    "label_ar"       TEXT NOT NULL,
    "is_active"      BOOLEAN NOT NULL DEFAULT TRUE,
    "display_order"  INTEGER NOT NULL DEFAULT 100,
    "created_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"     TIMESTAMPTZ(6) NOT NULL
);

ALTER TABLE "lost_reasons"
  ADD CONSTRAINT "lost_reasons_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "lost_reasons_tenant_id_code_key"
  ON "lost_reasons" ("tenant_id", "code");

CREATE INDEX "lost_reasons_tenant_id_is_active_display_order_idx"
  ON "lost_reasons" ("tenant_id", "is_active", "display_order");

-- RLS — same pattern as every other tenant-scoped table.
ALTER TABLE "lost_reasons" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "lost_reasons" FORCE ROW LEVEL SECURITY;

CREATE POLICY "lost_reasons_tenant_isolation" ON "lost_reasons"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

-- ─── 2. leads — new columns ──────────────────────────────────────────

ALTER TABLE "leads" ADD COLUMN "lifecycle_state" TEXT NOT NULL DEFAULT 'open';
ALTER TABLE "leads" ADD COLUMN "lost_reason_id"  UUID NULL;
ALTER TABLE "leads" ADD COLUMN "lost_note"       TEXT NULL;
ALTER TABLE "leads" ADD COLUMN "attribution"     JSONB NULL;

ALTER TABLE "leads"
  ADD CONSTRAINT "leads_lost_reason_id_fkey"
  FOREIGN KEY ("lost_reason_id") REFERENCES "lost_reasons"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- The hot path for the workspace's "active leads" filter.
CREATE INDEX "leads_tenant_id_lifecycle_state_idx"
  ON "leads" ("tenant_id", "lifecycle_state");

-- A targeted JSON expression index for the field distribution
-- rules + reports will actually filter on once Phase D lands.
CREATE INDEX "leads_attribution_campaign_id_idx"
  ON "leads" ((attribution -> 'campaign' ->> 'id'))
  WHERE attribution -> 'campaign' ->> 'id' IS NOT NULL;

-- ─── 3. pipeline_stages — terminal_kind ──────────────────────────────
--
-- Backfills + the existing tenant-scoped tables (pipeline_stages,
-- leads, lead_followups) are FORCE RLS, which makes the owner role
-- subject to the `tenant_id = current_tenant_id()` policy. The
-- migration runs without a tenant context, so any UPDATE / SELECT
-- that doesn't NO FORCE first sees zero rows. Wrap the backfills
-- in NO FORCE / FORCE pairs (same trick as 0027); the surrounding
-- transaction prevents any unprotected window.

ALTER TABLE "pipeline_stages" ADD COLUMN "terminal_kind" TEXT NULL;

ALTER TABLE "pipeline_stages" NO FORCE ROW LEVEL SECURITY;
-- Backfill against the system contract: 'converted' is the canonical
-- "won" stage; 'lost' is the canonical "lost" stage. Existing tenants
-- have these in their default pipeline (seed installs them); custom
-- pipelines may not — admins can edit later.
UPDATE "pipeline_stages" SET "terminal_kind" = 'won'  WHERE "code" = 'converted';
UPDATE "pipeline_stages" SET "terminal_kind" = 'lost' WHERE "code" = 'lost';
ALTER TABLE "pipeline_stages" FORCE ROW LEVEL SECURITY;

-- ─── 4. lead_followups — snoozed_until ───────────────────────────────

ALTER TABLE "lead_followups" ADD COLUMN "snoozed_until" TIMESTAMPTZ(6) NULL;

-- ─── 5. Backfill leads.lifecycle_state from stage.terminal_kind ──────

ALTER TABLE "leads" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "pipeline_stages" NO FORCE ROW LEVEL SECURITY;
UPDATE "leads" l
SET    "lifecycle_state" = COALESCE(ps."terminal_kind", 'open')
FROM   "pipeline_stages" ps
WHERE  ps."id" = l."stage_id";

-- ─── 6. Backfill leads.attribution from leads.source ────────────────

UPDATE "leads"
SET    "attribution" = jsonb_build_object('source', "source")
WHERE  "attribution" IS NULL;
ALTER TABLE "leads" FORCE ROW LEVEL SECURITY;
ALTER TABLE "pipeline_stages" FORCE ROW LEVEL SECURITY;

-- ─── 7. Seed lost_reasons for every existing tenant ──────────────────
-- For each tenant, insert the canonical 7 reasons with display_order
-- 10..70. Idempotent via the (tenant_id, code) UNIQUE constraint —
-- ON CONFLICT DO NOTHING covers re-runs.
--
-- The table OWNER (the application DB role used by Prisma migrate)
-- normally bypasses RLS, but FORCE ROW LEVEL SECURITY makes the
-- policy apply to the owner too. Same trick as 0027: temporarily
-- NO FORCE the table for the seed, then restore. The whole migration
-- runs in one transaction so no concurrent request can see an
-- unprotected window.

ALTER TABLE "lost_reasons" NO FORCE ROW LEVEL SECURITY;

INSERT INTO "lost_reasons"
  ("tenant_id", "code", "label_en", "label_ar", "is_active", "display_order", "updated_at")
SELECT t."id", v.code, v.label_en, v.label_ar, TRUE, v.ord, CURRENT_TIMESTAMP
FROM "tenants" t
CROSS JOIN (VALUES
  ('no_vehicle',        'No vehicle',                      'لا توجد مركبة',         10),
  ('wrong_phone',       'Wrong / unreachable phone',       'رقم خاطئ',              20),
  ('not_interested',    'Not interested',                  'غير مهتم',              30),
  ('joined_competitor', 'Joined competitor',               'انضم لمنافس',           40),
  ('disqualified',      'Did not meet requirements',       'لا يستوفي الشروط',      50),
  ('duplicate',         'Duplicate',                       'مكرر',                  60),
  ('other',             'Other',                           'أخرى',                  70)
) AS v(code, label_en, label_ar, ord)
ON CONFLICT ("tenant_id", "code") DO NOTHING;

ALTER TABLE "lost_reasons" FORCE ROW LEVEL SECURITY;
