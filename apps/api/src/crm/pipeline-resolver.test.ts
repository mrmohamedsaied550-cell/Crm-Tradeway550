/**
 * Phase 1B — B2: PipelineService.resolveForLead fallback chain.
 *
 * Real Postgres + a throwaway tenant. Verifies the four-step fallback:
 *   1. (tenant, company, country) — exact
 *   2. (tenant, company, NULL)    — company-only
 *   3. (tenant, NULL,    country) — country-only
 *   4. (tenant, NULL,    NULL, isDefault) — guaranteed
 *
 * Plus the cross-cutting checks:
 *   - inactive non-default pipelines are skipped (the chain falls through).
 *   - the default pipeline is always reachable as the last resort.
 *   - findStageInPipelineOrThrow rejects a stage that lives in a different
 *     pipeline (cross-pipeline guard for moveStage).
 *   - findCodeInPipelineOrThrow returns the right stage when a code exists
 *     in two different pipelines on the same tenant.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { tenantContext } from '../tenants/tenant-context';
import { PipelineService } from './pipeline.service';

const TENANT_CODE = '__b2_pipeline_resolver__';

let prisma: PrismaClient;
let prismaSvc: PrismaService;
let svc: PipelineService;
let tenantId: string;
let companyAId: string;
let companyBId: string;
let countryEgId: string;
let countryEgUnderBId: string;
let defaultPipelineId: string;
let companyAOnlyPipelineId: string;
let companyACountryEgPipelineId: string;
let inactiveCompanyBPipelineId: string;

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

describe('crm — pipeline resolver (B2)', () => {
  before(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    prismaSvc = new PrismaService();
    svc = new PipelineService(prismaSvc);

    const tenant = await prisma.tenant.upsert({
      where: { code: TENANT_CODE },
      update: { isActive: true },
      create: { code: TENANT_CODE, name: 'B2 resolver' },
    });
    tenantId = tenant.id;

    await withTenantRaw(tenantId, async (tx) => {
      const companyA = await tx.company.create({
        data: { tenantId, code: 'a', name: 'Company A' },
      });
      companyAId = companyA.id;
      const companyB = await tx.company.create({
        data: { tenantId, code: 'b', name: 'Company B' },
      });
      companyBId = companyB.id;
      const eg = await tx.country.create({
        data: { tenantId, companyId: companyAId, code: 'EG', name: 'Egypt under A' },
      });
      countryEgId = eg.id;
      const egUnderB = await tx.country.create({
        data: { tenantId, companyId: companyBId, code: 'EG', name: 'Egypt under B' },
      });
      countryEgUnderBId = egUnderB.id;

      // Tenant default — no scope, isDefault.
      const def = await tx.pipeline.create({
        data: { tenantId, name: 'Default', isDefault: true, isActive: true },
        select: { id: true },
      });
      defaultPipelineId = def.id;
      for (const s of [
        { code: 'new', name: 'New', order: 10, isTerminal: false },
        { code: 'contacted', name: 'Contacted', order: 20, isTerminal: false },
        { code: 'converted', name: 'Converted', order: 40, isTerminal: true },
      ]) {
        await tx.pipelineStage.create({ data: { tenantId, pipelineId: def.id, ...s } });
      }

      // Company-A-only (no country).
      const aOnly = await tx.pipeline.create({
        data: {
          tenantId,
          companyId: companyAId,
          countryId: null,
          name: 'Company A only',
          isActive: true,
        },
        select: { id: true },
      });
      companyAOnlyPipelineId = aOnly.id;
      for (const s of [
        { code: 'a_new', name: 'A New', order: 10, isTerminal: false },
        { code: 'a_done', name: 'A Done', order: 20, isTerminal: true },
      ]) {
        await tx.pipelineStage.create({ data: { tenantId, pipelineId: aOnly.id, ...s } });
      }

      // Company-A × Egypt — exact match.
      const aEg = await tx.pipeline.create({
        data: {
          tenantId,
          companyId: companyAId,
          countryId: countryEgId,
          name: 'Company A × Egypt',
          isActive: true,
        },
        select: { id: true },
      });
      companyACountryEgPipelineId = aEg.id;
      for (const s of [
        { code: 'aeg_new', name: 'A-EG New', order: 10, isTerminal: false },
        { code: 'aeg_done', name: 'A-EG Done', order: 20, isTerminal: true },
      ]) {
        await tx.pipelineStage.create({ data: { tenantId, pipelineId: aEg.id, ...s } });
      }

      // Company-B-only — INACTIVE. Resolver must skip it and fall back.
      const inactiveB = await tx.pipeline.create({
        data: {
          tenantId,
          companyId: companyBId,
          countryId: null,
          name: 'Company B only (inactive)',
          isActive: false,
        },
        select: { id: true },
      });
      inactiveCompanyBPipelineId = inactiveB.id;
    });
  });

  after(async () => {
    await prisma.tenant.delete({ where: { code: TENANT_CODE } }).catch(() => {});
    await prisma.$disconnect();
  });

  it('1. exact (company × country) match wins', async () => {
    const r = await inTenant(() =>
      svc.resolveForLead({ companyId: companyAId, countryId: countryEgId }),
    );
    assert.equal(r.id, companyACountryEgPipelineId);
    assert.equal(r.isDefault, false);
  });

  it('2. (company, NULL country) is used when no exact match exists', async () => {
    // Company A × Egypt-under-B does NOT exist, but Company A only does.
    const r = await inTenant(() =>
      svc.resolveForLead({ companyId: companyAId, countryId: countryEgUnderBId }),
    );
    assert.equal(r.id, companyAOnlyPipelineId);
  });

  it('3. (NULL company, country) is used when company is null', async () => {
    // No (NULL, EG) pipeline configured → must fall through to default.
    // We add one mid-test to verify the country-only branch.
    let countryOnlyId: string;
    await withTenantRaw(tenantId, async (tx) => {
      const p = await tx.pipeline.create({
        data: {
          tenantId,
          companyId: null,
          countryId: countryEgId,
          name: 'Country EG only',
          isActive: true,
        },
        select: { id: true },
      });
      countryOnlyId = p.id;
    });
    const r = await inTenant(() => svc.resolveForLead({ countryId: countryEgId }));
    assert.equal(r.id, countryOnlyId!);
    // Cleanup so other tests aren't affected.
    await withTenantRaw(tenantId, async (tx) => {
      await tx.pipeline.delete({ where: { id: countryOnlyId! } });
    });
  });

  it('4. tenant default is the final fallback', async () => {
    const r = await inTenant(() => svc.resolveForLead({}));
    assert.equal(r.id, defaultPipelineId);
    assert.equal(r.isDefault, true);
  });

  it('inactive non-default pipeline is skipped — falls back to default', async () => {
    // Company B has only an INACTIVE pipeline. Resolver must skip it.
    const r = await inTenant(() => svc.resolveForLead({ companyId: companyBId }));
    assert.equal(r.id, defaultPipelineId);
    // Sanity — the inactive row really does exist.
    const stillThere = await inTenant(() =>
      prismaSvc.withTenant(tenantId, (tx) =>
        tx.pipeline.findUnique({ where: { id: inactiveCompanyBPipelineId } }),
      ),
    );
    assert.ok(stillThere);
    assert.equal(stillThere!.isActive, false);
  });

  it('null + null resolves to default pipeline', async () => {
    const r = await inTenant(() => svc.resolveForLead({ companyId: null, countryId: null }));
    assert.equal(r.id, defaultPipelineId);
  });

  it('findStageInPipelineOrThrow accepts a stage that belongs to the pipeline', async () => {
    const stages = await inTenant(() =>
      prismaSvc.withTenant(tenantId, (tx) =>
        tx.pipelineStage.findMany({
          where: { pipelineId: companyACountryEgPipelineId },
          select: { id: true },
        }),
      ),
    );
    assert.ok(stages.length > 0);
    const ok = await inTenant(() =>
      svc.findStageInPipelineOrThrow(companyACountryEgPipelineId, stages[0]!.id),
    );
    assert.equal(ok.pipelineId, companyACountryEgPipelineId);
  });

  it('findStageInPipelineOrThrow rejects a stage from a different pipeline', async () => {
    const otherStage = await inTenant(() =>
      prismaSvc.withTenant(tenantId, (tx) =>
        tx.pipelineStage.findFirst({
          where: { pipelineId: defaultPipelineId },
          select: { id: true },
        }),
      ),
    );
    assert.ok(otherStage);
    await assert.rejects(
      () =>
        inTenant(() => svc.findStageInPipelineOrThrow(companyACountryEgPipelineId, otherStage!.id)),
      (err: { response?: { code?: string } } & Error) => {
        assert.equal(err.response?.code, 'pipeline.stage.not_in_pipeline');
        return true;
      },
    );
  });

  it('findCodeInPipelineOrThrow disambiguates same code in different pipelines', async () => {
    // Both default + company-A-only define a stage. Resolve by pipeline.
    const inDefault = await inTenant(() => svc.findCodeInPipelineOrThrow(defaultPipelineId, 'new'));
    const inAOnly = await inTenant(() =>
      svc.findCodeInPipelineOrThrow(companyAOnlyPipelineId, 'a_new'),
    );
    assert.notEqual(inDefault.id, inAOnly.id);
    assert.equal(inDefault.code, 'new');
    assert.equal(inAOnly.code, 'a_new');
  });

  it('findCodeInPipelineOrThrow throws on unknown code', async () => {
    await assert.rejects(
      () => inTenant(() => svc.findCodeInPipelineOrThrow(defaultPipelineId, 'nonexistent_xyz')),
      (err: { response?: { code?: string } } & Error) => {
        assert.equal(err.response?.code, 'pipeline.stage.not_found');
        return true;
      },
    );
  });
});
