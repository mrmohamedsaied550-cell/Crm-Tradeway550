/**
 * Phase C — C10B-2: backfill `Contact` rows from existing
 * `WhatsAppConversation` rows and denormalise the ownership chain
 * onto every linked conversation.
 *
 * Idempotent: re-runs only refresh denormalised flags and never
 * overwrite a real (non-`migrated`) ownership assignment. See the
 * service-level docs in `src/whatsapp/whatsapp-backfill.service.ts`
 * for the detailed rules.
 *
 * Usage:
 *
 *     # apply migrations first, then run the data-migration:
 *     pnpm prisma migrate deploy
 *     pnpm tsx apps/api/scripts/c10b-backfill.ts
 *
 * The script bypasses RLS by setting `app.tenant_id` per-tenant
 * (mirrors the encrypt-whatsapp-tokens.ts pattern). Production
 * rollouts should run it from a CI/CD job with the same DATABASE_URL
 * the app uses. Idempotence is the safety mechanism — re-running on
 * a partially-migrated DB picks up where the previous run left off
 * without corrupting any rows.
 */

import { PrismaClient } from '@prisma/client';

import { WhatsAppBackfillService } from '../src/whatsapp/whatsapp-backfill.service';

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  await prisma.$connect();
  const svc = new WhatsAppBackfillService();
  try {
    const report = await svc.backfillAll(prisma);
    // eslint-disable-next-line no-console
    console.log('c10b-backfill report:', JSON.stringify(report, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('c10b-backfill failed:', err);
  process.exit(1);
});
