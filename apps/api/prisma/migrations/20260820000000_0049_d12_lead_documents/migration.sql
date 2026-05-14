-- Sprint 12 (D12) — Lead-level document tracking.
--
-- Greenfield table; the captain-side analogue (captain_documents)
-- ships rows for converted captains. Lead-side rows close the
-- signup-stage paperwork gap so an operator can mark required
-- documents missing/uploaded/accepted/rejected/needs_resubmission
-- before the lead is converted.
--
-- Reversible: every column/index here is `DROP TABLE` reversible.
-- No constraints touch existing tables. Metadata-only on Sprint 12;
-- the storage backend (S3 / local bucket) lands in a follow-up.

CREATE TABLE "lead_documents" (
  "id"                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"           uuid        NOT NULL,
  "lead_id"             uuid        NOT NULL,
  "type"                text        NOT NULL,
  "label"               text,
  "status"              text        NOT NULL DEFAULT 'missing',
  "file_name"           text,
  "file_url"            text,
  "mime_type"           text,
  "size_bytes"          integer,
  "uploaded_by_id"      uuid,
  "reviewed_by_id"      uuid,
  "reviewed_at"         timestamptz,
  "rejection_reason"    text,
  "note"                text,
  "created_at"          timestamptz NOT NULL DEFAULT now(),
  "updated_at"          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT "lead_documents_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "lead_documents_lead_id_fkey"
    FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE,
  CONSTRAINT "lead_documents_uploaded_by_id_fkey"
    FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE SET NULL,
  CONSTRAINT "lead_documents_reviewed_by_id_fkey"
    FOREIGN KEY ("reviewed_by_id") REFERENCES "users"("id") ON DELETE SET NULL
);

-- Status allow-list. Keeps writes consistent even if a future
-- service path forgets to validate. Update this CHECK together
-- with any new status value the service introduces.
ALTER TABLE "lead_documents"
  ADD CONSTRAINT "lead_documents_status_check"
  CHECK ("status" IN ('missing', 'uploaded', 'accepted', 'rejected', 'needs_resubmission'));

-- Rejection-reason invariant: every rejected / needs_resubmission
-- row MUST carry a non-empty reason so the audit trail and the
-- operator UI never see an unexplained denial.
ALTER TABLE "lead_documents"
  ADD CONSTRAINT "lead_documents_reason_required_when_negative"
  CHECK (
    ("status" NOT IN ('rejected', 'needs_resubmission'))
    OR ("rejection_reason" IS NOT NULL AND length(trim("rejection_reason")) > 0)
  );

-- Reviewed-by invariant: when status flips to accepted / rejected /
-- needs_resubmission, we expect a reviewer + timestamp.
ALTER TABLE "lead_documents"
  ADD CONSTRAINT "lead_documents_reviewer_required_when_reviewed"
  CHECK (
    ("status" NOT IN ('accepted', 'rejected', 'needs_resubmission'))
    OR ("reviewed_by_id" IS NOT NULL AND "reviewed_at" IS NOT NULL)
  );

-- Documents panel queries the most-recent rows for a lead with the
-- chip statuses grouped — composite index covers both lookups.
CREATE INDEX "lead_documents_tenant_id_lead_id_idx"
  ON "lead_documents" ("tenant_id", "lead_id");
CREATE INDEX "lead_documents_tenant_id_lead_id_status_idx"
  ON "lead_documents" ("tenant_id", "lead_id", "status");
-- "All pending review" tenant-wide queue.
CREATE INDEX "lead_documents_tenant_id_status_idx"
  ON "lead_documents" ("tenant_id", "status");
-- "All driving-licence rows" — supports the Org-side reporting
-- queries we'll add later. Cheap.
CREATE INDEX "lead_documents_tenant_id_type_idx"
  ON "lead_documents" ("tenant_id", "type");
