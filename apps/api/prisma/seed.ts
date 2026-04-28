/**
 * Prisma seed entrypoint.
 *
 * C6: upsert the default tenant `trade_way_default` so dev/CI runs always
 * have a tenant to scope requests to via `X-Tenant: trade_way_default`.
 *
 * Larger fixtures (roles, capabilities, companies Uber + inDrive, country EG
 * with timezone Africa/Cairo and holidays, teams, users matching the
 * Sprint 1 backlog) land in C18.
 *
 * Run with: `pnpm db:seed` (forwards to `pnpm --filter @crm/api db:seed`).
 */

import { PrismaClient } from '@prisma/client';

const DEFAULT_TENANT_CODE = 'trade_way_default';
const DEFAULT_TENANT_NAME = 'Trade Way / Captain Masr (default)';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const tenant = await prisma.tenant.upsert({
    where: { code: DEFAULT_TENANT_CODE },
    update: { name: DEFAULT_TENANT_NAME, isActive: true },
    create: { code: DEFAULT_TENANT_CODE, name: DEFAULT_TENANT_NAME },
  });
  // eslint-disable-next-line no-console
  console.log(`seed: tenant ready — id=${tenant.id} code=${tenant.code}`);
}

main()
  .catch(async (err: unknown) => {
    // eslint-disable-next-line no-console
    console.error('seed failed:', err);
    await prisma.$disconnect();
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
