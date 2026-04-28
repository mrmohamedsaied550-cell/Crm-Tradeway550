/**
 * Prisma seed entrypoint.
 *
 * C6 added the default tenant.
 * C7 added the global capability catalogue + per-tenant roles + mappings.
 * C8 adds 5 dev users for trade_way_default with bcrypt password hashes.
 *
 * Passwords come from the `SEED_DEFAULT_PASSWORD` environment variable when
 * set; otherwise the dev placeholder `Password@123` is used. The plaintext
 * is NEVER logged. Production deployments must set SEED_DEFAULT_PASSWORD or
 * disable the seed entirely.
 *
 * Larger fixtures (companies Uber + inDrive, country EG with timezone
 * Africa/Cairo and holidays, teams) land in C13/C14/C18.
 *
 * Run with: `pnpm db:seed`. Idempotent — safe to re-run repeatedly.
 */

import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/identity/password.util';
import { CAPABILITY_DEFINITIONS } from '../src/rbac/capabilities.registry';
import { ROLE_DEFINITIONS, type RoleCode } from '../src/rbac/roles.registry';

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

interface SeedUserDef {
  readonly email: string;
  readonly name: string;
  readonly role: RoleCode;
}

const SEED_USERS: readonly SeedUserDef[] = [
  { email: 'super@tradeway.com', name: 'Super Admin', role: 'super_admin' },
  { email: 'ops@tradeway.com', name: 'Operations Manager', role: 'ops_manager' },
  { email: 'eg.manager@tradeway.com', name: 'Account Manager — Egypt', role: 'account_manager' },
  { email: 'eg.uber.tl.sales@tradeway.com', name: 'TL Sales — Uber EG', role: 'tl_sales' },
  {
    email: 'eg.uber.sales1@tradeway.com',
    name: 'Sara — Sales Agent (Uber EG)',
    role: 'sales_agent',
  },
];

async function seedUsers(tenantId: string, roleIdByCode: Map<string, string>): Promise<void> {
  // Resolve plaintext from env; never log it. The placeholder default is
  // documented in apps/api/.env.example so dev users can log in immediately.
  const plaintext = process.env['SEED_DEFAULT_PASSWORD'] ?? 'Password@123';
  const hash = await hashPassword(plaintext);

  await withTenant(tenantId, async (tx) => {
    for (const u of SEED_USERS) {
      const roleId = roleIdByCode.get(u.role);
      if (!roleId) {
        throw new Error(`seed: role ${u.role} not found for tenant ${tenantId}`);
      }
      const email = u.email.trim().toLowerCase();
      await tx.user.upsert({
        where: { tenantId_email: { tenantId, email } },
        update: {
          name: u.name,
          roleId,
          status: 'active',
          // Re-set hash on every run so dev environments stay consistent.
          passwordHash: hash,
        },
        create: {
          tenantId,
          email,
          name: u.name,
          roleId,
          status: 'active',
          passwordHash: hash,
          language: 'en',
        },
      });
    }
  });

  // eslint-disable-next-line no-console
  console.log(
    `seed: users ready — ${SEED_USERS.length} users for tenant ${tenantId} (passwords seeded from SEED_DEFAULT_PASSWORD; not logged)`,
  );
}

async function main(): Promise<void> {
  const tenant = await seedTenant();
  const capabilityIdByCode = await seedCapabilities();
  await seedRolesAndMappings(tenant.id, capabilityIdByCode);

  // Build a roleCode -> roleId map (read inside tenant context).
  const roleIdByCode = new Map<string, string>();
  await withTenant(tenant.id, async (tx) => {
    const rows = await tx.role.findMany({ select: { id: true, code: true } });
    for (const r of rows) roleIdByCode.set(r.code, r.id);
  });
  await seedUsers(tenant.id, roleIdByCode);
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
