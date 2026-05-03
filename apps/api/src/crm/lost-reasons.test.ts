/**
 * Phase A — A2: LostReasonsService integration tests.
 *
 * Real Postgres + a throwaway tenant. Verifies:
 *   - listActive returns only active reasons in display order
 *   - listAll returns every reason (active + inactive)
 *   - create rejects duplicate code (P2002 → typed conflict)
 *   - create accepts well-formed payload
 *   - update can change label / order / active state
 *   - update cannot rename code (DTO doesn't expose it)
 *   - update CANNOT deactivate the protected 'other' reason
 *   - update on a missing id returns typed 404
 *   - findActiveByIdInTx returns null for inactive reasons
 *   - RLS: a foreign tenant's reasons are invisible
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { tenantContext } from '../tenants/tenant-context';
import { LostReasonsService } from './lost-reasons.service';

const TENANT_CODE = '__a2_lost_reasons__';
const OTHER_TENANT_CODE = '__a2_lost_reasons_other__';

let prisma: PrismaClient;
let prismaSvc: PrismaService;
let svc: LostReasonsService;
let tenantId: string;
let otherTenantId: string;

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

describe('crm — lost reasons service (A2)', () => {
  before(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    prismaSvc = new PrismaService();
    svc = new LostReasonsService(prismaSvc);

    // Two throwaway tenants. The schema migration's seed runs only
    // for tenants that exist at migration time, so these tenants
    // start empty — we add a couple of reasons in the seed block.
    const tenant = await prisma.tenant.upsert({
      where: { code: TENANT_CODE },
      update: { isActive: true },
      create: { code: TENANT_CODE, name: 'A2 lost reasons' },
    });
    tenantId = tenant.id;
    const other = await prisma.tenant.upsert({
      where: { code: OTHER_TENANT_CODE },
      update: { isActive: true },
      create: { code: OTHER_TENANT_CODE, name: 'A2 other tenant' },
    });
    otherTenantId = other.id;

    // Seed 4 reasons including the protected 'other' so the
    // deactivation-guard tests have a target. Plus one inactive row
    // so listActive() vs listAll() is distinguishable.
    await withTenantRaw(tenantId, async (tx) => {
      for (const r of [
        { code: 'no_vehicle', labelEn: 'No vehicle', labelAr: 'لا توجد مركبة', displayOrder: 10 },
        {
          code: 'wrong_phone',
          labelEn: 'Wrong phone',
          labelAr: 'رقم خاطئ',
          displayOrder: 20,
        },
        {
          code: 'inactive_one',
          labelEn: 'Inactive',
          labelAr: 'غير نشط',
          displayOrder: 30,
          isActive: false,
        },
        { code: 'other', labelEn: 'Other', labelAr: 'أخرى', displayOrder: 70 },
      ]) {
        await tx.lostReason.create({ data: { tenantId, ...r } });
      }
    });
    await withTenantRaw(otherTenantId, async (tx) => {
      await tx.lostReason.create({
        data: {
          tenantId: otherTenantId,
          code: 'foreign_only',
          labelEn: 'Foreign',
          labelAr: 'أجنبي',
        },
      });
    });
  });

  after(async () => {
    await prisma.tenant.delete({ where: { code: TENANT_CODE } }).catch(() => {});
    await prisma.tenant.delete({ where: { code: OTHER_TENANT_CODE } }).catch(() => {});
    await prisma.$disconnect();
  });

  it('listActive returns active reasons in displayOrder', async () => {
    const r = await inTenant(() => svc.listActive());
    const codes = r.map((x) => x.code);
    assert.deepEqual(codes, ['no_vehicle', 'wrong_phone', 'other']);
  });

  it('listAll returns active + inactive', async () => {
    const r = await inTenant(() => svc.listAll());
    const codes = r.map((x) => x.code).sort();
    assert.deepEqual(codes, ['inactive_one', 'no_vehicle', 'other', 'wrong_phone'].sort());
  });

  it('create accepts a well-formed payload', async () => {
    const r = await inTenant(() =>
      svc.create({
        code: 'duplicate',
        labelEn: 'Duplicate',
        labelAr: 'مكرر',
        isActive: true,
        displayOrder: 60,
      }),
    );
    assert.equal(r.code, 'duplicate');
    assert.equal(r.isActive, true);
  });

  it('create rejects a duplicate code with typed conflict', async () => {
    await assert.rejects(
      () =>
        inTenant(() =>
          svc.create({
            code: 'no_vehicle',
            labelEn: 'X',
            labelAr: 'س',
            isActive: true,
            displayOrder: 100,
          }),
        ),
      (err: { response?: { code?: string } } & Error) => {
        assert.equal(err.response?.code, 'lost_reason.code_already_exists');
        return true;
      },
    );
  });

  it('update changes label + order', async () => {
    const list = await inTenant(() => svc.listAll());
    const noVehicle = list.find((r) => r.code === 'no_vehicle')!;
    const updated = await inTenant(() =>
      svc.update(noVehicle.id, { labelEn: 'No car', displayOrder: 5 }),
    );
    assert.equal(updated.labelEn, 'No car');
    assert.equal(updated.displayOrder, 5);
    assert.equal(updated.code, 'no_vehicle'); // unchanged
  });

  it('update can deactivate a non-protected reason', async () => {
    const list = await inTenant(() => svc.listAll());
    const wrongPhone = list.find((r) => r.code === 'wrong_phone')!;
    const updated = await inTenant(() => svc.update(wrongPhone.id, { isActive: false }));
    assert.equal(updated.isActive, false);
  });

  it('update CANNOT deactivate the protected "other" reason', async () => {
    const list = await inTenant(() => svc.listAll());
    const other = list.find((r) => r.code === 'other')!;
    await assert.rejects(
      () => inTenant(() => svc.update(other.id, { isActive: false })),
      (err: { response?: { code?: string } } & Error) => {
        assert.equal(err.response?.code, 'lost_reason.protected_cannot_deactivate');
        return true;
      },
    );
  });

  it('update of unknown id throws typed 404', async () => {
    await assert.rejects(
      () => inTenant(() => svc.update('00000000-0000-0000-0000-000000000000', { labelEn: 'x' })),
      (err: { response?: { code?: string } } & Error) => {
        assert.equal(err.response?.code, 'lost_reason.not_found');
        return true;
      },
    );
  });

  it('findActiveByIdInTx skips inactive reasons', async () => {
    const list = await inTenant(() => svc.listAll());
    const inactive = list.find((r) => r.code === 'inactive_one')!;
    const r = await inTenant(() =>
      prismaSvc.withTenant(tenantId, (tx) => svc.findActiveByIdInTx(tx, inactive.id)),
    );
    assert.equal(r, null);
  });

  it('findActiveByIdInTx returns active reason', async () => {
    const list = await inTenant(() => svc.listAll());
    const other = list.find((r) => r.code === 'other')!;
    const r = await inTenant(() =>
      prismaSvc.withTenant(tenantId, (tx) => svc.findActiveByIdInTx(tx, other.id)),
    );
    assert.ok(r);
    assert.equal(r!.code, 'other');
  });

  it('RLS isolates reasons across tenants', async () => {
    const here = await inTenant(() => svc.listAll());
    assert.ok(!here.some((r) => r.code === 'foreign_only'));

    const there = await tenantContext.run(
      { tenantId: otherTenantId, tenantCode: OTHER_TENANT_CODE, source: 'header' },
      () => svc.listAll(),
    );
    assert.equal(there.length, 1);
    assert.equal(there[0]!.code, 'foreign_only');
  });
});
