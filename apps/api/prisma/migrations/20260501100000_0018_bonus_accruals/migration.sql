-- P2-03 — bonus accruals.
--
-- One row per fired bonus rule. The unique on
-- (bonus_rule_id, captain_id, trigger_kind) gives engine idempotency:
-- re-running `BonusEngine.onActivation` for the same captain never
-- produces duplicate accruals.
--
-- Tenant-isolated via FORCE'd RLS, same pattern as the rest of the CRM.

CREATE TABLE "bonus_accruals" (
    "id"                 UUID NOT NULL,
    "tenant_id"          UUID NOT NULL,
    "bonus_rule_id"      UUID NOT NULL,
    "recipient_user_id"  UUID NOT NULL,
    "captain_id"         UUID,
    "trigger_kind"       TEXT NOT NULL,
    "amount"             DECIMAL(12,2) NOT NULL,
    "status"             TEXT NOT NULL DEFAULT 'pending',
    "payload"            JSONB,
    "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"         TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "bonus_accruals_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "bonus_accruals_tenant_id_recipient_user_id_status_created_at_idx"
  ON "bonus_accruals"("tenant_id", "recipient_user_id", "status", "created_at");
CREATE INDEX "bonus_accruals_tenant_id_status_created_at_idx"
  ON "bonus_accruals"("tenant_id", "status", "created_at");
CREATE UNIQUE INDEX "bonus_accruals_bonus_rule_id_captain_id_trigger_kind_key"
  ON "bonus_accruals"("bonus_rule_id", "captain_id", "trigger_kind");

ALTER TABLE "bonus_accruals"
  ADD CONSTRAINT "bonus_accruals_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bonus_accruals"
  ADD CONSTRAINT "bonus_accruals_bonus_rule_id_fkey"
  FOREIGN KEY ("bonus_rule_id") REFERENCES "bonus_rules"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bonus_accruals"
  ADD CONSTRAINT "bonus_accruals_recipient_user_id_fkey"
  FOREIGN KEY ("recipient_user_id") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bonus_accruals"
  ADD CONSTRAINT "bonus_accruals_captain_id_fkey"
  FOREIGN KEY ("captain_id") REFERENCES "captains"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "bonus_accruals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "bonus_accruals" FORCE  ROW LEVEL SECURITY;
CREATE POLICY "bonus_accruals_tenant_isolation" ON "bonus_accruals"
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
