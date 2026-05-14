-- Sprint 3 (D7.1) — Stage-Based Approval, Handoff & Rejection Flow.
--
-- Introduces `lead_transition_requests` — the first-class entity for
-- "agent wants to move a lead through a stage, but approval is
-- required". The Sprint 2.1 Add Action → Lifecycle drawer creates
-- one of these rows instead of calling moveStage directly whenever
-- the selected status' Smart Status Rule has `requiresApproval: true`
-- (the rule already exists in `pipeline_stages.allowed_statuses`).
--
-- Lifecycle states:
--   pending  → agent submitted, awaiting approver decision.
--   approved → approver said yes; the engine then applied the
--              requested stage / status / handoff in one tx and
--              flipped the row to `approved`. Terminal.
--   rejected → approver said no with a reason; the lead stayed in
--              its original stage / team / owner. Terminal.
--   cancelled→ requester withdrew the request before a decision.
--              Terminal.
--
-- Why a dedicated table instead of reusing `lead_reviews` (D3.6):
--   - LeadReview is the SLA-breach / rotation review queue; its
--     shape ({reason, reasonPayload, assignedTl, resolution})
--     doesn't carry from/to-stage, requested status, requester,
--     decision reason, corrective next-action, or handoff rule.
--   - Re-purposing it would muddy two distinct workflows. We keep
--     them separate; both can surface in TL dashboards (Sprint 5).
--
-- Approver fields are SNAPSHOTTED at request time so a later admin
-- edit to the stage's Smart Status Rule doesn't retroactively
-- change who can approve an in-flight request.
--
-- All writes route through the service so RLS + capability gates
-- (lead.transition.request, lead.transition.approve) are enforced
-- consistently. The capabilities are seeded by this migration so
-- the RBAC role editor sees them immediately; existing roles get
-- the request capability bundled with `lead.write`-ish surfaces
-- via the seed runner (no role-permission writes here — that's a
-- code-level seed concern, not a schema concern).

-- ─────────────────────────────────────────────────────────────
--  Capabilities (idempotent — only insert when missing)
-- ─────────────────────────────────────────────────────────────

INSERT INTO "capabilities" (id, code, description)
VALUES
  ('cba60001-0000-0000-0000-d7a000000001'::uuid,
   'lead.transition.request',
   'Submit a stage-transition request that requires approval (Sprint 3)'),
  ('cba60001-0000-0000-0000-d7a000000002'::uuid,
   'lead.transition.approve',
   'Approve or reject pending lead stage-transition requests (Sprint 3)')
ON CONFLICT (code) DO NOTHING;

-- ─────────────────────────────────────────────────────────────
--  lead_transition_requests
-- ─────────────────────────────────────────────────────────────

CREATE TABLE "lead_transition_requests" (
  "id"                      UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"               UUID         NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "lead_id"                 UUID         NOT NULL REFERENCES "leads"("id") ON DELETE CASCADE,

  -- Stage diff (both required; same-stage transitions are
  -- allowed when only the status changes + approval is needed).
  "from_stage_id"           UUID         NOT NULL REFERENCES "pipeline_stages"("id") ON DELETE RESTRICT,
  "to_stage_id"             UUID         NOT NULL REFERENCES "pipeline_stages"("id") ON DELETE RESTRICT,

  -- Status the requester wants applied AFTER the move. Free string
  -- (validated against `to_stage`.`allowed_statuses` at apply time).
  -- NULL when the request is move-only (no status change).
  "requested_status_code"   TEXT         NULL,

  -- Smart-rule context snapshot. Persisted so a later admin edit
  -- to allowed_statuses doesn't retroactively change what was
  -- requested. JSONB carries the full picked entry verbatim.
  "rule_snapshot"           JSONB        NULL,

  -- Submission metadata.
  "communication_method"    TEXT         NULL,
  "notes"                   TEXT         NULL,

  -- Smart-rule reason capture (Sprint 3.D). NULL when the rule
  -- didn't ask for a reason. `reason_code` is free-string at the
  -- column level (typically a LostReason.id or a free reason
  -- string when no catalogue covers the rule's reasonGroup).
  "reason_code"             TEXT         NULL,
  "reason_text"             TEXT         NULL,

  "requested_by_id"         UUID         NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,

  -- Resolved approver + handoff (snapshotted from the rule at
  -- request time).
  "approver_kind"           TEXT         NOT NULL,    -- 'current_team_leader' | 'target_team_leader' | 'admin' | 'role:<code>'
  "approver_role_code"      TEXT         NULL,        -- when approver_kind starts with 'role:'
  "handoff_rule"            TEXT         NULL,        -- 'target_team_queue' | 'target_team_leader' | 'auto_rotation' | 'specific_owner' | NULL
  "handoff_target_user_id"  UUID         NULL REFERENCES "users"("id") ON DELETE SET NULL,
  "handoff_target_team_id"  UUID         NULL REFERENCES "teams"("id") ON DELETE SET NULL,

  -- State machine.
  "state"                   TEXT         NOT NULL DEFAULT 'pending',
  "decided_at"              TIMESTAMPTZ(6) NULL,
  "decided_by_id"           UUID         NULL REFERENCES "users"("id") ON DELETE SET NULL,
  "decision_reason"         TEXT         NULL,

  -- Sprint 3.E — corrective next action created when the request
  -- is rejected. Soft FK; the follow-up survives the rejection
  -- being archived later.
  "corrective_followup_id"  UUID         NULL REFERENCES "lead_followups"("id") ON DELETE SET NULL,

  "created_at"              TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"              TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

-- State machine guardrail — keep PG honest in case the service
-- ever ships a regression.
ALTER TABLE "lead_transition_requests"
  ADD CONSTRAINT "ltr_state_check"
  CHECK ("state" IN ('pending', 'approved', 'rejected', 'cancelled'));

-- A lead can have AT MOST ONE pending transition request at a time.
-- Approving / rejecting / cancelling clears the row from `pending`,
-- so a new one becomes acceptable immediately afterward.
CREATE UNIQUE INDEX "ltr_one_pending_per_lead"
  ON "lead_transition_requests" ("tenant_id", "lead_id")
  WHERE "state" = 'pending';

-- Lead history view (the Lead Detail panel and audit chips need it).
CREATE INDEX "ltr_lead_history"
  ON "lead_transition_requests" ("tenant_id", "lead_id", "created_at" DESC);

-- Approver queue — "open requests assigned to me / my team", used
-- by Sprint 5 TL dashboards.
CREATE INDEX "ltr_approver_queue"
  ON "lead_transition_requests" ("tenant_id", "state", "approver_kind", "handoff_target_team_id");

-- RLS — every lead-scoped row in the system is tenant-isolated by
-- the policy below. Reuses `current_tenant_id()` (the same helper
-- the rest of the schema uses).
ALTER TABLE "lead_transition_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "lead_transition_requests" FORCE ROW LEVEL SECURITY;
CREATE POLICY "lead_transition_requests_tenant_isolation"
  ON "lead_transition_requests"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());
