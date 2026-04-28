-- C11 — response-SLA tracking on leads.
--
-- New columns:
--   sla_due_at        nullable; when null = SLA paused (terminal stage)
--   sla_status        'active' | 'breached' | 'paused'
--   last_response_at  most recent agent-driven activity timestamp
--
-- The composite index covers the breach-scanner hot path:
--   SELECT id FROM leads
--   WHERE tenant_id = ? AND sla_status = 'active' AND sla_due_at < now();
--
-- No new RLS policy: leads already has tenant isolation from C10.

-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "last_response_at" TIMESTAMPTZ(6),
ADD COLUMN     "sla_due_at" TIMESTAMPTZ(6),
ADD COLUMN     "sla_status" TEXT NOT NULL DEFAULT 'active';

-- CreateIndex
CREATE INDEX "leads_tenant_id_sla_status_sla_due_at_idx" ON "leads"("tenant_id", "sla_status", "sla_due_at");
