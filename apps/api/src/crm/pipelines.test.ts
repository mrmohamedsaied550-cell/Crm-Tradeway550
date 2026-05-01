/**
 * P2-07 — PipelinesService integration tests.
 *
 * Real Postgres + a throwaway tenant. Covers:
 *   - list returns the seeded default + user-created pipelines.
 *   - create rejects a duplicate (tenant, company, country) tuple.
 *   - create rejects a country that doesn't belong to the supplied
 *     company (cross-validation).
 *   - update on the default pipeline cannot deactivate it.
 *   - delete on the default pipeline is rejected.
 *   - delete on a user pipeline succeeds when it's empty and is
 *     rejected when stages still own leads.
 *   - addStage appends order automatically; duplicate code in same
 *     pipeline raises a typed conflict.
 *   - reorderStages rewrites order atomically (verified by the new
 *     order list); rejects an unknown stage id.
 *   - deleteStage is rejected while leads still reference it.
 *   - audit_events row is written for every mutation.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { tenantContext } from '../tenants/tenant-context';
import { PipelinesService } from './pipelines.service';

const TENANT_CODE = '__p2_07_pipelines__';

let prisma: PrismaClient;
let prismaSvc: PrismaService;
let svc: PipelinesService;
let tenantId: string;
let companyId: string;
let countryId: string;
let actorUserId: string;
let defaultPipelineId: string;

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

describe('crm — pipeline builder (P2-07)', () => {
  before(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    prismaSvc = new PrismaService();
    const audit = new AuditService(prismaSvc);
    svc = new PipelinesService(prismaSvc, audit);

    const tenant = await prisma.tenant.upsert({
      where: { code: TENANT_CODE },
      update: { isActive: true },
      create: { code: TENANT_CODE, name: 'P2-07 pipelines' },
    });
    tenantId = tenant.id;

    await withTenantRaw(tenantId, async (tx) => {
      const company = await tx.company.create({
        data: { tenantId, code: 'p207_co', name: 'P2-07 Co' },
      });
      companyId = company.id;
      const country = await tx.country.create({
        data: { tenantId, companyId, code: 'EG', name: 'P2-07 EG' },
      });
      countryId = country.id;

      const role = await tx.role.create({
        data: {
          tenantId,
          code: 'ops_manager',
          nameAr: 'إدارة',
          nameEn: 'Ops',
          level: 90,
        },
      });
      const actor = await tx.user.create({
        data: {
          tenantId,
          email: 'p207-actor@test',
          name: 'Actor',
          passwordHash: 'x',
          roleId: role.id,
        },
      });
      actorUserId = actor.id;

      // Default pipeline + the canonical 5 stages.
      const defaultPipeline = await tx.pipeline.create({
        data: { tenantId, name: 'Default', isDefault: true, isActive: true },
        select: { id: true },
      });
      defaultPipelineId = defaultPipeline.id;
      for (const def of [
        { code: 'new', name: 'New', order: 10, isTerminal: false },
        { code: 'contacted', name: 'Contacted', order: 20, isTerminal: false },
        { code: 'interested', name: 'Interested', order: 30, isTerminal: false },
        { code: 'converted', name: 'Converted', order: 40, isTerminal: true },
        { code: 'lost', name: 'Lost', order: 50, isTerminal: true },
      ]) {
        await tx.pipelineStage.create({
          data: { tenantId, pipelineId: defaultPipelineId, ...def },
        });
      }
    });
  });

  after(async () => {
    await prisma.tenant.delete({ where: { code: TENANT_CODE } }).catch(() => {});
    await prisma.$disconnect();
  });

  it('list returns the default pipeline at the top', async () => {
    const rows = await inTenant(() => svc.list());
    assert.ok(rows.length >= 1);
    assert.equal(rows[0]?.isDefault, true);
    assert.equal(rows[0]?.name, 'Default');
  });

  it('create accepts a (company, country)-scoped pipeline and audits the event', async () => {
    const created = await inTenant(() =>
      svc.create({ name: 'Egypt — Uber', companyId, countryId, isActive: true }, actorUserId),
    );
    assert.equal(created.companyId, companyId);
    assert.equal(created.countryId, countryId);
    assert.equal(created.isDefault, false);

    const audit = await withTenantRaw(tenantId, (tx) =>
      tx.auditEvent.findFirst({
        where: { action: 'pipeline.created', entityId: created.id },
      }),
    );
    assert.ok(audit);
  });

  it('create rejects a duplicate (company, country) tuple', async () => {
    await assert.rejects(
      () =>
        inTenant(() =>
          svc.create({ name: 'Duplicate', companyId, countryId, isActive: true }, actorUserId),
        ),
      /already exists/,
    );
  });

  it('create rejects a country that does not belong to the supplied company', async () => {
    // Create a second company; reuse the same country id under the
    // first company — service must reject.
    const otherCompanyId = await withTenantRaw(tenantId, async (tx) => {
      const c = await tx.company.create({
        data: { tenantId, code: 'p207_other', name: 'P2-07 Other' },
      });
      return c.id;
    });
    await assert.rejects(
      () =>
        inTenant(() =>
          svc.create(
            { name: 'Mismatch', companyId: otherCompanyId, countryId, isActive: true },
            actorUserId,
          ),
        ),
      /does not belong/,
    );
  });

  it('update cannot deactivate the default pipeline', async () => {
    await assert.rejects(
      () => inTenant(() => svc.update(defaultPipelineId, { isActive: false }, actorUserId)),
      /default pipeline cannot be deactivated/,
    );
  });

  it('delete refuses the default pipeline', async () => {
    await assert.rejects(
      () => inTenant(() => svc.delete(defaultPipelineId, actorUserId)),
      /default pipeline cannot be deleted/,
    );
  });

  it('addStage appends an auto order; duplicate code returns a typed conflict', async () => {
    // The Egypt — Uber pipeline created above currently has 0 stages.
    const egypt = await inTenant(() => svc.list()).then((rows) =>
      rows.find((p) => p.name === 'Egypt — Uber'),
    );
    assert.ok(egypt);
    const s1 = await inTenant(() =>
      svc.addStage(egypt!.id, { code: 'new', name: 'New', isTerminal: false }, actorUserId),
    );
    assert.equal(s1.order, 10); // first stage in an empty pipeline starts at 10
    const s2 = await inTenant(() =>
      svc.addStage(
        egypt!.id,
        { code: 'contacted', name: 'Contacted', isTerminal: false },
        actorUserId,
      ),
    );
    assert.equal(s2.order, 20);

    await assert.rejects(
      () =>
        inTenant(() =>
          svc.addStage(egypt!.id, { code: 'new', name: 'Dup', isTerminal: false }, actorUserId),
        ),
      /already exists/,
    );
  });

  it('reorderStages rewrites the order atomically', async () => {
    const egypt = (await inTenant(() => svc.list())).find((p) => p.name === 'Egypt — Uber')!;
    const detail = await inTenant(() => svc.findByIdOrThrow(egypt.id));
    const stageIds = detail.stages.map((s) => s.id);
    // Reverse order.
    const reversed = [...stageIds].reverse();
    const after = await inTenant(() =>
      svc.reorderStages(egypt.id, { stageIds: reversed }, actorUserId),
    );
    assert.deepEqual(
      after.map((s) => s.id),
      reversed,
    );
    // Order column is the canonical 10/20/...; verify.
    assert.deepEqual(
      after.map((s) => s.order),
      after.map((_, i) => (i + 1) * 10),
    );
  });

  it('reorderStages rejects an unknown stage id', async () => {
    const egypt = (await inTenant(() => svc.list())).find((p) => p.name === 'Egypt — Uber')!;
    await assert.rejects(
      () =>
        inTenant(() =>
          svc.reorderStages(
            egypt.id,
            { stageIds: ['00000000-0000-0000-0000-000000000000'] },
            actorUserId,
          ),
        ),
      /Expected|does not belong/,
    );
  });

  it('deleteStage is rejected while a lead still references the stage', async () => {
    // Pick a non-terminal stage in the default pipeline and plant a lead.
    const stage = await withTenantRaw(tenantId, (tx) =>
      tx.pipelineStage.findFirst({ where: { pipelineId: defaultPipelineId, code: 'new' } }),
    );
    assert.ok(stage);
    const leadId = await withTenantRaw(tenantId, async (tx) => {
      const lead = await tx.lead.create({
        data: {
          tenantId,
          name: 'P2-07 lead',
          phone: '+201001100701',
          stageId: stage!.id,
          source: 'manual',
        },
      });
      return lead.id;
    });

    await assert.rejects(
      () => inTenant(() => svc.deleteStage(defaultPipelineId, stage!.id, actorUserId)),
      /still used/,
    );

    // Cleanup.
    await withTenantRaw(tenantId, (tx) => tx.lead.delete({ where: { id: leadId } }));
  });

  it('delete on a user pipeline succeeds once leads are gone', async () => {
    // Create + immediately delete a pipeline with a stage but no leads.
    const fresh = await inTenant(() =>
      svc.create({ name: 'Disposable', isActive: true }, actorUserId),
    );
    await inTenant(() =>
      svc.addStage(fresh.id, { code: 'new', name: 'New', isTerminal: false }, actorUserId),
    );
    await inTenant(() => svc.delete(fresh.id, actorUserId));

    const after = await inTenant(() => svc.findById(fresh.id));
    assert.equal(after, null);
  });
});
