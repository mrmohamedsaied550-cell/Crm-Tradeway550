/**
 * Prisma seed entrypoint.
 *
 * C5 ships a no-op seed. Real fixtures (tenant, roles, capabilities,
 * companies Uber + inDrive, country EG with timezone Africa/Cairo and
 * holidays, teams, users matching the Sprint 1 backlog) land in C18.
 *
 * Run with: `pnpm db:seed` (forwards to `pnpm --filter @crm/api db:seed`).
 */

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log('seed: no-op (C5) — real fixtures land in C18');
}

main()
  .catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error('seed failed:', err);
    process.exit(1);
  })
  .finally(() => {
    // No PrismaClient instantiated yet; nothing to disconnect.
  });
