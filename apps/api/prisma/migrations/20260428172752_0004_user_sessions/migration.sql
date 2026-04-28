-- C9 — user_sessions.
--
-- Tenant-scoped table with FORCE ROW LEVEL SECURITY enforced via
-- current_tenant_id() (declared in 0001_foundations).
--
-- Refresh-token storage. Tokens themselves never live in the DB —
-- only their SHA-256 digest. Lookup by digest, revoke by setting
-- revoked_at, rotate via replaced_by_id.

-- CreateTable
CREATE TABLE "user_sessions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "refresh_token_hash" TEXT NOT NULL,
    "user_agent" TEXT,
    "ip" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "replaced_by_id" UUID,

    CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_sessions_tenant_id_user_id_idx" ON "user_sessions"("tenant_id", "user_id");

-- Plain B-tree index covers both active lookups (WHERE revoked_at IS NULL)
-- and reuse-detection scans (WHERE revoked_at IS NOT NULL). Uniqueness is
-- not enforced at the DB level: SHA-256 collisions are vanishingly
-- improbable and the rotation flow relies on the row's `revoked_at`
-- timestamp rather than on the hash being unique.
CREATE INDEX "user_sessions_refresh_token_hash_idx"
  ON "user_sessions"("refresh_token_hash");

-- AddForeignKey
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Row-Level Security on user_sessions.
-- ---------------------------------------------------------------------------
ALTER TABLE "user_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_sessions" FORCE  ROW LEVEL SECURITY;
CREATE POLICY "user_sessions_tenant_isolation" ON "user_sessions"
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
