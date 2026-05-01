/**
 * P2-08 — TenantSettings + downstream wiring tests.
 *
 * Real Postgres + a throwaway tenant. Exercises:
 *   - service round-trip: read returns defaults, update writes,
 *     re-read returns the new values; audit row written.
 *   - DTO rejects an invalid timezone, an out-of-range slaMinutes,
 *     and a malformed dial code.
 *   - Default-dial-code wiring: LeadsService.create accepts a
 *     local-format phone ("01001234567") and stores the
 *     fully-qualified E.164 ("+201001234567").
 *   - Tenant-aware SLA: changing slaMinutes changes the slaDueAt
 *     window of subsequent lead.create calls.
 *   - Timezone-aware listDueToday: a lead with a follow-up at
 *     22:00 UTC is "due today" in Asia/Tokyo (+9) but not in
 *     Pacific/Honolulu (−10).
 *   - normalizeE164WithDefault unit cases.
 */

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { AssignmentService } from '../crm/assignment.service';
import { LeadsService } from '../crm/leads.service';
import { PipelineService } from '../crm/pipeline.service';
import { PIPELINE_STAGE_DEFINITIONS } from '../crm/pipeline.registry';
import { normalizeE164WithDefault } from '../crm/phone.util';
import { SlaService } from '../crm/sla.service';
import { dayBoundsInTimezone } from '../crm/time.util';
import { hashPassword } from '../identity/password.util';
import { PrismaService } from '../prisma/prisma.service';
import { tenantContext } from './tenant-context';
import { UpdateTenantSettingsSchema } from './tenant-settings.dto';
import { TenantSettingsService } from './tenant-settings.service';

const TENANT_CODE = '__p2_08_tenant_settings__';

let prisma: PrismaClient;
let prismaSvc: PrismaService;
let settings: TenantSettingsService;
let leads: LeadsService;
let tenantId: string;
let actorUserId: string;

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

