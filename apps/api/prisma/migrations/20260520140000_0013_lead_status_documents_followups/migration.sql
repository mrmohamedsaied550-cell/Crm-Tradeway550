-- 0013 — Lead Statuses, Documents, and Follow-ups.
--
-- Adds three new tenant-scoped tables:
--   1. lead_statuses — substatus definitions per pipeline stage
--   2. lead_documents — document checklist items per lead
--   3. lead_follow_ups — scheduled follow-up reminders per lead
--
-- Also adds a nullable `status_id` FK on `leads` pointing to `lead_statuses`.

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. lead_statuses — substatus definitions per stage
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE "lead_statuses" (
  "id"         UUID        NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"  UUID        NOT NULL,
  "stage_id"   UUID        NOT NULL,
  "code"       VARCHAR(60) NOT NULL,
  "name"       VARCHAR(120) NOT NULL,
  "color"      VARCHAR(30) DEFAULT 'gray',
  "order"      INT         NOT NULL DEFAULT 0,
  "is_default" BOOLEAN     NOT NULL DEFAULT false,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "lead_statuses_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "lead_statuses_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "lead_statuses_stage_id_fkey"
    FOREIGN KEY ("stage_id") REFERENCES "pipeline_stages"("id") ON DELETE CASCADE
);

-- Each stage can only have one status with a given code per tenant.
CREATE UNIQUE INDEX "lead_statuses_tenant_stage_code_unique"
  ON "lead_statuses"("tenant_id", "stage_id", "code");
CREATE INDEX "lead_statuses_tenant_id_stage_id_idx"
  ON "lead_statuses"("tenant_id", "stage_id", "order");

-- RLS
ALTER TABLE "lead_statuses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "lead_statuses" FORCE  ROW LEVEL SECURITY;
CREATE POLICY "lead_statuses_tenant_isolation" ON "lead_statuses"
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. Add status_id to leads
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE "leads" ADD COLUMN "status_id" UUID;
ALTER TABLE "leads"
  ADD CONSTRAINT "leads_status_id_fkey"
  FOREIGN KEY ("status_id") REFERENCES "lead_statuses"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "leads_tenant_id_status_id_idx"
  ON "leads"("tenant_id", "status_id");

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. lead_documents — document checklist per lead
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE "lead_documents" (
  "id"          UUID        NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"   UUID        NOT NULL,
  "lead_id"     UUID        NOT NULL,
  "type"        VARCHAR(60) NOT NULL,
  "label"       VARCHAR(120) NOT NULL,
  "status"      VARCHAR(30) NOT NULL DEFAULT 'pending',
  "file_url"    TEXT,
  "notes"       TEXT,
  "reviewed_by" UUID,
  "reviewed_at" TIMESTAMPTZ(6),
  "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "lead_documents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "lead_documents_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "lead_documents_lead_id_fkey"
    FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE,
  CONSTRAINT "lead_documents_reviewed_by_fkey"
    FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE SET NULL
);

CREATE INDEX "lead_documents_tenant_id_lead_id_idx"
  ON "lead_documents"("tenant_id", "lead_id");
CREATE INDEX "lead_documents_tenant_id_status_idx"
  ON "lead_documents"("tenant_id", "status");

-- RLS
ALTER TABLE "lead_documents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "lead_documents" FORCE  ROW LEVEL SECURITY;
CREATE POLICY "lead_documents_tenant_isolation" ON "lead_documents"
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. lead_follow_ups — scheduled follow-up reminders
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE "lead_follow_ups" (
  "id"           UUID        NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"    UUID        NOT NULL,
  "lead_id"      UUID        NOT NULL,
  "scheduled_at" TIMESTAMPTZ(6) NOT NULL,
  "method"       VARCHAR(30) NOT NULL DEFAULT 'call',
  "note"         TEXT,
  "status"       VARCHAR(30) NOT NULL DEFAULT 'pending',
  "completed_at" TIMESTAMPTZ(6),
  "completed_by" UUID,
  "created_by"   UUID,
  "created_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "lead_follow_ups_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "lead_follow_ups_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "lead_follow_ups_lead_id_fkey"
    FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE,
  CONSTRAINT "lead_follow_ups_completed_by_fkey"
    FOREIGN KEY ("completed_by") REFERENCES "users"("id") ON DELETE SET NULL,
  CONSTRAINT "lead_follow_ups_created_by_fkey"
    FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL
);

CREATE INDEX "lead_follow_ups_tenant_id_lead_id_idx"
  ON "lead_follow_ups"("tenant_id", "lead_id");
CREATE INDEX "lead_follow_ups_tenant_id_status_scheduled_idx"
  ON "lead_follow_ups"("tenant_id", "status", "scheduled_at");

-- RLS
ALTER TABLE "lead_follow_ups" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "lead_follow_ups" FORCE  ROW LEVEL SECURITY;
CREATE POLICY "lead_follow_ups_tenant_isolation" ON "lead_follow_ups"
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
