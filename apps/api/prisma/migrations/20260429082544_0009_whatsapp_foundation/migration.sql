-- CreateTable
CREATE TABLE "whatsapp_accounts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "phone_number" TEXT NOT NULL,
    "phone_number_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "access_token" TEXT NOT NULL,
    "app_secret" TEXT,
    "verify_token" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "whatsapp_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_messages" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "phone" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "provider_message_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'received',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whatsapp_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "whatsapp_accounts_tenant_id_is_active_idx" ON "whatsapp_accounts"("tenant_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_accounts_tenant_id_phone_number_key" ON "whatsapp_accounts"("tenant_id", "phone_number");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_accounts_phone_number_id_key" ON "whatsapp_accounts"("phone_number_id");

-- CreateIndex
CREATE INDEX "whatsapp_messages_tenant_id_phone_created_at_idx" ON "whatsapp_messages"("tenant_id", "phone", "created_at");

-- CreateIndex
CREATE INDEX "whatsapp_messages_tenant_id_direction_idx" ON "whatsapp_messages"("tenant_id", "direction");

-- CreateIndex
CREATE INDEX "whatsapp_messages_account_id_created_at_idx" ON "whatsapp_messages"("account_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_messages_tenant_id_provider_message_id_key" ON "whatsapp_messages"("tenant_id", "provider_message_id");

-- AddForeignKey
ALTER TABLE "whatsapp_accounts" ADD CONSTRAINT "whatsapp_accounts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_messages" ADD CONSTRAINT "whatsapp_messages_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_messages" ADD CONSTRAINT "whatsapp_messages_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "whatsapp_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- C21 — Row-Level Security on whatsapp_accounts + whatsapp_messages.
-- Same standard tenant_isolation policy used by every prior tenant-scoped
-- table. The webhook controller bypasses RLS at the router level (it has
-- no tenant context yet) and re-establishes it via PrismaService.withTenant
-- once the inbound payload is mapped to a WhatsAppAccount.
-- ---------------------------------------------------------------------------

ALTER TABLE "whatsapp_accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "whatsapp_accounts" FORCE  ROW LEVEL SECURITY;
CREATE POLICY "whatsapp_accounts_tenant_isolation" ON "whatsapp_accounts"
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE "whatsapp_messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "whatsapp_messages" FORCE  ROW LEVEL SECURITY;
CREATE POLICY "whatsapp_messages_tenant_isolation" ON "whatsapp_messages"
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- ---------------------------------------------------------------------------
-- C21 — webhook routing table.
--
-- The WhatsApp webhook controller is a public endpoint (no JWT, no tenant
-- header) — it must learn the right tenant from the inbound payload's
-- `phone_number_id` BEFORE any tenant-scoped reads can happen. The
-- `whatsapp_accounts` table is FORCE'd-RLS, so even the application role
-- can't SELECT cross-tenant.
--
-- Solution: a tiny denormalised `whatsapp_routes` table that mirrors the
-- routing fields (id, tenant_id, phone_number_id, verify_token, app_secret,
-- provider, is_active) and is intentionally NOT row-level-security'd. It
-- holds NO sensitive data — the access token never leaves whatsapp_accounts.
--
-- A trigger on whatsapp_accounts keeps the routes table in sync on every
-- INSERT / UPDATE / DELETE. The application reads whatsapp_routes for the
-- pre-tenant routing lookup, then switches into withTenant() for the
-- access-token-bearing read.
-- ---------------------------------------------------------------------------

CREATE TABLE "whatsapp_routes" (
    "phone_number_id" TEXT NOT NULL,
    "verify_token"    TEXT NOT NULL,
    "account_id"      UUID NOT NULL,
    "tenant_id"       UUID NOT NULL,
    "provider"        TEXT NOT NULL,
    "app_secret"      TEXT,
    "is_active"       BOOLEAN NOT NULL,
    CONSTRAINT "whatsapp_routes_pkey" PRIMARY KEY ("account_id")
);
CREATE UNIQUE INDEX "whatsapp_routes_phone_number_id_key" ON "whatsapp_routes"("phone_number_id");
CREATE INDEX        "whatsapp_routes_verify_token_idx"    ON "whatsapp_routes"("verify_token");

-- Trigger function: synchronise whatsapp_routes with whatsapp_accounts.
CREATE OR REPLACE FUNCTION whatsapp_sync_routes() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_OP = 'DELETE') THEN
    DELETE FROM whatsapp_routes WHERE account_id = OLD.id;
    RETURN OLD;
  END IF;

  INSERT INTO whatsapp_routes (
    phone_number_id, verify_token, account_id, tenant_id,
    provider, app_secret, is_active
  ) VALUES (
    NEW.phone_number_id, NEW.verify_token, NEW.id, NEW.tenant_id,
    NEW.provider, NEW.app_secret, NEW.is_active
  )
  ON CONFLICT (account_id) DO UPDATE SET
    phone_number_id = EXCLUDED.phone_number_id,
    verify_token    = EXCLUDED.verify_token,
    tenant_id       = EXCLUDED.tenant_id,
    provider        = EXCLUDED.provider,
    app_secret      = EXCLUDED.app_secret,
    is_active       = EXCLUDED.is_active;

  RETURN NEW;
END;
$$;

CREATE TRIGGER whatsapp_accounts_sync_routes
AFTER INSERT OR UPDATE OR DELETE ON whatsapp_accounts
FOR EACH ROW EXECUTE FUNCTION whatsapp_sync_routes();
