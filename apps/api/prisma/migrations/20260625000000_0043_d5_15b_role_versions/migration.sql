-- Phase D5 — D5.15-B: role version history.
--
-- Adds an append-only `role_versions` table that captures a
-- structural snapshot of a role + a per-save change-summary every
-- time the role's capabilities, scopes, or field permissions
-- change. The runtime read path is the resolver (D5.1) — it does
-- NOT consult this table. The history is purely a governance
-- surface that powers:
--
--   • `GET /rbac/roles/:id/versions`             — admin History tab
--   • `GET /rbac/roles/:id/versions/:versionId`  — version detail
--   • `POST /rbac/roles/:id/versions/:versionId/revert` — typed-confirm revert
--
-- Revert flows back through the SAME D5.14 dependency-check +
-- D5.15-A change-preview chain — the database-level rule here is
-- only "snapshots are written by the same tx as the role write".
--
-- Storage is structural metadata only:
--   • snapshot       — JSONB { metadata, capabilities[], scopes[],
--                              fieldPermissions[] }. Capability codes,
--                      resource + field strings, scope strings only.
--                      No row VALUES.
--   • changeSummary  — JSONB { granted, revoked, fieldPermChanges,
--                              scopeChanges, riskFlags }. Mirrors
--                      the D5.15-A `RoleChangePreviewResult.changes`
--                      + `riskSummary` so the UI can render the diff
--                      without recomputation.
--
-- Idempotency: the migration is purely additive; an upgrade that
-- replays it on a fresh DB is identical to a fresh install. There
-- is no data backfill — version history starts at the first save
-- AFTER this migration runs.
--
-- RLS: tenant_id is denormalised on every row + a tenant-isolation
-- policy enforces the filter at the DB layer. The `FORCE ROW LEVEL
-- SECURITY` mirrors every other tenant-scoped table.

CREATE TABLE "role_versions" (
    "id"                UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    "tenant_id"         UUID            NOT NULL,
    "role_id"           UUID            NOT NULL,
    -- Monotonic version number per role. Computed by the service
    -- inside the same tx as the role write, so concurrent writes
    -- on the same role are serialised by the (role_id, version_number)
    -- unique constraint below.
    "version_number"    INTEGER         NOT NULL,
    -- The user who triggered the change. NULL for system actions
    -- (seed / migration backfill — not in scope today, but reserved).
    "actor_user_id"     UUID            NULL,
    -- Optional admin note for "why was this saved". Free text;
    -- never echoed into audit payloads. Trimmed at the service
    -- boundary (max 500 chars).
    "reason"            TEXT            NULL,
    -- One of: 'create' | 'update' | 'duplicate' | 'scopes' |
    -- 'field_permissions' | 'revert'. The discriminator that tells
    -- the History tab which write path produced the row, so it can
    -- render the right pill.
    "trigger_action"    TEXT            NOT NULL,
    -- Structural snapshot of the role POST-save. JSONB shape:
    --   {
    --     "metadata":         { "code", "nameEn", "nameAr", "level",
    --                           "description", "isSystem", "isActive" },
    --     "capabilities":     [ "<code>", ... ],
    --     "scopes":           [ { "resource", "scope" }, ... ],
    --     "fieldPermissions": [ { "resource", "field",
    --                             "canRead", "canWrite" }, ... ]
    --   }
    -- No row VALUES (lead phone numbers, customer names, etc.).
    -- Only structural identifiers admins set in the role builder.
    "snapshot"          JSONB           NOT NULL,
    -- Diff against the previous version (or against the empty
    -- baseline for the first version after a `create`). JSONB
    -- shape mirrors D5.15-A's `RoleChangePreviewResult.changes` +
    -- `riskSummary`:
    --   {
    --     "grantedCapabilities":      [...],
    --     "revokedCapabilities":      [...],
    --     "fieldPermissionChanges": {
    --       "readDeniedAdded":        [ { resource, field } ],
    --       "readDeniedRemoved":      [ { resource, field } ],
    --       "writeDeniedAdded":       [ { resource, field } ],
    --       "writeDeniedRemoved":     [ { resource, field } ]
    --     },
    --     "scopeChanges": {
    --       "changed":                [ { resource, from, to } ],
    --       "added":                  [ { resource, scope } ],
    --       "removed":                [ { resource, scope } ]
    --     },
    --     "riskFlags": { ... }
    --   }
    "change_summary"    JSONB           NOT NULL,
    "created_at"        TIMESTAMPTZ(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_versions_tenant_id_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id")
        ON DELETE CASCADE ON UPDATE CASCADE,
    -- Cascade-delete with the role itself: if a role is deleted, its
    -- history goes with it (the cascade matches role_capabilities /
    -- role_scopes / field_permissions).
    CONSTRAINT "role_versions_role_id_fkey"
        FOREIGN KEY ("role_id") REFERENCES "roles" ("id")
        ON DELETE CASCADE ON UPDATE CASCADE,
    -- Soft-link to the actor — preserve the version row when the
    -- user is later disabled or deleted; just clear the actor
    -- pointer.
    CONSTRAINT "role_versions_actor_user_id_fkey"
        FOREIGN KEY ("actor_user_id") REFERENCES "users" ("id")
        ON DELETE SET NULL ON UPDATE CASCADE,

    CONSTRAINT "role_versions_role_id_version_number_key"
        UNIQUE ("role_id", "version_number"),
    CONSTRAINT "role_versions_trigger_action_check"
        CHECK ("trigger_action" IN (
            'create', 'update', 'duplicate', 'scopes',
            'field_permissions', 'revert'
        ))
);

-- Hot index — admin History tab pages "latest first" by created_at,
-- scoped to (tenant, role).
CREATE INDEX "role_versions_tenant_id_role_id_created_at_idx"
  ON "role_versions" ("tenant_id", "role_id", "created_at" DESC);
-- Secondary index for "version N of role X" detail lookup.
CREATE INDEX "role_versions_role_id_version_number_idx"
  ON "role_versions" ("role_id", "version_number");

ALTER TABLE "role_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "role_versions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "role_versions_tenant_isolation"
  ON "role_versions"
  USING ("tenant_id" = current_tenant_id())
  WITH CHECK ("tenant_id" = current_tenant_id());
