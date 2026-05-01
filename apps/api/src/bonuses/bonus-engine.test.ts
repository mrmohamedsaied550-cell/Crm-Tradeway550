/**
 * P2-03 — BonusEngine integration tests.
 *
 * Real Postgres + a throwaway tenant so the FORCE'd RLS path is
 * exercised. Covers the four MVP behaviours:
 *   1. activation fires every matching active rule once.
 *   2. inactive rules don't fire.
 *   3. rule-team scoping: rule.teamId set → only captains in that team.
 *   4. idempotency: a second run on the same captain is a no-op.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Prisma, PrismaClient } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { BonusEngine } from './bonus-engine.service';
import { PrismaService } from '../prisma/prisma.service';

const TENANT_CODE = '__p2_03_bonus_engine__';

let prisma: PrismaClient;
let prismaSvc: PrismaService;
let engine: BonusEngine;
let tenantId: string;
let companyId: string;
let countryId: string;
let teamAId: string;
let teamBId: string;
let recipientUserId: string;
let captainAId: string; // teamA
let captainBId: string; // teamB

async function withTenantRaw<T>(tid: string, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return prisma.$transaction(async (tx: any) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.tenant_id = '${tid}'`);
    return fn(tx);
  });
}

describe('bonuses — engine (P2-03)', () => {
  before(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    prismaSvc = new PrismaService();
    engine = new BonusEngine(new AuditService(prismaSvc));

    const tenant = await prisma.tenant.upsert({
      where: { code: TENANT_CODE },
      update: { isActive: true },
      create: { code: TENANT_CODE, name: 'P2-03 bonus engine' },
    });
    tenantId = tenant.id;

    await withTenantRaw(tenantId, async (tx) => {
      const company = await tx.company.create({
        data: { tenantId, code: 'p203_co', name: 'P2-03 Co' },
      });
      companyId = company.id;
      const country = await tx.country.create({
        data: { tenantId, companyId, code: 'EG', name: 'P2-03 EG' },
      });
      countryId = country.id;
      const teamA = await tx.team.create({
        data: { tenantId, countryId, name: 'P2-03 Team A' },
      });
      teamAId = teamA.id;
      const teamB = await tx.team.create({
        data: { tenantId, countryId, name: 'P2-03 Team B' },
      });
      teamBId = teamB.id;

      const role = await tx.role.create({
        data: {
          tenantId,
          code: 'sales_agent',
          nameAr: 'وكيل',
          nameEn: 'Sales Agent',
          level: 30,
        },
      });

      const recipient = await tx.user.create({
        data: {
          tenantId,
          email: 'p203-recipient@test',
          name: 'Recipient',
          passwordHash: 'x',
          roleId: role.id,
        },
      });
      recipientUserId = recipient.id;

      // A planted lead per team so the captain create can satisfy
      // the captain ↔ lead unique.
      const pipeline = await tx.pipeline.create({
        data: { tenantId, name: 'Default', isDefault: true, isActive: true },
      });
      const stage = await tx.pipelineStage.create({
        data: {
          tenantId,
          pipelineId: pipeline.id,
          code: 'new',
          name: 'New',
          order: 10,
          isTerminal: false,
        },
      });
      const leadA = await tx.lead.create({
        data: {
          tenantId,
          stageId: stage.id,
          name: 'Lead A',
          phone: '+201001100501',
          source: 'manual',
        },
      });
      const leadB = await tx.lead.create({
        data: {
          tenantId,
          stageId: stage.id,
          name: 'Lead B',
          phone: '+201001100502',
          source: 'manual',
        },
      });
      const captainA = await tx.captain.create({
        data: {
          tenantId,
          leadId: leadA.id,
          name: 'Cap A',
          phone: '+201001100501',
          teamId: teamAId,
        },
      });
      const captainB = await tx.captain.create({
        data: {
          tenantId,
          leadId: leadB.id,
          name: 'Cap B',
          phone: '+201001100502',
          teamId: teamBId,
        },
      });
      captainAId = captainA.id;
      captainBId = captainB.id;
    });
  });

  after(async () => {
    await prisma.tenant.delete({ where: { code: TENANT_CODE } }).catch(() => {});
    await prisma.$disconnect();
  });

  it('fires a matching tenant-wide activation rule and writes one accrual', async () => {
    await withTenantRaw(tenantId, async (tx) => {
      await tx.bonusRule.create({
        data: {
          tenantId,
          companyId,
          countryId,
          bonusType: 'activation',
          trigger: 'first activation',
          amount: new Prisma.Decimal('50.00'),
        },
      });
    });

    await prismaSvc.withTenant(tenantId, (tx) =>
      engine.onActivationInTx(tx, tenantId, {
        captainId: captainAId,
        captainTeamId: teamAId,
        recipientUserId,
        actorUserId: null,
      }),
    );

    const accruals = await withTenantRaw(tenantId, (tx) =>
      tx.bonusAccrual.findMany({
        where: { captainId: captainAId, recipientUserId },
      }),
    );
    assert.equal(accruals.length, 1);
    assert.equal(accruals[0]?.triggerKind, 'activation');
    assert.equal(accruals[0]?.status, 'pending');
    assert.equal(accruals[0]?.amount.toString(), '50');
  });

  it('skips inactive rules', async () => {
    await withTenantRaw(tenantId, async (tx) => {
      await tx.bonusRule.create({
        data: {
          tenantId,
          companyId,
          countryId,
          bonusType: 'activation',
          trigger: 'inactive rule',
          amount: new Prisma.Decimal('99.00'),
          isActive: false,
        },
      });
    });

    const before = await withTenantRaw(tenantId, (tx) =>
      tx.bonusAccrual.count({ where: { captainId: captainBId } }),
    );
    await prismaSvc.withTenant(tenantId, (tx) =>
      engine.onActivationInTx(tx, tenantId, {
        captainId: captainBId,
        captainTeamId: teamBId,
        recipientUserId,
        actorUserId: null,
      }),
    );
    const after = await withTenantRaw(tenantId, (tx) =>
      tx.bonusAccrual.count({ where: { captainId: captainBId } }),
    );
    // The tenant-wide rule from the prior test still fires (no team
    // filter), but the inactive rule does not. Difference must be 1.
    assert.equal(after - before, 1);
  });

  it('respects rule.teamId — only fires for matching team captains', async () => {
    await withTenantRaw(tenantId, async (tx) => {
      await tx.bonusRule.create({
        data: {
          tenantId,
          companyId,
          countryId,
          teamId: teamAId,
          bonusType: 'activation',
          trigger: 'team-A only',
          amount: new Prisma.Decimal('25.00'),
        },
      });
    });

    // captainAId (teamA) should pick the new team-A rule (one new accrual).
    // captainBId (teamB) should NOT.
    const beforeA = await withTenantRaw(tenantId, (tx) =>
      tx.bonusAccrual.count({ where: { captainId: captainAId } }),
    );
    const beforeB = await withTenantRaw(tenantId, (tx) =>
      tx.bonusAccrual.count({ where: { captainId: captainBId } }),
    );
    await prismaSvc.withTenant(tenantId, (tx) =>
      engine.onActivationInTx(tx, tenantId, {
        captainId: captainAId,
        captainTeamId: teamAId,
        recipientUserId,
        actorUserId: null,
      }),
    );
    await prismaSvc.withTenant(tenantId, (tx) =>
      engine.onActivationInTx(tx, tenantId, {
        captainId: captainBId,
        captainTeamId: teamBId,
        recipientUserId,
        actorUserId: null,
      }),
    );
    const afterA = await withTenantRaw(tenantId, (tx) =>
      tx.bonusAccrual.count({ where: { captainId: captainAId } }),
    );
    const afterB = await withTenantRaw(tenantId, (tx) =>
      tx.bonusAccrual.count({ where: { captainId: captainBId } }),
    );
    // Captain A picks up the new team-A rule (delta 1).
    assert.equal(afterA - beforeA, 1);
    // Captain B's run is idempotent against the (already fired)
    // tenant-wide rule, so delta is 0.
    assert.equal(afterB - beforeB, 0);
  });

  it('is idempotent — re-running on the same captain does nothing', async () => {
    const before = await withTenantRaw(tenantId, (tx) =>
      tx.bonusAccrual.count({ where: { captainId: captainAId } }),
    );
    await prismaSvc.withTenant(tenantId, (tx) =>
      engine.onActivationInTx(tx, tenantId, {
        captainId: captainAId,
        captainTeamId: teamAId,
        recipientUserId,
        actorUserId: null,
      }),
    );
    const after = await withTenantRaw(tenantId, (tx) =>
      tx.bonusAccrual.count({ where: { captainId: captainAId } }),
    );
    assert.equal(after, before);
  });
});
