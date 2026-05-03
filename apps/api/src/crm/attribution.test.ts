/**
 * Phase A — A4: attribution on create.
 *
 * Two layers:
 *   • Pure helper `buildAttribution` — no DB. Verifies the shape it
 *     produces from various inputs (mirrors source, drops empty
 *     refs/utm, preserves campaign/ad/utm/custom).
 *   • LeadsService.create — writes the JSONB column. Verifies the
 *     persisted shape for: bare manual create, attribution payload
 *     with campaign + utm, empty payload (drops to bare).
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';

import { AgentCapacitiesService } from '../distribution/capacities.service';
import { DistributionService } from '../distribution/distribution.service';
import { LeadRoutingLogService } from '../distribution/routing-log.service';
import { DistributionRulesService } from '../distribution/rules.service';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { tenantContext } from '../tenants/tenant-context';
import { TenantSettingsService } from '../tenants/tenant-settings.service';
import { AssignmentService } from './assignment.service';
import { buildAttribution } from './attribution.util';
import { LeadsService } from './leads.service';
import { LostReasonsService } from './lost-reasons.service';
import { PipelineService } from './pipeline.service';
import { SlaService } from './sla.service';

// ─── 1. Pure helper ──────────────────────────────────────────────────

describe('crm — buildAttribution helper (A4)', () => {
  it('mirrors source onto the payload when no input is given', () => {
    const r = buildAttribution('manual');
    assert.deepEqual(r, { source: 'manual' });
  });

  it('mirrors source even when input is null', () => {
    const r = buildAttribution('meta', null);
    assert.deepEqual(r, { source: 'meta' });
  });

  it('keeps populated nested objects', () => {
    const r = buildAttribution('meta', {
      subSource: 'meta_lead_form',
      campaign: { id: 'C1', name: 'Camp 1' },
      adSet: { id: 'AS1' },
      ad: { id: 'A1', name: 'Ad 1' },
      utm: { source: 'fb', campaign: 'C1' },
      referrer: 'https://example.com',
      custom: { pageId: 'P1' },
    });
    assert.equal(r.source, 'meta');
    assert.equal(r.subSource, 'meta_lead_form');
    assert.deepEqual(r.campaign, { id: 'C1', name: 'Camp 1' });
    assert.deepEqual(r.adSet, { id: 'AS1' });
    assert.deepEqual(r.ad, { id: 'A1', name: 'Ad 1' });
    assert.deepEqual(r.utm, { source: 'fb', campaign: 'C1' });
    assert.equal(r.referrer, 'https://example.com');
    assert.deepEqual(r.custom, { pageId: 'P1' });
  });

  it('drops empty / whitespace-only nested fields', () => {
    const r = buildAttribution('manual', {
      subSource: '   ',
      campaign: { id: '', name: '   ' },
      adSet: { id: 'AS1' },
      utm: { source: '   ', medium: '   ' },
      referrer: '   ',
      custom: {},
    });
    assert.deepEqual(r, { source: 'manual', adSet: { id: 'AS1' } });
  });

  it('drops the utm object entirely when every field is empty', () => {
    const r = buildAttribution('whatsapp', {
      utm: { source: '', medium: '', campaign: '', term: '', content: '' },
    });
    assert.deepEqual(r, { source: 'whatsapp' });
  });

  it('trims string fields', () => {
    const r = buildAttribution('manual', {
      subSource: '  meta_lead_form  ',
      campaign: { id: '  C1  ', name: '  Camp 1  ' },
    });
    assert.equal(r.subSource, 'meta_lead_form');
    assert.deepEqual(r.campaign, { id: 'C1', name: 'Camp 1' });
  });
});

// ─── 2. LeadsService.create writes attribution ───────────────────────

const TENANT_CODE = '__a4_attribution__';

let prisma: PrismaClient;
let prismaSvc: PrismaService;
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

describe('crm — LeadsService.create writes attribution (A4)', () => {
  before(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    prismaSvc = new PrismaService();
    const pipeline = new PipelineService(prismaSvc);
    const lostReasons = new LostReasonsService(prismaSvc);
    const assignment = new AssignmentService(prismaSvc);
    const audit = new AuditService(prismaSvc);
    const tenantSettings = new TenantSettingsService(prismaSvc, audit);
    const sla = new SlaService(prismaSvc, assignment, undefined, tenantSettings);
    const rules = new DistributionRulesService(prismaSvc);
    const capacities = new AgentCapacitiesService(prismaSvc);
    const routingLog = new LeadRoutingLogService(prismaSvc);
    const distribution = new DistributionService(prismaSvc, rules, capacities, routingLog);
    leads = new LeadsService(
      prismaSvc,
      pipeline,
      sla,
      tenantSettings,
      distribution,
      undefined,
      lostReasons,
    );

    const tenant = await prisma.tenant.upsert({
      where: { code: TENANT_CODE },
      update: { isActive: true },
      create: { code: TENANT_CODE, name: 'A4 attribution' },
    });
    tenantId = tenant.id;

    await withTenantRaw(tenantId, async (tx) => {
      await tx.tenantSettings.upsert({
        where: { tenantId },
        update: {},
        create: { tenantId, timezone: 'Africa/Cairo', slaMinutes: 60, defaultDialCode: '+20' },
      });
      const role = await tx.role.create({
        data: { tenantId, code: 'sales_agent', nameAr: 'مبيعات', nameEn: 'Sales', level: 30 },
      });
      const actor = await tx.user.create({
        data: {
          tenantId,
          email: 'a4-actor@test',
          name: 'Actor',
          passwordHash: 'x',
          status: 'active',
          roleId: role.id,
        },
      });
      actorUserId = actor.id;

      const pipe = await tx.pipeline.create({
        data: { tenantId, name: 'Default', isDefault: true, isActive: true },
        select: { id: true },
      });
      await tx.pipelineStage.create({
        data: { tenantId, pipelineId: pipe.id, code: 'new', name: 'New', order: 10 },
      });
    });
  });

  after(async () => {
    await prisma.tenant.delete({ where: { code: TENANT_CODE } }).catch(() => {});
    await prisma.$disconnect();
  });

  it('bare manual create writes { source: "manual" }', async () => {
    const lead = await inTenant(() =>
      leads.create({ name: 'AT1', phone: '+201001000301', source: 'manual' }, actorUserId),
    );
    // Re-read attribution from the DB via raw select since the
    // `findById` shape doesn't include it on this branch's helpers.
    const row = await inTenant(() =>
      prismaSvc.withTenant(tenantId, (tx) =>
        tx.lead.findUnique({ where: { id: lead.id }, select: { attribution: true } }),
      ),
    );
    assert.deepEqual(row?.attribution, { source: 'manual' });
  });

  it('create with rich attribution writes the merged payload', async () => {
    const lead = await inTenant(() =>
      leads.create(
        {
          name: 'AT2',
          phone: '+201001000302',
          source: 'meta',
          attribution: {
            subSource: 'meta_lead_form',
            campaign: { id: 'C1', name: 'Camp One' },
            ad: { id: 'A1' },
            utm: { source: 'fb', medium: 'cpc' },
          },
        },
        actorUserId,
      ),
    );
    const row = await inTenant(() =>
      prismaSvc.withTenant(tenantId, (tx) =>
        tx.lead.findUnique({ where: { id: lead.id }, select: { attribution: true } }),
      ),
    );
    const attr = row?.attribution as Record<string, unknown>;
    assert.equal(attr.source, 'meta');
    assert.equal(attr.subSource, 'meta_lead_form');
    assert.deepEqual(attr.campaign, { id: 'C1', name: 'Camp One' });
    assert.deepEqual(attr.ad, { id: 'A1' });
    assert.deepEqual(attr.utm, { source: 'fb', medium: 'cpc' });
  });

  it('create with empty attribution input still writes the bare source', async () => {
    const lead = await inTenant(() =>
      leads.create(
        {
          name: 'AT3',
          phone: '+201001000303',
          source: 'tiktok',
          attribution: {
            // All fields empty / whitespace
            subSource: '',
            campaign: { id: '   ' },
            utm: { source: '' },
          },
        },
        actorUserId,
      ),
    );
    const row = await inTenant(() =>
      prismaSvc.withTenant(tenantId, (tx) =>
        tx.lead.findUnique({ where: { id: lead.id }, select: { attribution: true } }),
      ),
    );
    assert.deepEqual(row?.attribution, { source: 'tiktok' });
  });

  it('Lead.source and attribution.source stay in sync', async () => {
    const lead = await inTenant(() =>
      leads.create(
        {
          name: 'AT4',
          phone: '+201001000304',
          source: 'whatsapp',
          attribution: { subSource: 'wa_account_xyz' },
        },
        actorUserId,
      ),
    );
    const row = await inTenant(() =>
      prismaSvc.withTenant(tenantId, (tx) =>
        tx.lead.findUnique({
          where: { id: lead.id },
          select: { source: true, attribution: true },
        }),
      ),
    );
    assert.equal(row?.source, 'whatsapp');
    const attr = row?.attribution as Record<string, unknown>;
    assert.equal(attr.source, 'whatsapp');
    assert.equal(attr.subSource, 'wa_account_xyz');
  });
});
