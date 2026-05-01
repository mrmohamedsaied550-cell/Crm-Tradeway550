-- P2-09 — Captain documents + trip telemetry.
--
-- Three changes:
--   1. New `captain_documents` table (metadata + review trail).
--   2. New `captain_trips` ledger (idempotent on (captain_id, trip_id)).
--   3. Two columns on `captains`: first_trip_at, trip_count.
--
-- Both new tables get FORCE'd RLS. The captain ALTER stays
-- non-RLS-dependent (column adds bypass policies).

-- ─── 1. captain_documents ────────────────────────────────────────
CREATE TABLE "captain_documents" (
    "id"                UUID NOT NULL,
    "tenant_id"         UUID NOT NULL,
    "captain_id"        UUID NOT NULL,
    "kind"              TEXT NOT NULL,
    "storage_ref"       TEXT NOT NULL,
    "file_name"         TEXT NOT NULL,
    "mime_type"         TEXT NOT NULL,
    "size_bytes"        INTEGER NOT NULL,
    "status"            TEXT NOT NULL DEFAULT 'pending',
    "expires_at"        TIMESTAMPTZ(6),
    "reviewer_user_id"  UUID,
    "reviewed_at"       TIMESTAMPTZ(6),
    "review_notes"      TEXT,
    "uploaded_by_id"    UUID,
    "created_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"        TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "captain_documents_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "captain_documents_tenant_id_captain_id_status_idx"
  ON "captain_documents"("tenant_id", "captain_id", "status");
CREATE INDEX "captain_documents_tenant_id_status_expires_at_idx"
  ON "captain_documents"("tenant_id", "status", "expires_at");

ALTER TABLE "captain_documents"
  ADD CONSTRAINT "captain_documents_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "captain_documents"
  ADD CONSTRAINT "captain_documents_captain_id_fkey"
  FOREIGN KEY ("captain_id") REFERENCES "captains"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "captain_documents"
  ADD CONSTRAINT "captain_documents_reviewer_user_id_fkey"
  FOREIGN KEY ("reviewer_user_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "captain_documents"
  ADD CONSTRAINT "captain_documents_uploaded_by_id_fkey"
  FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "captain_documents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "captain_documents" FORCE  ROW LEVEL SECURITY;
CREATE POLICY "captain_documents_tenant_isolation" ON "captain_documents"
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- ─── 2. captain_trips ────────────────────────────────────────────
CREATE TABLE "captain_trips" (
    "id"          UUID NOT NULL,
    "tenant_id"   UUID NOT NULL,
    "captain_id"  UUID NOT NULL,
    "trip_id"     TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "payload"     JSONB,
    "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "captain_trips_pkey" PRIMARY KEY ("id")
);

-- Unique (captain_id, trip_id) gives idempotency on the ingest
-- endpoint. Re-delivering the same trip from the operator (network
-- retry, replay) is a no-op.
CREATE UNIQUE INDEX "captain_trips_captain_id_trip_id_key"
  ON "captain_trips"("captain_id", "trip_id");
CREATE INDEX "captain_trips_tenant_id_captain_id_occurred_at_idx"
  ON "captain_trips"("tenant_id", "captain_id", "occurred_at");

ALTER TABLE "captain_trips"
  ADD CONSTRAINT "captain_trips_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "captain_trips"
  ADD CONSTRAINT "captain_trips_captain_id_fkey"
  FOREIGN KEY ("captain_id") REFERENCES "captains"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "captain_trips" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "captain_trips" FORCE  ROW LEVEL SECURITY;
CREATE POLICY "captain_trips_tenant_isolation" ON "captain_trips"
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- ─── 3. captains.first_trip_at + trip_count ──────────────────────
ALTER TABLE "captains" ADD COLUMN "first_trip_at" TIMESTAMPTZ(6);
ALTER TABLE "captains" ADD COLUMN "trip_count" INTEGER NOT NULL DEFAULT 0;
CREATE INDEX "captains_tenant_id_first_trip_at_idx"
  ON "captains"("tenant_id", "first_trip_at");
