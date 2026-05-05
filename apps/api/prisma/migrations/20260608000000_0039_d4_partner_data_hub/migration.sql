-- Phase D4 — D4.1: Partner Data Hub schema foundation.
--
-- ARCHITECTURE NOTE:
-- D4 connects CRM leads / captains with external partner data
-- sources (Uber, inDrive, DiDi, …). Partner sheets are external
-- systems of record used to verify CRM claims (Active / DFT dates,
-- trip counts, milestone progress) — they are NOT a replacement for
-- CRM truth. D4.1 ships the schema seam every later D4.x chunk
-- needs:
--
--   D4.2 — partner-source + mapping admin
--   D4.3 — sync engine + Google Sheets adapter + scheduler
--   D4.4 — verification projection + lead-detail PartnerData card
--   D4.5 — controlled merge + approval evidence
--   D4.6 — reconciliation reports + queue extension
--   D4.7 — milestone progress + commission CSV + final polish
--
-- This migration is purely additive:
--   - new tables:
--       partner_sources           — registry of external partner feeds
--       partner_field_mappings    — column-name → CRM-field mapping
--       partner_snapshots         — one row per sync run (append-only)
--       partner_records           — one row per source row in a snapshot
--       lead_evidence             — approval evidence anchor
--       partner_milestone_configs — commission-window milestone config
--   - new columns:
--       captains.dft_at                       — typed DFT timestamp
--       leads.partner_verification_cache      — denormalised cache
--                                               for hot-path list views
-- NO existing column or index is dropped or renamed. NO row mutation.
-- Every runtime path is unchanged under D4_PARTNER_HUB_V1=false.
--
-- Trip-count clarification:
-- Partner aggregate trip_count is stored on `partner_records` only.
-- It is NEVER written to `captain_trips` (which keeps its
-- per-trip-row, stable-tripId contract from P2-09). Milestone
-- progress derives from `partner_records.trip_count`. The
-- `captains.trip_count` column remains the authoritative count
-- driven by the CaptainTrip ledger.
--
-- Credentials clarification:
-- `partner_sources.encrypted_credentials` stores cipher only — the
-- envelope format is decided by the service layer in D4.2 (a key
-- ref + iv + ciphertext + tag JSON, encrypted with a server-side
-- KEK). No plaintext credentials ever cross the API boundary; the
-- response DTOs surface only `{ hasCredentials, lastTestedAt,
-- connectionStatus }`. D4.1 only reserves the column.

-- ─── 1. partner_sources — registry ─────────────────────────────────

