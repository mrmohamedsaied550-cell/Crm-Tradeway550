/**
 * Prisma seed entrypoint.
 *
 * C6 added the default tenant.
 * C7 added the global capability catalogue + per-tenant roles + mappings.
 * C8 adds 5 dev users for trade_way_default with bcrypt password hashes.
 * C10 adds the 5 default pipeline stages (New / Contacted / Interested /
 * Converted / Lost) per tenant.
 * C12 adds the org structure: 1 default Company (Uber), 2 Countries
 * (EG, SA), 3 Teams (Sales / Activation / Driving under EG, Sales under
 * SA), and assigns the seeded sales agents to their team.
 *
 * Passwords come from the `SEED_DEFAULT_PASSWORD` environment variable when
 * set; otherwise the dev placeholder `Password@123` is used. The plaintext
 * is NEVER logged. Production deployments must set SEED_DEFAULT_PASSWORD or
 * disable the seed entirely.
 *
 * Run with: `pnpm db:seed`. Idempotent — safe to re-run repeatedly.
 */

import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/identity/password.util';
import { CAPABILITY_DEFINITIONS } from '../src/rbac/capabilities.registry';
import { ROLE_DEFINITIONS, type RoleCode } from '../src/rbac/roles.registry';
import { PIPELINE_STAGE_DEFINITIONS } from '../src/crm/pipeline.registry';

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
      // Upsert by (tenantId, code). Phase C — C1: every role in the
      // registry is a system template (immutable at the service layer
      // in C2); `isSystem = true` is forced on both create and update
      // so a tenant can never accidentally drop the flag.
      const role = await tx.role.upsert({
        where: { tenantId_code: { tenantId, code: def.code } },
        update: {
          nameAr: def.nameAr,
          nameEn: def.nameEn,
          level: def.level,
          isActive: true,
          isSystem: true,
        },
        create: {
          tenantId,
          code: def.code,
          nameAr: def.nameAr,
          nameEn: def.nameEn,
          level: def.level,
          isSystem: true,
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

      // Phase C — C1: default 'global' scope per (role × resource).
      // Idempotent via the (roleId, resource) PK.
      await tx.roleScope.createMany({
        data: PHASE_C_SCOPED_RESOURCES.map((resource) => ({
          tenantId,
          roleId: role.id,
          resource,
          scope: 'global',
        })),
        skipDuplicates: true,
      });

      // Phase C — C1: explicit deny rows for sales_agent. The migration
      // installs these once; the seed re-runs safely. Read-side
      // enforcement lands in C4 — until then these rows exist but are
      // unread, so existing tests are unaffected.
      if (def.code === 'sales_agent') {
        await tx.fieldPermission.createMany({
          data: SALES_AGENT_FIELD_DENIES.map(([resource, field]) => ({
            tenantId,
            roleId: role.id,
            resource,
            field,
            canRead: false,
            canWrite: false,
          })),
          skipDuplicates: true,
        });
      }

      // Phase D5 — D5.7: ownership-history field-permission defaults.
      // Sales / Activation / Driving agents get explicit deny rows on
      // every rotation owner-history field AND on lead.previousOwner /
      // lead.ownerHistory. This replaces the pre-D5.7 hardcoded
      // `lead.write` gate that previously blocked these surfaces; the
      // new gate consults `field_permissions` directly so admins can
      // override per-role without granting edit permissions.
      // Migration 0040 installs the same rows for existing tenants;
      // this seed entry covers fresh-tenant creation + re-runs.
      if (
        def.code === 'sales_agent' ||
        def.code === 'activation_agent' ||
        def.code === 'driving_agent'
      ) {
        await tx.fieldPermission.createMany({
          data: D5_7_OWNERSHIP_HISTORY_DENIES.map(([resource, field]) => ({
            tenantId,
            roleId: role.id,
            resource,
            field,
            canRead: false,
            canWrite: false,
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

/**
 * Phase C — C1: resources gated by the data-scope system. Each role
 * gets one RoleScope row per resource at seed time, defaulting to
 * 'global' so existing behaviour is preserved.
 */
const PHASE_C_SCOPED_RESOURCES = ['lead', 'captain', 'followup', 'whatsapp.conversation'] as const;

/**
 * Phase C — C1: explicit deny rows for the sales_agent role. C4 wires
 * the read-side enforcement; until then these rows exist but are
 * unread.
 */
const SALES_AGENT_FIELD_DENIES: ReadonlyArray<readonly [resource: string, field: string]> = [
  ['lead', 'id'],
  ['lead', 'attribution.campaign'],
  ['lead', 'source'],
];

/**
 * Phase D5 — D5.7: default deny rows for the agent cohort
 * (`sales_agent` / `activation_agent` / `driving_agent`) on every
 * rotation owner-history field + the lead-side previous-owner
 * surfaces. Mirrors the pre-D5.7 hardcoded gate so the migration +
 * seed preserve the existing UX without requiring per-tenant admin
 * configuration. TL+ / Ops / Account Manager / Super Admin keep
 * full visibility because no deny row is written for them.
 */
const D5_7_OWNERSHIP_HISTORY_DENIES: ReadonlyArray<readonly [resource: string, field: string]> = [
  ['rotation', 'fromUser'],
  ['rotation', 'toUser'],
  ['rotation', 'actor'],
  ['rotation', 'notes'],
  ['rotation', 'handoverSummary'],
  ['rotation', 'internalPayload'],
  ['lead', 'previousOwner'],
  ['lead', 'ownerHistory'],
];

// ───────────────────────────────────────────────────────────────────────
// C12 — org structure: Company / Country / Team
// ───────────────────────────────────────────────────────────────────────

interface SeedCompanyDef {
  readonly code: string;
  readonly name: string;
}
interface SeedCountryDef {
  readonly companyCode: string;
  readonly code: string; // ISO 3166-1 alpha-2
  readonly name: string;
}
/** Composite team key: `<companyCode>:<countryCode>:<teamName>`. */
interface SeedTeamDef {
  readonly companyCode: string;
  readonly countryCode: string;
  readonly name: string;
}

const SEED_COMPANIES: readonly SeedCompanyDef[] = [{ code: 'uber', name: 'Uber' }];

const SEED_COUNTRIES: readonly SeedCountryDef[] = [
  { companyCode: 'uber', code: 'EG', name: 'Egypt' },
  { companyCode: 'uber', code: 'SA', name: 'Saudi Arabia' },
];

const SEED_TEAMS: readonly SeedTeamDef[] = [
  { companyCode: 'uber', countryCode: 'EG', name: 'Sales' },
  { companyCode: 'uber', countryCode: 'EG', name: 'Activation' },
  { companyCode: 'uber', countryCode: 'EG', name: 'Driving' },
  { companyCode: 'uber', countryCode: 'SA', name: 'Sales' },
];

const teamKey = (companyCode: string, countryCode: string, name: string): string =>
  `${companyCode}:${countryCode}:${name}`;

async function seedOrgStructure(tenantId: string): Promise<{
  companyIdByCode: Map<string, string>;
  countryIdByKey: Map<string, string>;
  teamIdByKey: Map<string, string>;
}> {
  const companyIdByCode = new Map<string, string>();
  const countryIdByKey = new Map<string, string>();
  const teamIdByKey = new Map<string, string>();

  await withTenant(tenantId, async (tx) => {
    for (const c of SEED_COMPANIES) {
      const row = await tx.company.upsert({
        where: { tenantId_code: { tenantId, code: c.code } },
        update: { name: c.name, isActive: true },
        create: { tenantId, code: c.code, name: c.name, isActive: true },
      });
      companyIdByCode.set(c.code, row.id);
    }

    for (const c of SEED_COUNTRIES) {
      const companyId = companyIdByCode.get(c.companyCode);
      if (!companyId) {
        throw new Error(`seed: country ${c.code} references unknown company ${c.companyCode}`);
      }
      const row = await tx.country.upsert({
        where: {
          tenantId_companyId_code: { tenantId, companyId, code: c.code },
        },
        update: { name: c.name, isActive: true },
        create: { tenantId, companyId, code: c.code, name: c.name, isActive: true },
      });
      countryIdByKey.set(`${c.companyCode}:${c.code}`, row.id);
    }

    for (const t of SEED_TEAMS) {
      const countryId = countryIdByKey.get(`${t.companyCode}:${t.countryCode}`);
      if (!countryId) {
        throw new Error(
          `seed: team "${t.name}" references unknown country ${t.companyCode}:${t.countryCode}`,
        );
      }
      const row = await tx.team.upsert({
        where: {
          tenantId_countryId_name: { tenantId, countryId, name: t.name },
        },
        update: { isActive: true },
        create: { tenantId, countryId, name: t.name, isActive: true },
      });
      teamIdByKey.set(teamKey(t.companyCode, t.countryCode, t.name), row.id);
    }
  });

  // eslint-disable-next-line no-console
  console.log(
    `seed: org structure ready — ${SEED_COMPANIES.length} companies, ${SEED_COUNTRIES.length} countries, ${SEED_TEAMS.length} teams for tenant ${tenantId}`,
  );
  return { companyIdByCode, countryIdByKey, teamIdByKey };
}

interface SeedUserDef {
  readonly email: string;
  readonly name: string;
  readonly role: RoleCode;
  /** Optional team membership — `<companyCode>:<countryCode>:<teamName>`. */
  readonly teamKey?: string;
}

const SEED_USERS: readonly SeedUserDef[] = [
  { email: 'super@tradeway.com', name: 'Super Admin', role: 'super_admin' },
  { email: 'ops@tradeway.com', name: 'Operations Manager', role: 'ops_manager' },
  { email: 'eg.manager@tradeway.com', name: 'Account Manager — Egypt', role: 'account_manager' },
  {
    email: 'eg.uber.tl.sales@tradeway.com',
    name: 'TL Sales — Uber EG',
    role: 'tl_sales',
    teamKey: 'uber:EG:Sales',
  },
  {
    email: 'eg.uber.sales1@tradeway.com',
    name: 'Sara — Sales Agent (Uber EG)',
    role: 'sales_agent',
    teamKey: 'uber:EG:Sales',
  },
  {
    email: 'eg.uber.activation1@tradeway.com',
    name: 'Mona — Activation Agent (Uber EG)',
    role: 'activation_agent',
    teamKey: 'uber:EG:Activation',
  },
  {
    email: 'sa.uber.sales1@tradeway.com',
    name: 'Khalid — Sales Agent (Uber SA)',
    role: 'sales_agent',
    teamKey: 'uber:SA:Sales',
  },
];

async function seedUsers(
  tenantId: string,
  roleIdByCode: Map<string, string>,
  teamIdByKey: Map<string, string>,
): Promise<void> {
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
      const teamId = u.teamKey ? (teamIdByKey.get(u.teamKey) ?? null) : null;
      if (u.teamKey && !teamId) {
        throw new Error(`seed: user ${u.email} references unknown team ${u.teamKey}`);
      }
      const email = u.email.trim().toLowerCase();
      await tx.user.upsert({
        where: { tenantId_email: { tenantId, email } },
        update: {
          name: u.name,
          roleId,
          teamId,
          status: 'active',
          // Re-set hash on every run so dev environments stay consistent.
          passwordHash: hash,
        },
        create: {
          tenantId,
          email,
          name: u.name,
          roleId,
          teamId,
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

async function seedPipelineStages(tenantId: string): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    // P2-07 — every tenant has exactly one "default" pipeline that
    // owns the canonical stage list. The migration backfilled it for
    // pre-existing tenants; for fresh tenants we upsert it here so
    // the seed stays idempotent regardless of when the migration ran.
    const existingDefault = await tx.pipeline.findFirst({
      where: { tenantId, isDefault: true },
      select: { id: true },
    });
    const pipelineId =
      existingDefault?.id ??
      (
        await tx.pipeline.create({
          data: {
            tenantId,
            name: 'Default',
            isDefault: true,
            isActive: true,
          },
          select: { id: true },
        })
      ).id;

    for (const def of PIPELINE_STAGE_DEFINITIONS) {
      await tx.pipelineStage.upsert({
        where: { pipelineId_code: { pipelineId, code: def.code } },
        update: { name: def.name, order: def.order, isTerminal: def.isTerminal },
        create: {
          tenantId,
          pipelineId,
          code: def.code,
          name: def.name,
          order: def.order,
          isTerminal: def.isTerminal,
        },
      });
    }
  });

  // eslint-disable-next-line no-console
  console.log(
    `seed: pipeline stages ready — ${PIPELINE_STAGE_DEFINITIONS.length} stages for tenant ${tenantId}`,
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
  const { teamIdByKey } = await seedOrgStructure(tenant.id);
  await seedUsers(tenant.id, roleIdByCode, teamIdByKey);
  await seedPipelineStages(tenant.id);
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
