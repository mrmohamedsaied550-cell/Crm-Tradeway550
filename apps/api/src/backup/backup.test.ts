/**
 * P3-07 — tenant export tests.
 *
 * Provisions a throwaway tenant with a couple of leads, asks the
 * BackupService to export it, and asserts:
 *   - sensitive fields are stripped (passwordHash on User; accessToken
 *     / appSecret / verifyToken on WhatsAppAccount),
 *   - the counts envelope matches the data arrays,
 *   - schemaVersion + rowCap are stamped.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { tenantContext } from '../tenants/tenant-context';
import { hashPassword } from '../identity/password.util';
import { PIPELINE_STAGE_DEFINITIONS } from '../crm/pipeline.registry';
import { BackupService, tenantBackupToWireEnvelope } from './backup.service';

const TENANT_CODE = '__p3_07_backup__';

let prisma: PrismaClient;
let svc: BackupService;
let tenantId: string;

function inTenant<T>(fn: () => Promise<T>): Promise<T> {
  return tenantContext.run({ tenantId, tenantCode: TENANT_CODE, source: 'header' }, fn);
}

async function withTenantRaw<T>(tid: string, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return prisma.$transaction(async (tx: any) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.tenant_id = '${tid}'`);
    return fn(tx);
  });
}

describe('BackupService.exportTenant (P3-07)', () => {
  before(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    const prismaSvc = new PrismaService();
    svc = new BackupService(prismaSvc);

    const tenant = await prisma.tenant.upsert({
      where: { code: TENANT_CODE },
      update: { isActive: true },
      create: { code: TENANT_CODE, name: 'P3-07 backup test tenant' },
    });
    tenantId = tenant.id;

    const role = await withTenantRaw(tenantId, (tx) =>
      tx.role.upsert({
        where: { tenantId_code: { tenantId, code: 'sales_agent' } },
        update: {},
        create: {
          tenantId,
          code: 'sales_agent',
          nameAr: 'وكيل',
          nameEn: 'Sales Agent',
          level: 30,
        },
      }),
    );
    const hash = await hashPassword('Password@123', 4);
    const user = await withTenantRaw(tenantId, (tx) =>
      tx.user.upsert({
        where: { tenantId_email: { tenantId, email: '__p307_user@test' } },
        update: {},
        create: {
          tenantId,
          email: '__p307_user@test',
          name: 'Backup User',
          passwordHash: hash,
          roleId: role.id,
        },
      }),
    );

    // Pipeline + lead so the export carries non-empty arrays.
    await withTenantRaw(tenantId, async (tx) => {
      const pipeline = await tx.pipeline.create({
        data: { tenantId, name: 'Default', isDefault: true, isActive: true },
      });
      for (const def of PIPELINE_STAGE_DEFINITIONS) {
        await tx.pipelineStage.create({
          data: {
            tenantId,
            pipelineId: pipeline.id,
            code: def.code,
            name: def.name,
            order: def.order,
            isTerminal: def.isTerminal,
          },
        });
      }
      const stage = await tx.pipelineStage.findFirstOrThrow({
        where: { pipelineId: pipeline.id, code: 'new' },
      });
      await tx.lead.create({
        data: {
          tenantId,
          name: 'Backup Lead',
          phone: '+201007770001',
          source: 'manual',
          stageId: stage.id,
          assignedToId: user.id,
        },
      });
      // WhatsApp account — to prove the secret-stripping path.
      await tx.whatsAppAccount.create({
        data: {
          tenantId,
          displayName: 'Backup WA',
          phoneNumber: '+201007770999',
          phoneNumberId: 'pnid_p307',
          provider: 'meta_cloud',
          accessToken: '__SECRET_TOKEN__',
          appSecret: '__SECRET_APP_SECRET__',
          verifyToken: '__SECRET_VERIFY_TOKEN__',
        },
      });
    });
  });

  after(async () => {
    await prisma.tenant.delete({ where: { code: TENANT_CODE } }).catch(() => {});
    await prisma.$disconnect();
  });

  it('strips secrets and stamps schemaVersion + rowCap', async () => {
    // D5.6D-1 — exportTenant() now returns a StructuredTenantBackup;
    // collapse it through the wire-envelope helper so this legacy
    // assertion suite continues to verify the wire-restore-compatible
    // shape end-to-end.
    const structured = await inTenant(() => svc.exportTenant());
    const dump = tenantBackupToWireEnvelope(structured) as {
      schemaVersion: number;
      rowCap: number;
      tenant: { code: string };
      counts: Record<string, number>;
      data: Record<string, unknown[]>;
    };

    assert.equal(dump.schemaVersion, 1);
    assert.equal(dump.rowCap, 10_000);
    assert.equal(dump.tenant.code, TENANT_CODE);

    // No accessToken / appSecret / verifyToken anywhere in the JSON.
    const blob = JSON.stringify(dump);
    assert.ok(!blob.includes('__SECRET_TOKEN__'), 'accessToken must not appear in export');
    assert.ok(!blob.includes('__SECRET_APP_SECRET__'), 'appSecret must not appear in export');
    assert.ok(!blob.includes('__SECRET_VERIFY_TOKEN__'), 'verifyToken must not appear in export');
    // No passwordHash either.
    assert.ok(!blob.includes('"passwordHash"'), 'passwordHash must not appear in export');

    // Counts envelope matches the data arrays length-for-length.
    for (const [key, count] of Object.entries(dump.counts)) {
      const arr = dump.data[key];
      assert.ok(Array.isArray(arr), `data.${key} must be an array`);
      assert.equal(arr!.length, count, `counts.${key} must match data.${key}.length`);
    }

    // Sanity: at least the lead we seeded shows up.
    assert.equal(dump.counts['leads'], 1);
    assert.equal(dump.counts['whatsappAccounts'], 1);
  });
});