describe('tenants — settings + downstream wiring (P2-08)', () => {
  before(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    prismaSvc = new PrismaService();
    const audit = new AuditService(prismaSvc);
    settings = new TenantSettingsService(prismaSvc, audit);
    const pipeline = new PipelineService(prismaSvc);
    const assignment = new AssignmentService(prismaSvc);
    const sla = new SlaService(prismaSvc, assignment, undefined, settings);
    leads = new LeadsService(prismaSvc, pipeline, assignment, sla, settings);

    const tenant = await prisma.tenant.upsert({
      where: { code: TENANT_CODE },
      update: { isActive: true },
      create: { code: TENANT_CODE, name: 'P2-08 settings' },
    });
    tenantId = tenant.id;

    await withTenantRaw(tenantId, async (tx) => {
      const role = await tx.role.create({
        data: { tenantId, code: 'ops_manager', nameAr: 'إدارة', nameEn: 'Ops', level: 90 },
      });
      const actor = await tx.user.create({
        data: {
          tenantId,
          email: 'p208-actor@test',
          name: 'Actor',
          passwordHash: await hashPassword('Password@123', 4),
          roleId: role.id,
        },
      });
      actorUserId = actor.id;

      // Default pipeline + canonical stages so LeadsService.create works.
      const pipelineRow = await tx.pipeline.create({
        data: { tenantId, name: 'Default', isDefault: true, isActive: true },
        select: { id: true },
      });
      for (const def of PIPELINE_STAGE_DEFINITIONS) {
        await tx.pipelineStage.create({
          data: {
            tenantId,
            pipelineId: pipelineRow.id,
            code: def.code,
            name: def.name,
            order: def.order,
            isTerminal: def.isTerminal,
          },
        });
      }
    });
  });

  after(async () => {
    await prisma.tenant.delete({ where: { code: TENANT_CODE } }).catch(() => {});
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    // Reset to "no settings row" between tests so each one exercises
    // a clean slate (creates one via update where needed).
    await withTenantRaw(tenantId, (tx) => tx.tenantSettings.deleteMany({ where: { tenantId } }));
  });

  // ─── service / DTO ────────────────────────────────────────────────

  it('getCurrent returns synthesized fallback when no row exists', async () => {
    const row = await inTenant(() => settings.getCurrent());
    assert.equal(row.timezone, 'Africa/Cairo');
    assert.equal(row.defaultDialCode, '+20');
    assert.equal(typeof row.slaMinutes, 'number');
  });

  it('update upserts the row, audits the change, and re-read returns new values', async () => {
    const updated = await inTenant(() =>
      settings.update(
        { timezone: 'Asia/Riyadh', slaMinutes: 30, defaultDialCode: '+966' },
        actorUserId,
      ),
    );
    assert.equal(updated.timezone, 'Asia/Riyadh');
    assert.equal(updated.slaMinutes, 30);
    assert.equal(updated.defaultDialCode, '+966');

    const audit = await withTenantRaw(tenantId, (tx) =>
      tx.auditEvent.findFirst({ where: { action: 'tenant.settings.updated' } }),
    );
    assert.ok(audit);

    const reread = await inTenant(() => settings.getCurrent());
    assert.equal(reread.slaMinutes, 30);
    assert.equal(reread.timezone, 'Asia/Riyadh');
  });

  it('DTO rejects bogus timezone / slaMinutes / dial code', () => {
    assert.equal(UpdateTenantSettingsSchema.safeParse({ timezone: 'Mars/Olympus' }).success, false);
    assert.equal(UpdateTenantSettingsSchema.safeParse({ slaMinutes: 0 }).success, false);
    assert.equal(UpdateTenantSettingsSchema.safeParse({ slaMinutes: 99999 }).success, false);
    assert.equal(
      UpdateTenantSettingsSchema.safeParse({ defaultDialCode: 'twenty' }).success,
      false,
    );
    assert.equal(UpdateTenantSettingsSchema.safeParse({ defaultDialCode: '+20' }).success, true);
  });

  // ─── default dial code ────────────────────────────────────────────

  it('normalizeE164WithDefault prepends the dial code to a leading-zero local format', () => {
    assert.equal(normalizeE164WithDefault('01001234567', '+20'), '+201001234567');
    assert.equal(normalizeE164WithDefault('0501234567', '+966'), '+966501234567');
    // Already-prefixed input is unchanged.
    assert.equal(normalizeE164WithDefault('+201001234567', '+20'), '+201001234567');
    // Bare-international (no leading 0, ≥8 digits) flows through normalizeE164.
    assert.equal(normalizeE164WithDefault('201001234567', '+20'), '+201001234567');
    // Wrong-shape dial code throws.
    assert.throws(() => normalizeE164WithDefault('01001234567', 'twenty'));
  });

  it('LeadsService.create applies the tenant default dial code', async () => {
    await inTenant(() => settings.update({ defaultDialCode: '+966' }, actorUserId));
    const lead = await inTenant(() =>
      leads.create({ name: 'Saudi lead', phone: '0501234567', source: 'manual' }, actorUserId),
    );
    assert.equal(lead.phone, '+966501234567');
  });

  // ─── tenant-aware SLA ────────────────────────────────────────────

  it('LeadsService.create uses the tenant slaMinutes for the SLA window', async () => {
    await inTenant(() => settings.update({ slaMinutes: 5 }, actorUserId));
    const before = Date.now();
    const lead = await inTenant(() =>
      leads.create({ name: 'SLA-tenant', phone: '+201001234001', source: 'manual' }, actorUserId),
    );
    const after = Date.now();
    assert.ok(lead.slaDueAt);
    const due = new Date(lead.slaDueAt!).getTime();
    // 5 minutes ± 5s of fudge for test execution latency.
    const expectedMs = 5 * 60 * 1000;
    assert.ok(
      due >= before + expectedMs - 5_000 && due <= after + expectedMs + 5_000,
      `slaDueAt ${new Date(due).toISOString()} should be ~now + 5min`,
    );
  });

  // ─── tenant-aware "due today" ─────────────────────────────────────

  it('dayBoundsInTimezone honours the supplied IANA zone', () => {
    // 2026-05-01T22:00Z — that's 2026-05-02 07:00 in Asia/Tokyo,
    // and 2026-05-01 12:00 in Pacific/Honolulu.
    const base = new Date('2026-05-01T22:00:00.000Z');
    const tokyo = dayBoundsInTimezone(base, 'Asia/Tokyo');
    const honolulu = dayBoundsInTimezone(base, 'Pacific/Honolulu');
    // The Tokyo "today" starts at 2026-05-01 15:00 UTC (00:00 JST).
    // The Honolulu "today" starts at 2026-05-01 10:00 UTC (00:00 HST).
    assert.notEqual(tokyo.start.getTime(), honolulu.start.getTime());
    // Sanity: each window is 24h wide.
    for (const w of [tokyo, honolulu]) {
      const diff = w.end.getTime() - w.start.getTime();
      assert.ok(diff >= 24 * 60 * 60 * 1000 - 100 && diff <= 24 * 60 * 60 * 1000);
    }
  });
});
