-- Phase D3 — D3.5: SLA escalation policy storage (JSONB seam).
--
-- ARCHITECTURE NOTE:
-- D3.5 wires SLA-breach reassignment through `RotationService` (per
-- the D3.4 seam) AND adds the EscalationPolicyService that decides
-- per-threshold actions. The policy is per-tenant and stored as a
-- single JSONB column on `tenant_settings`. NULL = use the locked
-- product defaults (DEFAULT_ESCALATION_RULES).
--
-- D3.5 ships the column only — the EscalationPolicyService reads it,
-- the SLA scheduler honours the t150 repeat-window decision, but no
-- admin UI is added (that's D3.7 polish). Older tenant_settings
-- rows stay NULL on UPDATE; the service falls back to defaults
-- automatically.
--
-- Touches:
--   - tenant_settings + escalation_rules JSONB NULL
-- All other constraints, indexes, columns, RLS policies — UNCHANGED.

ALTER TABLE "tenant_settings"
  ADD COLUMN "escalation_rules" JSONB NULL;
