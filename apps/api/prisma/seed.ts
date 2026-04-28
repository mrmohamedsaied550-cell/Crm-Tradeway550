/**
 * Prisma seed entrypoint.
 *
 * C6 added the default tenant.
 * C7 adds the global capability catalogue and per-tenant roles + mappings.
 *
 * Larger fixtures (companies Uber + inDrive, country EG with timezone
 * Africa/Cairo and holidays, teams, users) land in C18.
 *
 * Run with: `pnpm db:seed`. Idempotent — safe to re-run repeatedly.
 */

import { PrismaClient } from '@prisma/client';
import { CAPABILITY_DEFINITIONS } from '../src/rbac/capabilities.registry';
import { ROLE_DEFINITIONS } from '../src/rbac/roles.registry';

const DEFAULT_TENANT_CODE = 'trade_way_default';
const DEFAULT_TENANT_NAME = 'Trade Way / Captain Masr (default)';

const prisma = new PrismaClient();

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function withTenant<T>(tenantId: string, fn: (tx: typeof prisma) => Promise<T>): Promise<T> {
  if (!UUID_REGEX.test(tenantId)) throw new Error(`invalid tenantId: ${tenantId}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return prisma.$transaction(async (tx: any) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.tenant_id = '${tenantId}'`);
    return fn(tx);
  });
}

async function seedTenant(): Promise<{ id: string; code: string }> {
  const tenant = await prisma.tenant.upsert({
    where: { code: DEFAULT_TENANT_CODE },
    update: { name: DEFAULT_TENANT_NAME, isActive: true },
    create: { code: DEFAULT_TENANT_CODE, name: DEFAULT_TENANT_NAME },
  });
  // eslint-disable-next-line no-console
  console.log(`seed: tenant ready — id=${tenant.id} code=${tenant.code}`);
  return tenant;
}

async function seedCapabilities(): Promise<Map<string, string>> {
  // Capabilities are global (no RLS) — direct upsert.
  await prisma.$transaction(
    CAPABILITY_DEFINITIONS.map((c) =>
      prisma.capability.upsert({
        where: { code: c.code },
        update: { description: c.description },
        create: { code: c.code, description: c.description },
      }),
    ),
  );
  const all = await prisma.capability.findMany({ select: { id: true, code: true } });
  // eslint-disable-next-line no-console
  console.log(`seed: capabilities ready — ${all.length} entries`);
  return new Map(all.map((c) => [c.code, c.id]));
}

async function seedRolesAndMappings(
  tenantId: string,
  capabilityIdByCode: Map<string, string>,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    for (const def of ROLE_DEFINITIONS) {
      // Upsert by (tenantId, code).
      const role = await tx.role.upsert({
        where: { tenantId_code: { tenantId, code: def.code } },
        update: {
          nameAr: def.nameAr,
          nameEn: def.nameEn,
          level: def.level,
          isActive: true,
        },
        create: {
          tenantId,
          code: def.code,
          nameAr: def.nameAr,
          nameEn: def.nameEn,
          level: def.level,
        },
      });

      // Replace this role's capability set with the registry's truth.
      const desiredCapIds = def.capabilities
        .map((c) => capabilityIdByCode.get(c))
        .filter((id): id is string => Boolean(id));

      // Drop old links, then create new ones. Cheap because the table is tiny.
      await tx.roleCapability.deleteMany({ where: { roleId: role.id } });
      if (desiredCapIds.length > 0) {
        await tx.roleCapability.createMany({
          data: desiredCapIds.map((capabilityId) => ({
            tenantId,
            roleId: role.id,
            capabilityId,
          })),
          skipDuplicates: true,
        });
      }
    }
  });
  // eslint-disable-next-line no-console
  console.log(
    `seed: roles + mappings ready — ${ROLE_DEFINITIONS.length} roles for tenant ${tenantId}`,
  );
}

async function main(): Promise<void> {
  const tenant = await seedTenant();
  const capabilityIdByCode = await seedCapabilities();
  await seedRolesAndMappings(tenant.id, capabilityIdByCode);
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
