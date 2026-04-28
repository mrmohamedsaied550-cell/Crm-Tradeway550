-- C7 — RBAC catalogue.
--
-- `capabilities` is global (no tenant_id, no RLS): capability codes are part
--   of the application contract and shared across tenants.
-- `roles` and `role_capabilities` are tenant-scoped with RLS enforced via
--   current_tenant_id() (declared in 0001_foundations).

-- CreateTable
CREATE TABLE "capabilities" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "capabilities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name_ar" TEXT NOT NULL,
    "name_en" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_capabilities" (
    "tenant_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "capability_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_capabilities_pkey" PRIMARY KEY ("role_id","capability_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "capabilities_code_key" ON "capabilities"("code");

-- CreateIndex
CREATE INDEX "roles_tenant_id_is_active_idx" ON "roles"("tenant_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "roles_tenant_id_code_key" ON "roles"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "role_capabilities_tenant_id_idx" ON "role_capabilities"("tenant_id");

-- CreateIndex
CREATE INDEX "role_capabilities_capability_id_idx" ON "role_capabilities"("capability_id");

-- AddForeignKey
ALTER TABLE "roles" ADD CONSTRAINT "roles_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_capabilities" ADD CONSTRAINT "role_capabilities_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_capabilities" ADD CONSTRAINT "role_capabilities_capability_id_fkey" FOREIGN KEY ("capability_id") REFERENCES "capabilities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Row-Level Security on tenant-scoped tables.
-- FORCE makes the policy apply even to the table owner (crm_user). The
-- application sets the GUC via PrismaService.withTenant() before any
-- read/write; queries without a GUC see zero rows.
-- ---------------------------------------------------------------------------
ALTER TABLE "roles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "roles" FORCE  ROW LEVEL SECURITY;
CREATE POLICY "roles_tenant_isolation" ON "roles"
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE "role_capabilities" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "role_capabilities" FORCE  ROW LEVEL SECURITY;
CREATE POLICY "role_capabilities_tenant_isolation" ON "role_capabilities"
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
