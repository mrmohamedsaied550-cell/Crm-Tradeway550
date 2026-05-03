/**
 * P3-04 — calendar feed tests.
 *
 * Wires FollowUpsService against a throwaway tenant (mirroring the
 * pattern used by leads.test.ts). Each test asserts a different
 * dimension of `listInRange`:
 *   - the date window is inclusive at both ends,
 *   - `mine='1'` (default) returns only the caller's rows,
 *   - `mine='0'` (with allowAllAssignees) returns everyone in tenant,
 *   - the lead join carries name + phone for calendar labels.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { hashPassword } from '../identity/password.util';
import { tenantContext } from '../tenants/tenant-context';
import { TenantSettingsService } from '../tenants/tenant-settings.service';
import { PIPELINE_STAGE_DEFINITIONS } from '../crm/pipeline.registry';
import { FollowUpsService } from './follow-ups.service';

const TENANT_CODE = '__p3_04_calendar__';

let prisma: PrismaClient;
let prismaSvc: PrismaService;
let svc: FollowUpsService;
let tenantId: string;
let aliceId: string;
let bobId: string;
let leadId: string;

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

describe('FollowUpsService.listInRange (P3-04 calendar)', () => {
  before(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    prismaSvc = new PrismaService();
    const audit = new AuditService(prismaSvc);
    const notifications = new NotificationsService(prismaSvc);
    const tenantSettings = new TenantSettingsService(prismaSvc, audit);
    svc = new FollowUpsService(prismaSvc, audit, notifications, tenantSettings);

    const tenant = await prisma.tenant.upsert({
      where: { code: TENANT_CODE },
      update: { isActive: true },
      create: { code: TENANT_CODE, name: 'P3-04 calendar test tenant' },
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
    const alice = await withTenantRaw(tenantId, (tx) =>
      tx.user.upsert({
        where: { tenantId_email: { tenantId, email: '__p304_alice@test' } },
        update: {},
        create: {
          tenantId,
          email: '__p304_alice@test',
          name: 'Alice',
          passwordHash: hash,
          roleId: role.id,
        },
      }),
    );
    aliceId = alice.id;
    const bob = await withTenantRaw(tenantId, (tx) =>
      tx.user.upsert({
        where: { tenantId_email: { tenantId, email: '__p304_bob@test' } },
        update: {},
        create: {
          tenantId,
          email: '__p304_bob@test',
          name: 'Bob',
          passwordHash: hash,
          roleId: role.id,
        },
      }),
    );
    bobId = bob.id;

    // Pipeline + lead so the follow-up FK is satisfied.
    await withTenantRaw(tenantId, async (tx) => {
      const existing = await tx.pipeline.findFirst({
        where: { tenantId, isDefault: true },
        select: { id: true },
      });
      const pipelineId =
        existing?.id ??
        (
          await tx.pipeline.create({
            data: { tenantId, name: 'Default', isDefault: true, isActive: true },
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
      const stage = await tx.pipelineStage.findFirstOrThrow({
        where: { pipelineId, code: 'new' },
        select: { id: true },
      });
      const lead = await tx.lead.create({
        data: {
          tenantId,
          name: 'Calendar Lead',
          phone: '+201009999000',
          source: 'manual',
          stageId: stage.id,
          assignedToId: aliceId,
        },
      });
      leadId = lead.id;
    });
  });

  after(async () => {
    await prisma.tenant.delete({ where: { code: TENANT_CODE } }).catch(() => {});
    await prisma.$disconnect();
  });

  it('returns rows inside the [from, to] window only, joined with lead name/phone', async () => {
    // Three follow-ups: yesterday, today, two months out
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const today = new Date();
    const future = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);

    await inTenant(() =>
      svc.create(leadId, { actionType: 'call', dueAt: yesterday.toISOString() }, aliceId),
    );
    await inTenant(() =>
      svc.create(leadId, { actionType: 'whatsapp', dueAt: today.toISOString() }, aliceId),
    );
    await inTenant(() =>
      svc.create(leadId, { actionType: 'visit', dueAt: future.toISOString() }, aliceId),
    );

    const from = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString(); // 36h ago
    const to = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(); // 12h from now

    const items = await inTenant(() =>
      svc.listInRange(aliceId, { from, to, mine: '1', limit: 100, allowAllAssignees: true }),
    );

    // Should see yesterday + today, not the future event.
    assert.equal(items.length, 2, `expected 2 in window, got ${items.length}`);
    for (const it of items) {
      assert.ok(it.lead, 'lead join must be present');
      assert.equal(it.lead?.name, 'Calendar Lead');
      assert.equal(it.lead?.phone, '+201009999000');
    }
  });

  it('mine="1" hides another assignee; mine="0" includes them', async () => {
    const t = new Date();
    const from = new Date(t.getTime() - 60 * 60 * 1000).toISOString();
    const to = new Date(t.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

    // Create a follow-up assigned to Bob, separate from Alice's.
    await inTenant(() =>
      svc.create(
        leadId,
        {
          actionType: 'call',
          dueAt: new Date(t.getTime() + 2 * 60 * 60 * 1000).toISOString(),
          assignedToId: bobId,
        },
        aliceId,
      ),
    );

    const aliceOnly = await inTenant(() =>
      svc.listInRange(aliceId, { from, to, mine: '1', limit: 200, allowAllAssignees: true }),
    );
    assert.ok(
      aliceOnly.every((f) => f.assignedToId === aliceId),
      'mine=1 must filter to caller',
    );

    const everyone = await inTenant(() =>
      svc.listInRange(aliceId, { from, to, mine: '0', limit: 200, allowAllAssignees: true }),
    );
    assert.ok(
      everyone.some((f) => f.assignedToId === bobId),
      'mine=0 must include Bob',
    );
  });

  it('mine="0" is downgraded when allowAllAssignees=false', async () => {
    const t = new Date();
    const from = new Date(t.getTime() - 60 * 60 * 1000).toISOString();
    const to = new Date(t.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

    const items = await inTenant(() =>
      svc.listInRange(aliceId, { from, to, mine: '0', limit: 200, allowAllAssignees: false }),
    );
    assert.ok(
      items.every((f) => f.assignedToId === aliceId),
      'allowAllAssignees=false must keep the caller scope even with mine=0',
    );
  });
});
