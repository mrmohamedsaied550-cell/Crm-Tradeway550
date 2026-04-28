-- AlterTable
ALTER TABLE "users" ADD COLUMN     "team_id" UUID;

-- CreateTable
CREATE TABLE "companies" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "companies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "countries" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "countries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teams" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "country_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "companies_tenant_id_is_active_idx" ON "companies"("tenant_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "companies_tenant_id_code_key" ON "companies"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "countries_tenant_id_company_id_idx" ON "countries"("tenant_id", "company_id");

-- CreateIndex
CREATE UNIQUE INDEX "countries_tenant_id_company_id_code_key" ON "countries"("tenant_id", "company_id", "code");

-- CreateIndex
CREATE INDEX "teams_tenant_id_country_id_idx" ON "teams"("tenant_id", "country_id");

-- CreateIndex
CREATE UNIQUE INDEX "teams_tenant_id_country_id_name_key" ON "teams"("tenant_id", "country_id", "name");

-- CreateIndex
CREATE INDEX "users_tenant_id_team_id_idx" ON "users"("tenant_id", "team_id");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "companies" ADD CONSTRAINT "companies_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "countries" ADD CONSTRAINT "countries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "countries" ADD CONSTRAINT "countries_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teams" ADD CONSTRAINT "teams_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teams" ADD CONSTRAINT "teams_country_id_fkey" FOREIGN KEY ("country_id") REFERENCES "countries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- C12 — Row-Level Security on companies / countries / teams.
-- FORCE applies the policy even to the table owner (crm_user). Application
-- code sets the GUC via PrismaService.withTenant() before any read/write.
-- The hierarchy is enforced at the service layer (existence check under the
-- active GUC); no extra DB constraint is needed because RLS makes the
-- cross-tenant existence check return null.
-- ---------------------------------------------------------------------------

ALTER TABLE "companies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "companies" FORCE  ROW LEVEL SECURITY;
CREATE POLICY "companies_tenant_isolation" ON "companies"
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE "countries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "countries" FORCE  ROW LEVEL SECURITY;
CREATE POLICY "countries_tenant_isolation" ON "countries"
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE "teams" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "teams" FORCE  ROW LEVEL SECURITY;
CREATE POLICY "teams_tenant_isolation" ON "teams"
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
