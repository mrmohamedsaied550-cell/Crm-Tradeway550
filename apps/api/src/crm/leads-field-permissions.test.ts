/**
 * Phase C — C4: read-side field-permission filtering.
 *
 * Provisions a throwaway tenant with three roles:
 *   • c4_role_sales — clones sales_agent's seeded denies (lead.id,
 *     lead.attribution.campaign, lead.source) so we test the exact
 *     paths the system contract specifies.
 *   • c4_role_global — control role with no denies; sees everything.
 *   • super_admin — verifies the bypass.
 *
 * Asserts that LeadsService.list, .findByIdInScopeOrThrow,
 * .listByStage, .listOverdue, .listDueToday, and .listActivities
 * all strip the denied paths from their responses. Also exercises
 * the FieldFilterService directly to verify dot-path semantics.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { AgentCapacitiesService } from '../distribution/capacities.service';
import { DistributionService } from '../distribution/distribution.service';
import { LeadRoutingLogService } from '../distribution/routing-log.service';
import { DistributionRulesService } from '../distribution/rules.service';
import { PrismaService } from '../prisma/prisma.service';
import { FieldFilterService } from '../rbac/field-filter.service';
import { ScopeContextService } from '../rbac/scope-context.service';
import { tenantContext } from '../tenants/tenant-context';
import { TenantSettingsService } from '../tenants/tenant-settings.service';

import { AssignmentService } from './assignment.service';
import { LeadsService } from './leads.service';
import { LostReasonsService } from './lost-reasons.service';
import { PipelineService } from './pipeline.service';
import { SlaService } from './sla.service';

const TENANT_CODE = '__c4_field__';

let prisma: PrismaClient;
let prismaSvc: PrismaService;
let leads: LeadsService;
let fieldFilter: FieldFilterService;
let tenantId: string;

let roleSalesId: string;
let roleGlobalId: string;
let roleSuperId: string;
let userSalesId: string;
let userGlobalId: string;
let userSuperId: string;

let pipelineId: string;
let newStageId: string;
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

function claimsFor(userId: string, roleId: string) {
  return { userId, tenantId, roleId };
}

const SALES_DENIES = [
  ['lead', 'id'],
  ['lead', 'attribution.campaign'],
  ['lead', 'source'],
] as const;

describe('crm — field-permission read filter (C4)', () => {
  before(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    prismaSvc = new PrismaService();
    fieldFilter = new FieldFilterService(prismaSvc);
    const scope = new ScopeContextService(prismaSvc);
    const pipelineSvc = new PipelineService(prismaSvc);
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
      pipelineSvc,
      sla,
      tenantSettings,
      distribution,
      undefined,
      lostReasons,
      scope,
      fieldFilter,
    );

    const tenant = await prisma.tenant.upsert({
      where: { code: TENANT_CODE },
      update: { isActive: true },
      create: { code: TENANT_CODE, name: 'C4 field' },
    });
    tenantId = tenant.id;

    await withTenantRaw(tenantId, async (tx) => {
      await tx.tenantSettings.upsert({
        where: { tenantId },
        update: {},
        create: { tenantId, timezone: 'Africa/Cairo', slaMinutes: 60, defaultDialCode: '+20' },
      });

      // Roles — global control, sales (with the 3 seeded denies),
      // and super_admin (bypass test).
      const roleSales = await tx.role.create({
        data: {
          tenantId,
          code: 'c4_role_sales',
          nameAr: 'مبيعات',
          nameEn: 'Sales (C4)',
          level: 30,
          isSystem: false,
        },
      });
      roleSalesId = roleSales.id;
      for (const resource of ['lead', 'captain', 'followup', 'whatsapp.conversation']) {
        await tx.roleScope.create({
          data: { tenantId, roleId: roleSalesId, resource, scope: 'global' },
        });
      }
      // Mirror the C1-seeded sales_agent denies on this throwaway role.
      for (const [resource, field] of SALES_DENIES) {
        await tx.fieldPermission.create({
          data: { tenantId, roleId: roleSalesId, resource, field, canRead: false, canWrite: false },
        });
      }

      const roleGlobal = await tx.role.create({
        data: {
          tenantId,
          code: 'c4_role_global',
          nameAr: 'عام',
          nameEn: 'Global (C4)',
          level: 30,
          isSystem: false,
        },
      });
      roleGlobalId = roleGlobal.id;
      for (const resource of ['lead', 'captain', 'followup', 'whatsapp.conversation']) {
        await tx.roleScope.create({
          data: { tenantId, roleId: roleGlobalId, resource, scope: 'global' },
        });
      }

      // super_admin role — also seed the SAME 3 deny rows so we can
      // verify the bypass kicks in BEFORE the deny lookup runs.
      const roleSuper = await tx.role.create({
        data: {
          tenantId,
          code: 'super_admin',
          nameAr: 'مشرف عام',
          nameEn: 'Super Admin (C4)',
          level: 100,
          isSystem: true,
        },
      });
      roleSuperId = roleSuper.id;
      for (const resource of ['lead', 'captain', 'followup', 'whatsapp.conversation']) {
        await tx.roleScope.create({
          data: { tenantId, roleId: roleSuperId, resource, scope: 'global' },
        });
      }
      for (const [resource, field] of SALES_DENIES) {
        await tx.fieldPermission.create({
          data: {
            tenantId,
            roleId: roleSuperId,
            resource,
            field,
            canRead: false,
            canWrite: false,
          },
        });
      }

      async function makeUser(emailLocal: string, roleId: string): Promise<string> {
        const u = await tx.user.create({
          data: {
            tenantId,
            email: `c4-${emailLocal}@test`,
            name: emailLocal,
            passwordHash: 'x',
            status: 'active',
            roleId,
          },
        });
        return u.id;
      }
      userSalesId = await makeUser('sales', roleSalesId);
      userGlobalId = await makeUser('global', roleGlobalId);
      userSuperId = await makeUser('super', roleSuperId);

      // Pipeline + 1 stage + 1 lead with rich attribution.
      const pipe = await tx.pipeline.create({
        data: { tenantId, name: 'Default', isDefault: true, isActive: true },
        select: { id: true },
      });
      pipelineId = pipe.id;
      const sNew = await tx.pipelineStage.create({
        data: { tenantId, pipelineId, code: 'new', name: 'New', order: 10 },
      });
      newStageId = sNew.id;

      const dueAt = new Date(Date.now() - 60_000); // overdue by 1 min
      const lead = await tx.lead.create({
        data: {
          tenantId,
          stageId: newStageId,
          pipelineId,
          name: 'Aida Test',
          phone: '+201000000111',
          source: 'meta',
          assignedToId: userSalesId,
          nextActionDueAt: dueAt,
          attribution: {
            source: 'meta',
            subSource: 'meta_lead_form',
            campaign: { id: 'cmp_42', name: 'Spring 2026' },
            adSet: { id: 'as_7' },
            ad: { id: 'ad_1' },
            utm: { source: 'meta', medium: 'paid' },
          },
        },
      });
      leadId = lead.id;

      // One activity with payload that mirrors lead-shape denied
      // fields (defensive — current emitters don't emit these, but
      // the filter must catch them if they ever appear).
      await tx.leadActivity.create({
        data: {
          tenantId,
          leadId,
          type: 'system',
          body: 'audit: synthetic',
          payload: {
            event: 'synthetic',
            id: 'lead-id-leak',
            source: 'meta',
            attribution: {
              campaign: { id: 'cmp_42', name: 'Spring 2026' },
              adSet: { id: 'as_7' },
            },
          },
          createdById: userSalesId,
        },
      });
    });
  });

  after(async () => {
    if (tenantId) {
      await prisma.tenant.delete({ where: { code: TENANT_CODE } }).catch(() => {});
    }
    await prisma.$disconnect();
  });

  // ─── FieldFilterService unit checks ─────────────────────────────

  it('listDeniedReadFields — sales role returns the 3 seeded denies', async () => {
    const r = await inTenant(() =>
      fieldFilter.listDeniedReadFields(claimsFor(userSalesId, roleSalesId), 'lead'),
    );
    assert.equal(r.bypassed, false);
    assert.deepEqual(new Set(r.paths), new Set(['id', 'attribution.campaign', 'source']));
  });

  it('listDeniedReadFields — global role returns []', async () => {
    const r = await inTenant(() =>
      fieldFilter.listDeniedReadFields(claimsFor(userGlobalId, roleGlobalId), 'lead'),
    );
    assert.equal(r.bypassed, false);
    assert.deepEqual(r.paths, []);
  });

  it('listDeniedReadFields — super_admin bypass returns bypassed=true and []', async () => {
    const r = await inTenant(() =>
      fieldFilter.listDeniedReadFields(claimsFor(userSuperId, roleSuperId), 'lead'),
    );
    assert.equal(r.bypassed, true);
    assert.deepEqual(r.paths, []);
  });

  it('filterRead — strips top-level path', () => {
    const out = fieldFilter.filterRead({ id: 'x', name: 'A' }, ['id']);
    assert.equal(Object.prototype.hasOwnProperty.call(out, 'id'), false);
    assert.equal(out.name, 'A');
  });

  it('filterRead — strips nested path without touching siblings', () => {
    const input = {
      attribution: {
        campaign: { id: 'cmp_42', name: 'Spring' },
        adSet: { id: 'as_7' },
      },
      name: 'A',
    };
    const out = fieldFilter.filterRead(input, ['attribution.campaign']);
    assert.equal(
      Object.prototype.hasOwnProperty.call(out.attribution, 'campaign'),
      false,
      'campaign deleted',
    );
    assert.deepEqual(out.attribution.adSet, { id: 'as_7' }, 'siblings preserved');
    // Source object is untouched (deep-clone semantics).
    assert.equal(input.attribution.campaign.name, 'Spring');
  });

  it('filterRead — missing intermediate is a no-op', () => {
    const out = fieldFilter.filterRead({ name: 'A' }, ['attribution.campaign']);
    assert.deepEqual(out, { name: 'A' });
  });

  // ─── End-to-end LeadsService read paths ─────────────────────────

  it('list — sales role: id / source / attribution.campaign stripped per row', async () => {
    const res = await inTenant(() =>
      leads.list({ limit: 100, offset: 0 }, claimsFor(userSalesId, roleSalesId)),
    );
    assert.ok(res.items.length > 0, 'list returns at least one row');
    for (const item of res.items) {
      const o = item as Record<string, unknown> & { attribution?: Record<string, unknown> };
      assert.equal(Object.prototype.hasOwnProperty.call(o, 'id'), false, 'id stripped');
      assert.equal(Object.prototype.hasOwnProperty.call(o, 'source'), false, 'source stripped');
      assert.ok(o.attribution, 'attribution object retained');
      assert.equal(
        Object.prototype.hasOwnProperty.call(o.attribution, 'campaign'),
        false,
        'attribution.campaign stripped',
      );
      // Sanity: untouched nested keys still present.
      assert.equal((o.attribution as { adSet?: unknown }).adSet !== undefined, true);
    }
  });

  it('list — global role: every field present', async () => {
    const res = await inTenant(() =>
      leads.list({ limit: 100, offset: 0 }, claimsFor(userGlobalId, roleGlobalId)),
    );
    const first = res.items[0] as Record<string, unknown> & {
      attribution?: { campaign?: unknown };
    };
    assert.ok(first.id, 'id present for global role');
    assert.ok(first.source, 'source present');
    assert.ok(first.attribution?.campaign, 'attribution.campaign present');
  });

  it('list — super_admin: bypass — every field present', async () => {
    const res = await inTenant(() =>
      leads.list({ limit: 100, offset: 0 }, claimsFor(userSuperId, roleSuperId)),
    );
    const first = res.items[0] as Record<string, unknown> & {
      attribution?: { campaign?: unknown };
    };
    assert.ok(first.id, 'super_admin sees id');
    assert.ok(first.source, 'super_admin sees source');
    assert.ok(first.attribution?.campaign, 'super_admin sees attribution.campaign');
  });

  it('list — without userClaims: fields untouched (legacy fixtures)', async () => {
    const res = await inTenant(() => leads.list({ limit: 100, offset: 0 }));
    const first = res.items[0] as Record<string, unknown> & {
      attribution?: { campaign?: unknown };
    };
    assert.ok(first.id);
    assert.ok(first.source);
    assert.ok(first.attribution?.campaign);
  });

  it('findByIdInScopeOrThrow — sales role: denied paths stripped', async () => {
    const got = (await inTenant(() =>
      leads.findByIdInScopeOrThrow(leadId, claimsFor(userSalesId, roleSalesId)),
    )) as Record<string, unknown> & { attribution?: Record<string, unknown> };
    assert.equal(Object.prototype.hasOwnProperty.call(got, 'id'), false, 'id stripped');
    assert.equal(Object.prototype.hasOwnProperty.call(got, 'source'), false, 'source stripped');
    assert.equal(
      Object.prototype.hasOwnProperty.call(got.attribution ?? {}, 'campaign'),
      false,
      'attribution.campaign stripped',
    );
    // Untouched fields:
    assert.equal((got as { name?: string }).name, 'Aida Test');
    assert.equal((got as { phone?: string }).phone, '+201000000111');
  });

  it('listByStage — sales role: every bucket s leads have denied paths stripped', async () => {
    const res = await inTenant(() =>
      leads.listByStage({ pipelineId, perStage: 10 }, claimsFor(userSalesId, roleSalesId)),
    );
    const allLeads = res.stages.flatMap((s) => s.leads);
    assert.ok(allLeads.length > 0);
    for (const l of allLeads) {
      const o = l as Record<string, unknown> & { attribution?: Record<string, unknown> };
      assert.equal(Object.prototype.hasOwnProperty.call(o, 'id'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(o, 'source'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(o.attribution ?? {}, 'campaign'), false);
    }
  });

  it('listOverdue — sales role: denied paths stripped', async () => {
    const res = await inTenant(() => leads.listOverdue({}, claimsFor(userSalesId, roleSalesId)));
    assert.ok(res.length > 0);
    for (const l of res) {
      const o = l as Record<string, unknown> & { attribution?: Record<string, unknown> };
      assert.equal(Object.prototype.hasOwnProperty.call(o, 'id'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(o, 'source'), false);
    }
  });

  it('listDueToday — sales role: denied paths stripped', async () => {
    // Push a "due today" lead (within today's window).
    await withTenantRaw(tenantId, async (tx) => {
      const todayAt = new Date();
      todayAt.setHours(8, 0, 0, 0);
      await tx.lead.update({
        where: { id: leadId },
        data: { nextActionDueAt: todayAt },
      });
    });
    const res = await inTenant(() => leads.listDueToday({}, claimsFor(userSalesId, roleSalesId)));
    assert.ok(res.length > 0);
    for (const l of res) {
      const o = l as Record<string, unknown> & { attribution?: Record<string, unknown> };
      assert.equal(Object.prototype.hasOwnProperty.call(o, 'id'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(o, 'source'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(o.attribution ?? {}, 'campaign'), false);
    }
  });

  it('listActivities — sales role: payload denied paths stripped (timeline does not leak)', async () => {
    const rows = await inTenant(() =>
      leads.listActivities(leadId, claimsFor(userSalesId, roleSalesId)),
    );
    assert.ok(rows.length > 0);
    const synthetic = rows.find(
      (r) => (r.payload as { event?: string } | null)?.event === 'synthetic',
    );
    assert.ok(synthetic, 'synthetic activity row found');
    const p = synthetic.payload as Record<string, unknown> & {
      attribution?: Record<string, unknown>;
    };
    assert.equal(Object.prototype.hasOwnProperty.call(p, 'id'), false, 'payload.id stripped');
    assert.equal(
      Object.prototype.hasOwnProperty.call(p, 'source'),
      false,
      'payload.source stripped',
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(p.attribution ?? {}, 'campaign'),
      false,
      'payload.attribution.campaign stripped',
    );
    // Sibling preserved:
    assert.deepEqual((p.attribution as { adSet?: unknown }).adSet, { id: 'as_7' });
    // Non-denied field preserved:
    assert.equal(p.event, 'synthetic');
  });

  it('listActivities — global role: every payload field present', async () => {
    const rows = await inTenant(() =>
      leads.listActivities(leadId, claimsFor(userGlobalId, roleGlobalId)),
    );
    const synthetic = rows.find(
      (r) => (r.payload as { event?: string } | null)?.event === 'synthetic',
    );
    assert.ok(synthetic);
    const p = synthetic.payload as Record<string, unknown> & {
      attribution?: { campaign?: unknown };
    };
    assert.equal(p.id, 'lead-id-leak');
    assert.equal(p.source, 'meta');
    assert.deepEqual(p.attribution?.campaign, { id: 'cmp_42', name: 'Spring 2026' });
  });

  // ─── C5: write-side filter ────────────────────────────────────────

  describe('C5 — write-side field filter', () => {
    it('listDeniedWriteFields — sales role returns the same 3 paths', async () => {
      const r = await inTenant(() =>
        fieldFilter.listDeniedWriteFields(claimsFor(userSalesId, roleSalesId), 'lead'),
      );
      assert.equal(r.bypassed, false);
      assert.deepEqual(new Set(r.paths), new Set(['id', 'attribution.campaign', 'source']));
    });

    it('listDeniedWriteFields — global role returns []', async () => {
      const r = await inTenant(() =>
        fieldFilter.listDeniedWriteFields(claimsFor(userGlobalId, roleGlobalId), 'lead'),
      );
      assert.equal(r.bypassed, false);
      assert.deepEqual(r.paths, []);
    });

    it('listDeniedWriteFields — super_admin bypass returns bypassed=true and []', async () => {
      const r = await inTenant(() =>
        fieldFilter.listDeniedWriteFields(claimsFor(userSuperId, roleSuperId), 'lead'),
      );
      assert.equal(r.bypassed, true);
      assert.deepEqual(r.paths, []);
    });

    it('stripForbiddenWrites — strips top-level + nested without touching siblings', () => {
      const out = fieldFilter.stripForbiddenWrites(
        {
          name: 'Keep',
          source: 'meta',
          attribution: { campaign: { id: 'x' }, adSet: { id: 'y' } },
        },
        ['source', 'attribution.campaign'],
      );
      assert.equal(Object.prototype.hasOwnProperty.call(out, 'source'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(out.attribution, 'campaign'), false);
      assert.equal(out.name, 'Keep');
      assert.deepEqual(out.attribution.adSet, { id: 'y' });
    });

    it('create — sales role: source / attribution.campaign stripped from input; lead persisted with defaults', async () => {
      const created = (await inTenant(() =>
        leads.create(
          {
            name: 'C5 Sales Created',
            phone: '+201000000211',
            source: 'meta',
            attribution: {
              campaign: { id: 'cmp_should_be_dropped' },
              adSet: { id: 'as_keeps' },
            },
          },
          userSalesId,
          claimsFor(userSalesId, roleSalesId),
        ),
      )) as {
        id: string;
        name: string;
        phone: string;
        source: string;
        attribution: { campaign?: unknown; adSet?: unknown };
      };
      // Read back as the global role so we can inspect the persisted
      // row without the C4 read filter masking what the write actually
      // landed.
      const persisted = (await inTenant(() =>
        leads.findByIdInScopeOrThrow(created.id, claimsFor(userGlobalId, roleGlobalId)),
      )) as {
        source: string;
        attribution: { campaign?: unknown; adSet?: unknown };
      };
      assert.equal(persisted.source, 'manual', 'source falls back to schema default');
      assert.equal(
        persisted.attribution.campaign,
        undefined,
        'attribution.campaign was dropped from the input before persistence',
      );
      assert.deepEqual(persisted.attribution.adSet, { id: 'as_keeps' }, 'sibling preserved');
    });

    it('update — sales role: source change ignored; allowed fields (name, phone, email) still applied', async () => {
      // Seed a fresh lead via the global role so we know its baseline
      // source value is 'meta' (not 'manual').
      const fresh = (await inTenant(() =>
        leads.create(
          {
            name: 'C5 Update Baseline',
            phone: '+201000000212',
            source: 'meta',
          },
          userGlobalId,
          claimsFor(userGlobalId, roleGlobalId),
        ),
      )) as { id: string; source: string };
      assert.equal(fresh.source, 'meta');

      const after = (await inTenant(() =>
        leads.update(
          fresh.id,
          { name: 'NEW NAME', email: 'after@test', source: 'tiktok' },
          userSalesId,
          claimsFor(userSalesId, roleSalesId),
        ),
      )) as { id: string; name: string; email: string; source: string };
      assert.equal(after.name, 'NEW NAME', 'allowed field applied');
      assert.equal(after.email, 'after@test', 'allowed field applied');
      assert.equal(after.source, 'meta', 'denied source change silently dropped');
    });

    it('update — super_admin bypass: source change applied even with seeded deny rows', async () => {
      const fresh = (await inTenant(() =>
        leads.create(
          { name: 'C5 Super', phone: '+201000000213', source: 'meta' },
          userGlobalId,
          claimsFor(userGlobalId, roleGlobalId),
        ),
      )) as { id: string };

      const after = (await inTenant(() =>
        leads.update(
          fresh.id,
          { source: 'tiktok' },
          userSuperId,
          claimsFor(userSuperId, roleSuperId),
        ),
      )) as { source: string };
      assert.equal(after.source, 'tiktok', 'super_admin bypassed the write filter');
    });

    it('update — without userClaims: legacy fixture path persists every key (no filter)', async () => {
      const fresh = (await inTenant(() =>
        leads.create(
          { name: 'C5 Legacy', phone: '+201000000214', source: 'meta' },
          userGlobalId,
          claimsFor(userGlobalId, roleGlobalId),
        ),
      )) as { id: string };

      const after = (await inTenant(() =>
        leads.update(fresh.id, { source: 'tiktok' }, userSalesId),
      )) as { source: string };
      assert.equal(after.source, 'tiktok', 'no claims = no filter');
    });

    it('change log does not leak forbidden values (audit + activity tables)', async () => {
      // Create a lead via sales role with denied input — we expect:
      //   1. The persisted row has source='manual' (default),
      //      attribution.campaign undefined.
      //   2. No activity row's `payload` includes `source: 'meta'` or
      //      `attribution.campaign: ...`.
      //   3. No audit_event row carries those values either.
      const created = (await inTenant(() =>
        leads.create(
          {
            name: 'C5 No Leak',
            phone: '+201000000215',
            source: 'meta',
            attribution: { campaign: { id: 'cmp_leak_test' } },
          },
          userSalesId,
          claimsFor(userSalesId, roleSalesId),
        ),
      )) as { id: string };

      // Inspect activity rows the sales actor created on this lead.
      const activityRows = await withTenantRaw(tenantId, async (tx) =>
        tx.leadActivity.findMany({ where: { leadId: created.id } }),
      );
      for (const row of activityRows) {
        const serialized = JSON.stringify(row.payload ?? {});
        assert.equal(
          serialized.includes('cmp_leak_test'),
          false,
          `activity payload leaked attribution.campaign: ${serialized}`,
        );
        assert.equal(
          /\b"source":\s*"meta"/.test(serialized),
          false,
          `activity payload leaked source=meta: ${serialized}`,
        );
      }

      // Inspect audit_event rows for this lead.
      const auditRows = await withTenantRaw(tenantId, async (tx) =>
        tx.auditEvent.findMany({ where: { entityId: created.id } }),
      );
      for (const row of auditRows) {
        const serialized = JSON.stringify(row.payload ?? {});
        assert.equal(
          serialized.includes('cmp_leak_test'),
          false,
          `audit_event leaked attribution.campaign: ${serialized}`,
        );
        assert.equal(
          /\b"source":\s*"meta"/.test(serialized),
          false,
          `audit_event leaked source=meta: ${serialized}`,
        );
      }
    });

    it('assign — write deny on assignedToId silently no-ops (custom role with denied assignedToId)', async () => {
      // Seed a custom role that denies write on assignedToId.
      let roleNoAssignId = '';
      let userNoAssignId = '';
      let leadForAssignId = '';
      await withTenantRaw(tenantId, async (tx) => {
        const role = await tx.role.create({
          data: {
            tenantId,
            code: 'c5_no_assign',
            nameAr: 'ممنوع التعيين',
            nameEn: 'No Assign (C5)',
            level: 30,
            isSystem: false,
          },
        });
        roleNoAssignId = role.id;
        for (const resource of ['lead', 'captain', 'followup', 'whatsapp.conversation']) {
          await tx.roleScope.create({
            data: { tenantId, roleId: roleNoAssignId, resource, scope: 'global' },
          });
        }
        await tx.fieldPermission.create({
          data: {
            tenantId,
            roleId: roleNoAssignId,
            resource: 'lead',
            field: 'assignedToId',
            canRead: true,
            canWrite: false,
          },
        });
        const u = await tx.user.create({
          data: {
            tenantId,
            email: 'c5-no-assign@test',
            name: 'no_assign',
            passwordHash: 'x',
            status: 'active',
            roleId: roleNoAssignId,
          },
        });
        userNoAssignId = u.id;
        const fresh = await tx.lead.create({
          data: {
            tenantId,
            stageId: newStageId,
            pipelineId,
            name: 'Assign Target',
            phone: '+201000000216',
            assignedToId: userGlobalId,
          },
        });
        leadForAssignId = fresh.id;
      });

      const after = (await inTenant(() =>
        leads.assign(
          leadForAssignId,
          userNoAssignId,
          userNoAssignId,
          claimsFor(userNoAssignId, roleNoAssignId),
        ),
      )) as { assignedToId: string | null };
      assert.equal(
        after.assignedToId,
        userGlobalId,
        'assign was a silent no-op — assignedToId unchanged',
      );
    });
  });
});