CREATE TABLE "partner_sources" (
    "id"                      UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    "tenant_id"               UUID            NOT NULL,
    "company_id"              UUID            NULL,
    "country_id"              UUID            NULL,
    -- e.g. 'uber', 'indrive', 'didi', 'other'. Open string so a new
    -- partner can be added without a schema change.
    "partner_code"            TEXT            NOT NULL,
    "display_name"            TEXT            NOT NULL,
    -- e.g. 'google_sheets', 'manual_upload'. Picks the adapter at
    -- sync time. Open string for forward compatibility.
    "adapter"                 TEXT            NOT NULL,
    -- 'manual' | 'cron'. Manual sources only run on explicit
    -- /partner-sources/:id/sync invocations.
    "schedule_kind"           TEXT            NOT NULL DEFAULT 'manual',
    -- Standard 5-field crontab. NULL when schedule_kind='manual'.
    "cron_spec"               TEXT            NULL,
    -- 'fixed' | 'new_per_period'. Fixed-tab sources (Uber pattern)
    -- read the same tab on every sync; new-per-period sources
    -- (inDrive pattern) discover the latest tab via
    -- `tab_discovery_rule`.
    "tab_mode"                TEXT            NOT NULL DEFAULT 'fixed',
    "fixed_tab_name"          TEXT            NULL,
    -- JSON shape (D4.3 will validate):
    --   { "kind": "name_pattern", "pattern": "Activations YYYY-MM-DD" }
    --   { "kind": "most_recently_modified" }
    "tab_discovery_rule"      JSONB           NULL,
    -- Cipher only (envelope format decided in D4.2). NEVER returned
    -- in API responses; only `has_credentials` / `last_tested_at` /
    -- `connection_status` are exposed downstream.
    "encrypted_credentials"   TEXT            NULL,
    "has_credentials"         BOOLEAN         NOT NULL DEFAULT FALSE,
    "last_tested_at"          TIMESTAMPTZ(6)  NULL,
    -- Free-form status set by the "Test connection" path: 'ok' /
    -- 'auth_failed' / 'sheet_not_found' / 'unknown'. UI maps to
    -- friendly copy.
    "connection_status"       TEXT            NULL,
    "last_sync_at"            TIMESTAMPTZ(6)  NULL,
    -- 'success' / 'partial' / 'failed' / 'running'. The active
    -- sync run also appears in `partner_snapshots`; this column
    -- is the fast read for the admin source list.
    "last_sync_status"        TEXT            NULL,
    "is_active"               BOOLEAN         NOT NULL DEFAULT TRUE,
    "created_at"              TIMESTAMPTZ(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"              TIMESTAMPTZ(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_sources_tenant_id_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id")
        ON DELETE CASCADE ON UPDATE CASCADE,
    -- Restrict on company / country deletes — a partner source
    -- pinned to a (company, country) loses its scope if those
    -- rows go away. Operator must reassign first.
    CONSTRAINT "partner_sources_company_id_fkey"
        FOREIGN KEY ("company_id") REFERENCES "companies" ("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "partner_sources_country_id_fkey"
        FOREIGN KEY ("country_id") REFERENCES "countries" ("id")
        ON DELETE RESTRICT ON UPDATE CASCADE
);

-- Hot-path indexes:
--   • Admin list "partner sources for my (company, country) scope".
--   • Scheduler tick "find sources due for cron run".
--   • Per-tenant active sources for verification reads.
-- Multiple PartnerSource rows are intentionally allowed per
-- (tenant, partner_code, company_id, country_id) so an operator can
-- run "Uber EG — daily" + "Uber EG — backup" side-by-side. D4.4's
-- verification projection picks the most-recently-synced source
-- when ambiguous.
CREATE INDEX "partner_sources_tenant_id_company_id_country_id_idx"
  ON "partner_sources" ("tenant_id", "company_id", "country_id");
CREATE INDEX "partner_sources_tenant_id_partner_code_is_active_idx"
  ON "partner_sources" ("tenant_id", "partner_code", "is_active");
CREATE INDEX "partner_sources_tenant_id_is_active_schedule_kind_idx"
  ON "partner_sources" ("tenant_id", "is_active", "schedule_kind");

ALTER TABLE "partner_sources" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "partner_sources" FORCE ROW LEVEL SECURITY;
CREATE POLICY "partner_sources_tenant_isolation"
  ON "partner_sources"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

-- ─── 2. partner_field_mappings — column-name → CRM-field ───────────

CREATE TABLE "partner_field_mappings" (
    "id"                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    "tenant_id"           UUID            NOT NULL,
    "partner_source_id"   UUID            NOT NULL,
    -- Verbatim column name from the partner sheet.
    "source_column"       TEXT            NOT NULL,
    -- Closed enum at the service layer (D4.2 validates):
    --   'phone' | 'name' | 'partner_status' | 'partner_active_date'
    --   | 'partner_dft_date' | 'trip_count' | 'last_trip_at'.
    -- Stored as TEXT so a future field doesn't need a migration.
    "target_field"        TEXT            NOT NULL,
    -- Optional transform applied on snapshot write. NULL =
    -- passthrough. Valid values (D4.2): 'parse_date' / 'to_e164' /
    -- 'lowercase' / 'passthrough'.
    "transform_kind"      TEXT            NULL,
    "transform_args"      JSONB           NULL,
    "is_required"         BOOLEAN         NOT NULL DEFAULT FALSE,
    "display_order"       INTEGER         NOT NULL DEFAULT 0,
    "created_at"          TIMESTAMPTZ(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"          TIMESTAMPTZ(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_field_mappings_tenant_id_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id")
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "partner_field_mappings_partner_source_id_fkey"
        FOREIGN KEY ("partner_source_id") REFERENCES "partner_sources" ("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);

-- Each CRM target field can only be mapped from one source column
-- per partner source. A future re-mapping replaces the row.
CREATE UNIQUE INDEX "partner_field_mappings_partner_source_id_target_field_key"
  ON "partner_field_mappings" ("partner_source_id", "target_field");
CREATE INDEX "partner_field_mappings_tenant_id_partner_source_id_idx"
  ON "partner_field_mappings" ("tenant_id", "partner_source_id");

ALTER TABLE "partner_field_mappings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "partner_field_mappings" FORCE ROW LEVEL SECURITY;
CREATE POLICY "partner_field_mappings_tenant_isolation"
  ON "partner_field_mappings"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

-- ─── 3. partner_snapshots — one row per sync run ───────────────────

CREATE TABLE "partner_snapshots" (
    "id"                    UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    "tenant_id"             UUID            NOT NULL,
    "partner_source_id"     UUID            NOT NULL,
    "started_at"            TIMESTAMPTZ(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at"          TIMESTAMPTZ(6)  NULL,
    -- 'running' | 'success' | 'partial' | 'failed'.
    "status"                TEXT            NOT NULL DEFAULT 'running',
    "rows_total"            INTEGER         NOT NULL DEFAULT 0,
    "rows_imported"         INTEGER         NOT NULL DEFAULT 0,
    "rows_skipped"          INTEGER         NOT NULL DEFAULT 0,
    "rows_error"            INTEGER         NOT NULL DEFAULT 0,
    -- Adapter-supplied metadata (resolved tab name, run id,
    -- trigger reason, etc.). Kept opaque at the schema layer.
    "source_metadata"       JSONB           NULL,
    "triggered_by_user_id"  UUID            NULL,
    "created_at"            TIMESTAMPTZ(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_snapshots_tenant_id_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id")
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "partner_snapshots_partner_source_id_fkey"
        FOREIGN KEY ("partner_source_id") REFERENCES "partner_sources" ("id")
        ON DELETE CASCADE ON UPDATE CASCADE,
    -- SetNull so disabling / removing the user who triggered the
    -- sync never destroys the snapshot history. Same pattern as
    -- DuplicateDecisionLog.actor_user_id and LeadRotationLog.
    CONSTRAINT "partner_snapshots_triggered_by_user_id_fkey"
        FOREIGN KEY ("triggered_by_user_id") REFERENCES "users" ("id")
        ON DELETE SET NULL ON UPDATE CASCADE
);

-- Hot-path index: "newest snapshot per source" — verification
-- projection picks the most recent successful snapshot.
CREATE INDEX "partner_snapshots_tenant_id_partner_source_id_started_at_idx"
  ON "partner_snapshots" ("tenant_id", "partner_source_id", "started_at" DESC);
CREATE INDEX "partner_snapshots_tenant_id_status_idx"
  ON "partner_snapshots" ("tenant_id", "status");

ALTER TABLE "partner_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "partner_snapshots" FORCE ROW LEVEL SECURITY;
CREATE POLICY "partner_snapshots_tenant_isolation"
  ON "partner_snapshots"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

-- ─── 4. partner_records — per-row payload (append-only) ────────────

CREATE TABLE "partner_records" (
    "id"                    UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    "tenant_id"             UUID            NOT NULL,
    "snapshot_id"           UUID            NOT NULL,
    "partner_source_id"     UUID            NOT NULL,
    -- Resolved at write-time when the snapshot row's phone matches
    -- a Contact in the same tenant. NULL on miss; D4.4 verification
    -- projection joins on (partner_source_id, phone) so a missing
    -- contact never blocks the snapshot row from landing.
    "contact_id"            UUID            NULL,
    -- E.164-normalised. The single canonical join key for D4.
    -- NULL only when the source row had no parseable phone — those
    -- rows still land for `raw_row` audit but never appear in
    -- verification queries.
    "phone"                 TEXT            NULL,
    "partner_status"        TEXT            NULL,
    "partner_active_date"   TIMESTAMPTZ(6)  NULL,
    "partner_dft_date"      TIMESTAMPTZ(6)  NULL,
    "trip_count"            INTEGER         NULL,
    "last_trip_at"          TIMESTAMPTZ(6)  NULL,
    -- Verbatim copy of the source row (every column, mapped or not).
    -- Forensic floor: a future re-mapping reprocesses historical
    -- snapshots without re-fetching from the partner.
    "raw_row"               JSONB           NOT NULL,
    "created_at"            TIMESTAMPTZ(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_records_tenant_id_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id")
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "partner_records_snapshot_id_fkey"
        FOREIGN KEY ("snapshot_id") REFERENCES "partner_snapshots" ("id")
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "partner_records_partner_source_id_fkey"
        FOREIGN KEY ("partner_source_id") REFERENCES "partner_sources" ("id")
        ON DELETE CASCADE ON UPDATE CASCADE,
    -- SetNull so cleaning a contact never destroys partner audit.
    CONSTRAINT "partner_records_contact_id_fkey"
        FOREIGN KEY ("contact_id") REFERENCES "contacts" ("id")
        ON DELETE SET NULL ON UPDATE CASCADE
);

-- Hot-path indexes:
--   • Verification projection: "latest record for (source, phone)".
--   • Snapshot drill-down: "all rows in snapshot X".
--   • Reconciliation: "records with partner_status=active for source".
CREATE INDEX "partner_records_tenant_id_partner_source_id_phone_idx"
  ON "partner_records" ("tenant_id", "partner_source_id", "phone");
CREATE INDEX "partner_records_tenant_id_snapshot_id_idx"
  ON "partner_records" ("tenant_id", "snapshot_id");
CREATE INDEX "partner_records_tenant_id_contact_id_idx"
  ON "partner_records" ("tenant_id", "contact_id");
CREATE INDEX "partner_records_tenant_id_partner_source_id_partner_status_idx"
  ON "partner_records" ("tenant_id", "partner_source_id", "partner_status");

ALTER TABLE "partner_records" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "partner_records" FORCE ROW LEVEL SECURITY;
CREATE POLICY "partner_records_tenant_isolation"
  ON "partner_records"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

-- ─── 5. lead_evidence — approval evidence anchor ───────────────────

CREATE TABLE "lead_evidence" (
    "id"                    UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    "tenant_id"             UUID            NOT NULL,
    "lead_id"               UUID            NOT NULL,
    -- 'partner_screenshot' | 'partner_record' | 'note'.
    "kind"                  TEXT            NOT NULL,
    "partner_record_id"     UUID            NULL,
    "partner_snapshot_id"   UUID            NULL,
    -- Storage-ref pattern from CaptainDocument (P2-09): bytes live
    -- in the operator's S3/GCS, only metadata lives here.
    "storage_ref"           TEXT            NULL,
    "file_name"             TEXT            NULL,
    "mime_type"             TEXT            NULL,
    "size_bytes"            INTEGER         NULL,
    "notes"                 TEXT            NULL,
    "captured_by_user_id"   UUID            NULL,
    "created_at"            TIMESTAMPTZ(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_evidence_tenant_id_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id")
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "lead_evidence_lead_id_fkey"
        FOREIGN KEY ("lead_id") REFERENCES "leads" ("id")
        ON DELETE CASCADE ON UPDATE CASCADE,
    -- SetNull on the snapshot/record FKs so a future archive of
    -- old snapshots doesn't cascade-delete the lead's evidence
    -- chain. The evidence row keeps its `kind` + `notes` + file
    -- pointer even if the partner row is no longer queryable.
    CONSTRAINT "lead_evidence_partner_record_id_fkey"
        FOREIGN KEY ("partner_record_id") REFERENCES "partner_records" ("id")
        ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "lead_evidence_partner_snapshot_id_fkey"
        FOREIGN KEY ("partner_snapshot_id") REFERENCES "partner_snapshots" ("id")
        ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "lead_evidence_captured_by_user_id_fkey"
        FOREIGN KEY ("captured_by_user_id") REFERENCES "users" ("id")
        ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "lead_evidence_tenant_id_lead_id_created_at_idx"
  ON "lead_evidence" ("tenant_id", "lead_id", "created_at" DESC);
CREATE INDEX "lead_evidence_tenant_id_partner_record_id_idx"
  ON "lead_evidence" ("tenant_id", "partner_record_id");

ALTER TABLE "lead_evidence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "lead_evidence" FORCE ROW LEVEL SECURITY;
CREATE POLICY "lead_evidence_tenant_isolation"
  ON "lead_evidence"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

-- ─── 6. partner_milestone_configs — commission-window milestones ───

CREATE TABLE "partner_milestone_configs" (
    "id"                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    "tenant_id"           UUID            NOT NULL,
    "partner_source_id"   UUID            NOT NULL,
    -- Stable per-source code (e.g. 'commission_50_30'). UNIQUE
    -- with partner_source_id so an admin can swap configs without
    -- losing the code.
    "code"                TEXT            NOT NULL,
    "display_name"        TEXT            NOT NULL,
    "window_days"         INTEGER         NOT NULL,
    -- INT array kept as JSONB for portability with Prisma; D4.7
    -- validates the shape (`number[]`, ascending, deduped).
    "milestone_steps"     JSONB           NOT NULL,
    -- 'partner_active_date' | 'partner_dft_date' | 'first_seen_in_partner'.
    "anchor"              TEXT            NOT NULL,
    -- Optional fraction-of-window-remaining thresholds for the
    -- risk badge, e.g. { "high": 0.30, "medium": 0.60 }.
    "risk_thresholds"     JSONB           NULL,
    "is_active"           BOOLEAN         NOT NULL DEFAULT TRUE,
    "created_at"          TIMESTAMPTZ(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"          TIMESTAMPTZ(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_milestone_configs_tenant_id_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id")
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "partner_milestone_configs_partner_source_id_fkey"
        FOREIGN KEY ("partner_source_id") REFERENCES "partner_sources" ("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "partner_milestone_configs_partner_source_id_code_key"
  ON "partner_milestone_configs" ("partner_source_id", "code");
CREATE INDEX "partner_milestone_configs_tenant_id_partner_source_id_is_active_idx"
  ON "partner_milestone_configs" ("tenant_id", "partner_source_id", "is_active");

ALTER TABLE "partner_milestone_configs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "partner_milestone_configs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "partner_milestone_configs_tenant_isolation"
  ON "partner_milestone_configs"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());

-- ─── 7. captains.dft_at — typed DFT timestamp ──────────────────────
--
-- DFT (Date of First Trip) is a first-class operational and
-- commission/reporting field. Adding it as a typed column rather
-- than a JSONB scrap means D4.5 controlled-merge writes land in
-- a queryable place and D4.7 milestone reports never need a JSON
-- scan. Partner DFT date NEVER auto-overwrites this column —
-- writes flow exclusively through the controlled-merge approval
-- path in D4.5.

ALTER TABLE "captains"
  ADD COLUMN "dft_at" TIMESTAMPTZ(6) NULL;

CREATE INDEX "captains_tenant_id_dft_at_idx"
  ON "captains" ("tenant_id", "dft_at");

-- ─── 8. leads.partner_verification_cache — denormalised hot path ───
--
-- D4.4 verification projection writes here on every relevant sync
-- so the lead-list partner column query is one row instead of N
-- joins. NULL until the contact has at least one matching partner
-- record. Shape (D4.4 will validate):
--   {
--     "<partnerSourceId>": {
--       "found": true,
--       "partnerStatus": "active",
--       "partnerActiveDate": "2026-04-01",
--       "partnerDftDate": "2026-04-03",
--       "tripCount": 12,
--       "lastTripAt": "2026-05-01T10:00:00Z",
--       "lastSyncAt": "2026-05-04T11:00:00Z"
--     }
--   }
--
-- D4.1 only reserves the column. D4.4 owns the writer.

ALTER TABLE "leads"
  ADD COLUMN "partner_verification_cache" JSONB NULL;
