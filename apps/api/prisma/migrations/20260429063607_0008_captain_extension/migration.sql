-- C18 — captain entity extension.
--
-- Adds the four columns the captain detail surface needs:
--   name      denormalised from the lead at conversion time
--   phone     denormalised from the lead at conversion time
--   team_id   activation / driving team owning the captain (nullable)
--   status    captain lifecycle status (active / inactive / archived)
--
-- The migration is safe to apply on a non-empty captains table: name +
-- phone are added nullable, backfilled from the linked lead, then
-- promoted to NOT NULL. RLS on the captains table is unchanged — it was
-- enabled by 0005_crm_core with the standard tenant_isolation policy.

-- AlterTable — additive columns; name + phone start nullable so we can
-- backfill from leads before promoting to NOT NULL.
ALTER TABLE "captains" ADD COLUMN     "name" TEXT,
ADD COLUMN     "phone" TEXT,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'active',
ADD COLUMN     "team_id" UUID;

-- Backfill name + phone from the linked lead row. Matches via lead_id
-- (unique on captains, primary key on leads); rows whose lead has been
-- hard-deleted before this migration shouldn't exist because the FK is
-- ON DELETE CASCADE.
UPDATE "captains" AS c
SET    "name"  = l."name",
       "phone" = l."phone"
FROM   "leads" AS l
WHERE  l."id" = c."lead_id";

-- Now that every existing row has values, lock NOT NULL in.
ALTER TABLE "captains" ALTER COLUMN "name"  SET NOT NULL;
ALTER TABLE "captains" ALTER COLUMN "phone" SET NOT NULL;

-- CreateIndex
CREATE INDEX "captains_tenant_id_status_idx" ON "captains"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "captains_tenant_id_team_id_idx" ON "captains"("tenant_id", "team_id");

-- AddForeignKey
ALTER TABLE "captains" ADD CONSTRAINT "captains_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;
