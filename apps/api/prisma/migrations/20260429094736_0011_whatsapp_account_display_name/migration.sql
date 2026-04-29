-- C24A — friendly display name on whatsapp_accounts.
--
-- Added nullable, backfilled from phone_number, then promoted to NOT NULL
-- so the migration is safe on a non-empty table. The trigger on
-- whatsapp_accounts (defined in 0009) doesn't reference display_name so
-- the synced whatsapp_routes mirror is unaffected.

ALTER TABLE "whatsapp_accounts" ADD COLUMN "display_name" TEXT;

-- Backfill: existing rows didn't have a friendly name; use the phone
-- number as the seed so the admin UI renders something meaningful until
-- an operator edits it.
UPDATE "whatsapp_accounts"
SET    "display_name" = "phone_number"
WHERE  "display_name" IS NULL;

ALTER TABLE "whatsapp_accounts" ALTER COLUMN "display_name" SET NOT NULL;
