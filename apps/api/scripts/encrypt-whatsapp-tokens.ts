/**
 * P2-05 — bulk re-encrypt every plaintext `access_token` in
 * `whatsapp_accounts`.
 *
 * Idempotent: rows whose `access_token` already starts with `v1:`
 * are reported and skipped; only plaintext rows are touched. The
 * update is per-row via the unique `id`, so the script is safe to
 * re-run, interrupt and resume.
 *
 * The script reads the encryption key from the SAME env var
 * (`FIELD_ENCRYPTION_KEY`, with `WHATSAPP_TOKEN_ENCRYPTION_KEY` as
 * an alias) the application uses, so an inconsistent deploy is
 * impossible — if the API can't decrypt the resulting rows, the
 * script can't have produced them either.
 *
 * Usage:
 *
 *     # set the same key the API will use:
 *     export FIELD_ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
 *
 *     # apply migrations first, then run the data-migration:
 *     pnpm prisma migrate deploy
 *     pnpm tsx apps/api/scripts/encrypt-whatsapp-tokens.ts
 *
 * The script bypasses RLS via direct PrismaClient queries (no
 * tenant context) — this is the only at-deploy moment where that's
 * appropriate. Production rollouts should run it from a CI/CD job
 * with the same DATABASE_URL the app uses.
 */

import { PrismaClient } from '@prisma/client';

import { encryptSecret, isFieldEncrypted, loadFieldEncryptionKey } from '../src/common/crypto';

async function main(): Promise<void> {
  // Force-load the key up-front so a misconfigured env fails before
  // we touch any rows.
  loadFieldEncryptionKey();

  const prisma = new PrismaClient();
  await prisma.$connect();
  let scanned = 0;
  let encrypted = 0;
  let alreadyEncrypted = 0;
  try {
    // `whatsapp_accounts` is RLS-protected, so a raw cross-tenant
    // findMany returns 0 rows. Walk one tenant at a time, setting
    // `app.tenant_id` per transaction (the same shape the request
    // path uses via PrismaService.withTenant). The `tenants` table
    // itself is not RLS-protected, so the outer scan is fine.
    const tenants = await prisma.tenant.findMany({ select: { id: true } });
    for (const t of tenants) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await prisma.$transaction(async (tx: any) => {
        await tx.$executeRawUnsafe(`SET LOCAL app.tenant_id = '${t.id}'`);
        // Cursor pagination keeps the heap bounded even when one
        // tenant has many WhatsApp accounts.
        let cursorId: string | undefined;
        for (;;) {
          const batch: { id: string; accessToken: string }[] = await tx.whatsAppAccount.findMany({
            where: cursorId ? { id: { gt: cursorId } } : {},
            orderBy: { id: 'asc' },
            take: 500,
            select: { id: true, accessToken: true },
          });
          if (batch.length === 0) break;
          for (const row of batch) {
            scanned += 1;
            if (isFieldEncrypted(row.accessToken)) {
              alreadyEncrypted += 1;
              continue;
            }
            const ciphertext = encryptSecret(row.accessToken);
            await tx.whatsAppAccount.update({
              where: { id: row.id },
              data: { accessToken: ciphertext },
            });
            encrypted += 1;
          }
          cursorId = batch[batch.length - 1]?.id;
        }
      });
    }
  } finally {
    await prisma.$disconnect();
  }

  // eslint-disable-next-line no-console
  console.log(
    `encrypt-whatsapp-tokens: scanned=${scanned} encrypted=${encrypted} already_encrypted=${alreadyEncrypted}`,
  );
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('encrypt-whatsapp-tokens failed:', err);
  process.exit(1);
});
