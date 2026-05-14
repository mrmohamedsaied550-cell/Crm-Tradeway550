-- Sprint 16 (D16) — Lead Document private storage references.
--
-- Three nullable columns:
--   storage_key       opaque path inside the active provider; never exposed
--                     to the browser.
--   storage_provider  'local' (this sprint's dev disk provider); future
--                     's3' / 'gcs' / etc.
--   file_hash         SHA-256 of the uploaded bytes for integrity + dedupe.
--
-- All NULL on rows created by the Sprint 12 metadata-only flow; populated
-- once a real file is uploaded by Sprint 16. No defaults; no destructive
-- changes.

ALTER TABLE "lead_documents"
  ADD COLUMN "storage_key" TEXT,
  ADD COLUMN "storage_provider" TEXT,
  ADD COLUMN "file_hash" TEXT;
