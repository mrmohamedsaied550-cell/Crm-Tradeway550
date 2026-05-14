/**
 * Sprint 15 (D15) — Tenant branding tests.
 *
 * Service-level coverage for the new GET/PATCH /tenant/branding flow.
 * Real Postgres, throwaway tenants, direct service calls (no HTTP).
 *
 * Scope:
 *   - default GET returns empty (all nulls) for a fresh tenant.
 *   - PATCH applies partial updates without clobbering omitted fields.
 *   - PATCH with `null` clears a field.
 *   - DTO validation rejects javascript:/data: URLs.
 *   - DTO validation rejects malformed hex colors.
 *   - audit row is emitted with the changed-fields list.
 *   - tenant isolation: tenant B's branding doesn't leak into tenant A's
 *     read.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { ZodError } from 'zod';

import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';

import { tenantContext } from './tenant-context';
import { TenantBrandingService } from './branding.service';
import { UpdateTenantBrandingSchema } from './branding.dto';

const TENANT_A_CODE = '__d15_brand_a__';
const TENANT_B_CODE = '__d15_brand_b__';

let prisma: PrismaClient;
let svc: TenantBrandingService;
let tenantAId: string;
let tenantBId: string;

function withCtx<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return tenantContext.run({ tenantId }, fn);
}

async function withTenantRaw<T>(tid: string, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return prisma.$transaction(async (tx: any) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.tenant_id = '${tid}'`);
    return fn(tx);
  });
}

describe('tenants — branding (Sprint 15 / D15)', () => {
  before(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    svc = new TenantBrandingService(new PrismaService(), new AuditService(new PrismaService()));

    const a = await prisma.tenant.upsert({
      where: { code: TENANT_A_CODE },
      update: { isActive: true },
      create: { code: TENANT_A_CODE, name: 'D15 branding A' },
    });
    tenantAId = a.id;
    const b = await prisma.tenant.upsert({
      where: { code: TENANT_B_CODE },
      update: { isActive: true },
      create: { code: TENANT_B_CODE, name: 'D15 branding B' },
    });
    tenantBId = b.id;
  });

  after(async () => {
    await prisma.tenant.delete({ where: { code: TENANT_A_CODE } }).catch(() => {});
    await prisma.tenant.delete({ where: { code: TENANT_B_CODE } }).catch(() => {});
    await prisma.$disconnect();
  });

  it('GET on a fresh tenant returns all-null branding', async () => {
    const branding = await withCtx(tenantAId, () => svc.getCurrent());
    assert.equal(branding.systemName, null);
    assert.equal(branding.logoUrl, null);
    assert.equal(branding.primaryColor, null);
    assert.equal(branding.updatedAt, null);
  });

  it('PATCH applies the supplied fields and leaves others untouched', async () => {
    await withCtx(tenantAId, async () => {
      const first = await svc.update({ systemName: 'Captain Masr', primaryColor: '#1f3864' }, null);
      assert.equal(first.systemName, 'Captain Masr');
      assert.equal(first.primaryColor, '#1f3864');
      assert.equal(first.logoUrl, null, 'untouched fields stay null');
      assert.ok(first.updatedAt, 'updatedAt is stamped');

      // A second PATCH that only sets logoUrl should not clobber the
      // systemName from the first call.
      const second = await svc.update({ logoUrl: 'https://cdn.example.com/logo.svg' }, null);
      assert.equal(second.systemName, 'Captain Masr', 'systemName preserved');
      assert.equal(second.primaryColor, '#1f3864', 'primaryColor preserved');
      assert.equal(second.logoUrl, 'https://cdn.example.com/logo.svg');
    });
  });

  it('PATCH with null clears a field', async () => {
    await withCtx(tenantAId, async () => {
      await svc.update({ systemName: 'TempName' }, null);
      const cleared = await svc.update({ systemName: null }, null);
      assert.equal(cleared.systemName, null);
    });
  });

  it('DTO validation rejects javascript: URLs', () => {
    assert.throws(
      () => UpdateTenantBrandingSchema.parse({ logoUrl: 'javascript:alert(1)' }),
      ZodError,
    );
  });

  it('DTO validation rejects data: URLs', () => {
    assert.throws(
      () => UpdateTenantBrandingSchema.parse({ logoUrl: 'data:image/svg+xml,<svg/>' }),
      ZodError,
    );
  });

  it('DTO validation accepts http(s) URLs and relative /paths', () => {
    UpdateTenantBrandingSchema.parse({ logoUrl: 'https://cdn.example.com/logo.svg' });
    UpdateTenantBrandingSchema.parse({ logoUrl: 'http://example.com/logo.svg' });
    UpdateTenantBrandingSchema.parse({ logoUrl: '/logo.svg' });
  });

  it('DTO validation rejects malformed hex colors', () => {
    assert.throws(() => UpdateTenantBrandingSchema.parse({ primaryColor: '1f3864' }), ZodError);
    assert.throws(() => UpdateTenantBrandingSchema.parse({ primaryColor: 'red' }), ZodError);
    assert.throws(() => UpdateTenantBrandingSchema.parse({ primaryColor: '#fff' }), ZodError);
    assert.throws(() => UpdateTenantBrandingSchema.parse({ primaryColor: '#1f3864ff' }), ZodError);
  });

  it('emits a tenant.branding.updated audit row with the changed-fields list', async () => {
    await withCtx(tenantAId, async () => {
      await svc.update({ accentColor: '#ff8000' }, null);
    });
    const row = await withTenantRaw(tenantAId, (tx) =>
      tx.auditEvent.findFirst({
        where: { tenantId: tenantAId, action: 'tenant.branding.updated' },
        orderBy: { createdAt: 'desc' },
      }),
    );
    assert.ok(row, 'one audit row');
    const payload = row!.payload as { changedFields?: string[] };
    assert.ok(Array.isArray(payload.changedFields));
    assert.ok(payload.changedFields!.includes('accentColor'));
  });

  it('tenant B branding does not leak into tenant A reads', async () => {
    await withCtx(tenantBId, async () => {
      await svc.update({ systemName: 'B exclusive', primaryColor: '#abcdef' }, null);
    });
    const aRead = await withCtx(tenantAId, () => svc.getCurrent());
    assert.notEqual(aRead.systemName, 'B exclusive');
    assert.notEqual(aRead.primaryColor, '#abcdef');

    const bRead = await withCtx(tenantBId, () => svc.getCurrent());
    assert.equal(bRead.systemName, 'B exclusive');
    assert.equal(bRead.primaryColor, '#abcdef');
  });
});
