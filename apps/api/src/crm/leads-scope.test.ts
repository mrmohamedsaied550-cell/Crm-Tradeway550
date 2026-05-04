/**
 * Phase C — C3: scope-based lead access control.
 *
 * Provisions a throwaway tenant with five custom roles (one per
 * scope value: own / team / company / country / global) and a
 * matched user per role, then asserts that LeadsService read paths
 * (list / listByStage / listOverdue / listDueToday /
 * findByIdInScopeOrThrow) honour the configured scope.
 *
 * The 11 seeded system roles default to 'global' (set by the C1
 * migration), so the suite of 469 pre-C3 tests is unaffected — this
 * file exercises the new code path explicitly.
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
import { ScopeContextService } from '../rbac/scope-context.service';
import { tenantContext } from '../tenants/tenant-context';
import { TenantSettingsService } from '../tenants/tenant-settings.service';

import { AssignmentService } from './assignment.service';
import { LeadsService } from './leads.service';
import { LostReasonsService } from './lost-reasons.service';
import { PipelineService } from './pipeline.service';
import { SlaService } from './sla.service';

const TENANT_CODE = '__c3_scope__';

let prisma: PrismaClient;
let prismaSvc: PrismaService;
let leads: LeadsService;
let scope: ScopeContextService;
let tenantId: string;

// Org structure
let companyAcmeId: string;
let companyOtherId: string;
let countryEgId: string;
let countrySaId: string;
let teamEgId: string;
let teamSaId: string;

// Roles (one per scope value)
let roleGlobalId: string;
let roleOwnId: string;
let roleTeamId: string;
let roleCompanyId: string;
let roleCountryId: string;
/**
 * C3.5: a role with code='super_admin' AND scope='own' on lead.
 * The bypass MUST kick in and force 'global' regardless of the
 * stored scope value.
 */
let roleSuperAdminId: string;

// Users (one matched user per scope; plus a "teammate" of actor_team_eg)
let userGlobalId: string;
let userSuperAdminId: string;
let userOwnId: string;
let userOwnOtherId: string; // not the same person; used to assign other leads
let userTeamEgId: string;
let userTeamEgMateId: string;
let userTeamSaId: string;
let userTeamNoneId: string;
let userCompanyAcmeId: string;
let userCompanyNoAssignmentId: string;
let userCountryEgId: string;

// Leads
let leadOwnId: string;
let leadOtherId: string;
let leadEgTeammateId: string;
let leadSaId: string;
let leadAcmeNoAssigneeId: string;
let leadOtherCompanyId: string;

// Pipeline + stages
let pipelineId: string;
let newStageId: string;

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

describe('crm — scope-based lead access (C3)', () => {
  before(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    prismaSvc = new PrismaService();
    scope = new ScopeContextService(prismaSvc);
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
    );

    const tenant = await prisma.tenant.upsert({
      where: { code: TENANT_CODE },
      update: { isActive: true },
      create: { code: TENANT_CODE, name: 'C3 scope' },
    });
    tenantId = tenant.id;

    await withTenantRaw(tenantId, async (tx) => {
      await tx.tenantSettings.upsert({
        where: { tenantId },
        update: {},
        create: { tenantId, timezone: 'Africa/Cairo', slaMinutes: 60, defaultDialCode: '+20' },
      });

      // Org structure
      const acme = await tx.company.create({
        data: { tenantId, code: 'acme', name: 'ACME' },
      });
      companyAcmeId = acme.id;
      const other = await tx.company.create({
        data: { tenantId, code: 'other', name: 'Other Co' },
      });
      companyOtherId = other.id;
      const eg = await tx.country.create({
        data: { tenantId, companyId: companyAcmeId, code: 'EG', name: 'Egypt' },
      });
      countryEgId = eg.id;
      const sa = await tx.country.create({
        data: { tenantId, companyId: companyAcmeId, code: 'SA', name: 'Saudi Arabia' },
      });
      countrySaId = sa.id;
      const teamEg = await tx.team.create({
        data: { tenantId, countryId: countryEgId, name: 'Sales' },
      });
      teamEgId = teamEg.id;
      const teamSa = await tx.team.create({
        data: { tenantId, countryId: countrySaId, name: 'Sales' },
      });
      teamSaId = teamSa.id;

      // Roles — one per scope value. Each role gets RoleScope rows for
      // all four scoped resources, but only `lead` is exercised below.
      async function makeRole(code: string, scopeValue: string): Promise<string> {
        const role = await tx.role.create({
          data: {
            tenantId,
            code,
            nameAr: code,
            nameEn: code,
            level: 30,
            isSystem: false,
          },
        });
        for (const resource of ['lead', 'captain', 'followup', 'whatsapp.conversation']) {
          await tx.roleScope.create({
            data: {
              tenantId,
              roleId: role.id,
              resource,
              scope: resource === 'lead' ? scopeValue : 'global',
            },
          });
        }
        return role.id;
      }
      roleGlobalId = await makeRole('c3_role_global', 'global');
      roleOwnId = await makeRole('c3_role_own', 'own');
      roleTeamId = await makeRole('c3_role_team', 'team');
      roleCompanyId = await makeRole('c3_role_company', 'company');
      roleCountryId = await makeRole('c3_role_country', 'country');
      // C3.5: deliberately seed scope='own' so we can verify the
      // hardcoded bypass forces 'global' regardless.
      roleSuperAdminId = await makeRole('super_admin', 'own');

      // Users
      async function makeUser(
        emailLocal: string,
        roleId: string,
        teamId: string | null,
      ): Promise<string> {
        const u = await tx.user.create({
          data: {
            tenantId,
            email: `c3-${emailLocal}@test`,
            name: emailLocal,
            passwordHash: 'x',
            status: 'active',
            roleId,
            ...(teamId && { teamId }),
          },
        });
        return u.id;
      }
      userGlobalId = await makeUser('global', roleGlobalId, null);
      userSuperAdminId = await makeUser('super_admin', roleSuperAdminId, null);
      userOwnId = await makeUser('own', roleOwnId, null);
      userOwnOtherId = await makeUser('own_other', roleOwnId, null);
      userTeamEgId = await makeUser('team_eg', roleTeamId, teamEgId);
      userTeamEgMateId = await makeUser('team_eg_mate', roleTeamId, teamEgId);
      userTeamSaId = await makeUser('team_sa', roleTeamId, teamSaId);
      userTeamNoneId = await makeUser('team_none', roleTeamId, null);
      userCompanyAcmeId = await makeUser('company_acme', roleCompanyId, null);
      userCompanyNoAssignmentId = await makeUser('company_noassign', roleCompanyId, null);
      userCountryEgId = await makeUser('country_eg', roleCountryId, null);

      // UserScopeAssignment: company / country bindings.
      await tx.userScopeAssignment.create({
        data: { tenantId, userId: userCompanyAcmeId, companyId: companyAcmeId },
      });
      await tx.userScopeAssignment.create({
        data: { tenantId, userId: userCountryEgId, countryId: countryEgId },
      });

      // Pipeline + stages
      const pipe = await tx.pipeline.create({
        data: { tenantId, name: 'Default', isDefault: true, isActive: true },
        select: { id: true },
      });
      pipelineId = pipe.id;
      const sNew = await tx.pipelineStage.create({
        data: { tenantId, pipelineId, code: 'new', name: 'New', order: 10 },
      });
      newStageId = sNew.id;
      await tx.pipelineStage.create({
        data: { tenantId, pipelineId, code: 'contacted', name: 'Contacted', order: 20 },
      });
      await tx.pipelineStage.create({
        data: {
          tenantId,
          pipelineId,
          code: 'lost',
          name: 'Lost',
          order: 99,
          isTerminal: true,
          terminalKind: 'lost',
        },
      });

      // Leads — controlled (companyId, countryId, assignedToId).
      // overdueDate / dueTodayDate exercise the listOverdue / listDueToday paths.
      const longAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const dueTodayAt = new Date();
      dueTodayAt.setHours(12, 0, 0, 0);

      const baseLead = {
        tenantId,
        stageId: newStageId,
        pipelineId,
      };
      leadOwnId = (
        await tx.lead.create({
          data: {
            ...baseLead,
            name: 'Own Lead',
            phone: '+201111000001',
            companyId: companyAcmeId,
            countryId: countryEgId,
            assignedToId: userOwnId,
            nextActionDueAt: longAgo, // overdue
          },
        })
      ).id;
      leadOtherId = (
        await tx.lead.create({
          data: {
            ...baseLead,
            name: 'Other Lead',
            phone: '+201111000002',
            companyId: companyAcmeId,
            countryId: countryEgId,
            assignedToId: userOwnOtherId,
            nextActionDueAt: longAgo, // overdue
          },
        })
      ).id;
      leadEgTeammateId = (
        await tx.lead.create({
          data: {
            ...baseLead,
            name: 'EG Teammate Lead',
            phone: '+201111000003',
            companyId: companyAcmeId,
            countryId: countryEgId,
            assignedToId: userTeamEgMateId,
            nextActionDueAt: dueTodayAt,
          },
        })
      ).id;
      leadSaId = (
        await tx.lead.create({
          data: {
            ...baseLead,
            name: 'SA Lead',
            phone: '+201111000004',
            companyId: companyAcmeId,
            countryId: countrySaId,
            assignedToId: userTeamSaId,
          },
        })
      ).id;
      leadAcmeNoAssigneeId = (
        await tx.lead.create({
          data: {
            ...baseLead,
            name: 'ACME no assignee',
            phone: '+201111000005',
            companyId: companyAcmeId,
            countryId: null,
            assignedToId: null,
          },
        })
      ).id;
      leadOtherCompanyId = (
        await tx.lead.create({
          data: {
            ...baseLead,
            name: 'Other Company Lead',
            phone: '+201111000006',
            companyId: companyOtherId,
            countryId: null,
            assignedToId: null,
          },
        })
      ).id;
    });
  });

  after(async () => {
    if (tenantId) {
      // Cascade-delete the tenant's data via the tenant FK chain.
      await prisma.tenant.delete({ where: { code: TENANT_CODE } }).catch(() => {});
    }
    await prisma.$disconnect();
  });

  // ─── Helpers shared by every test ─────────────────────────────────

  function claimsFor(userId: string, roleId: string) {
    return { userId, tenantId, roleId };
  }

  // ─── ScopeContextService — direct unit checks ─────────────────────

  it('global scope returns where=null', async () => {
    const r = await inTenant(() => scope.resolveLeadScope(claimsFor(userGlobalId, roleGlobalId)));
    assert.equal(r.scope, 'global');
    assert.equal(r.where, null);
  });

  it('own scope returns where = { assignedToId: { in:[user] }, NOT: { assignedToId: null } }', async () => {
    const r = await inTenant(() => scope.resolveLeadScope(claimsFor(userOwnId, roleOwnId)));
    assert.equal(r.scope, 'own');
    assert.deepEqual(r.where, {
      assignedToId: { in: [userOwnId] },
      NOT: { assignedToId: null },
    });
  });

  it('team scope returns where = { assignedToId: { in:[...teammates] }, NOT: { assignedToId: null } }', async () => {
    const r = await inTenant(() => scope.resolveLeadScope(claimsFor(userTeamEgId, roleTeamId)));
    assert.equal(r.scope, 'team');
    const w = r.where as {
      assignedToId: { in: string[] };
      NOT: { assignedToId: null };
    };
    assert.deepEqual(new Set(w.assignedToId.in), new Set([userTeamEgId, userTeamEgMateId]));
    assert.deepEqual(w.NOT, { assignedToId: null });
  });

  it('team scope with no team returns empty result (C3.5: no fallback to own)', async () => {
    const r = await inTenant(() => scope.resolveLeadScope(claimsFor(userTeamNoneId, roleTeamId)));
    assert.equal(r.scope, 'team');
    assert.deepEqual(r.where, { id: { in: [] } });
  });

  it('company scope returns where = { companyId: { in: [...assigned] } }', async () => {
    const r = await inTenant(() =>
      scope.resolveLeadScope(claimsFor(userCompanyAcmeId, roleCompanyId)),
    );
    assert.equal(r.scope, 'company');
    assert.deepEqual(r.where, { companyId: { in: [companyAcmeId] } });
  });

  it('company scope with no UserScopeAssignment yields empty where', async () => {
    const r = await inTenant(() =>
      scope.resolveLeadScope(claimsFor(userCompanyNoAssignmentId, roleCompanyId)),
    );
    assert.deepEqual(r.where, { id: { in: [] } });
  });

  it('country scope returns where = { countryId: { in: [...assigned] } }', async () => {
    const r = await inTenant(() =>
      scope.resolveLeadScope(claimsFor(userCountryEgId, roleCountryId)),
    );
    assert.equal(r.scope, 'country');
    assert.deepEqual(r.where, { countryId: { in: [countryEgId] } });
  });

  // ─── LeadsService.list — end-to-end scope enforcement ────────────

  it('list — global scope sees every lead', async () => {
    const res = await inTenant(() =>
      leads.list({ limit: 100, offset: 0 }, claimsFor(userGlobalId, roleGlobalId)),
    );
    assert.ok(res.items.length >= 6, `expected ≥6 leads visible, got ${res.items.length}`);
  });

  it('C3.5: super_admin role bypasses the scope table — sees every lead even when role.scope=own', async () => {
    // The role was created with scope='own' but has code='super_admin'.
    // The bypass MUST kick in and produce { scope:'global', where:null }.
    const r = await inTenant(() =>
      scope.resolveLeadScope(claimsFor(userSuperAdminId, roleSuperAdminId)),
    );
    assert.equal(r.scope, 'global');
    assert.equal(r.where, null);

    // End-to-end: the super_admin sees every tenant lead, including
    // unassigned ones and rows from other countries / companies.
    const res = await inTenant(() =>
      leads.list({ limit: 100, offset: 0 }, claimsFor(userSuperAdminId, roleSuperAdminId)),
    );
    const ids = new Set(res.items.map((l) => l.id));
    assert.ok(ids.has(leadOwnId));
    assert.ok(ids.has(leadOtherId));
    assert.ok(ids.has(leadEgTeammateId));
    assert.ok(ids.has(leadSaId));
    assert.ok(ids.has(leadAcmeNoAssigneeId), 'super_admin sees unassigned leads');
    assert.ok(ids.has(leadOtherCompanyId), 'super_admin sees other-company leads');
  });

  it('C3.5: own scope EXCLUDES unassigned leads (assignedToId IS NULL)', async () => {
    const res = await inTenant(() =>
      leads.list({ limit: 100, offset: 0 }, claimsFor(userOwnId, roleOwnId)),
    );
    const ids = new Set(res.items.map((l) => l.id));
    assert.ok(!ids.has(leadAcmeNoAssigneeId), 'unassigned ACME lead must be excluded');
    assert.ok(!ids.has(leadOtherCompanyId), 'unassigned other-company lead must be excluded');
  });

  it('C3.5: team scope EXCLUDES unassigned leads', async () => {
    const res = await inTenant(() =>
      leads.list({ limit: 100, offset: 0 }, claimsFor(userTeamEgId, roleTeamId)),
    );
    const ids = new Set(res.items.map((l) => l.id));
    assert.ok(!ids.has(leadAcmeNoAssigneeId), 'unassigned ACME lead must be excluded');
    assert.ok(!ids.has(leadOtherCompanyId), 'unassigned other-company lead must be excluded');
  });

  it('C3.5: team scope with no team returns empty list (no fallback to own)', async () => {
    const res = await inTenant(() =>
      leads.list({ limit: 100, offset: 0 }, claimsFor(userTeamNoneId, roleTeamId)),
    );
    assert.equal(res.items.length, 0);
    assert.equal(res.total, 0);
  });

  it('list — own scope sees only leads assigned to the user', async () => {
    const res = await inTenant(() =>
      leads.list({ limit: 100, offset: 0 }, claimsFor(userOwnId, roleOwnId)),
    );
    assert.equal(res.items.length, 1);
    assert.equal(res.items[0]?.id, leadOwnId);
  });

  it('list — team scope (EG) sees both teammates leads, hides SA lead', async () => {
    const res = await inTenant(() =>
      leads.list({ limit: 100, offset: 0 }, claimsFor(userTeamEgId, roleTeamId)),
    );
    const ids = new Set(res.items.map((l) => l.id));
    assert.ok(ids.has(leadEgTeammateId), 'must include teammate-assigned EG lead');
    assert.ok(!ids.has(leadSaId), 'must hide SA lead (different team)');
    assert.ok(!ids.has(leadAcmeNoAssigneeId), 'must hide unassigned ACME lead');
  });

  it('list — team scope (SA) sees only the SA-assigned lead', async () => {
    const res = await inTenant(() =>
      leads.list({ limit: 100, offset: 0 }, claimsFor(userTeamSaId, roleTeamId)),
    );
    const ids = res.items.map((l) => l.id);
    assert.ok(ids.includes(leadSaId));
    assert.ok(!ids.includes(leadOwnId));
    assert.ok(!ids.includes(leadEgTeammateId));
  });

  it('list — company scope sees every ACME lead (5/6); hides Other Co lead', async () => {
    const res = await inTenant(() =>
      leads.list({ limit: 100, offset: 0 }, claimsFor(userCompanyAcmeId, roleCompanyId)),
    );
    const ids = new Set(res.items.map((l) => l.id));
    assert.ok(ids.has(leadOwnId));
    assert.ok(ids.has(leadOtherId));
    assert.ok(ids.has(leadEgTeammateId));
    assert.ok(ids.has(leadSaId));
    assert.ok(ids.has(leadAcmeNoAssigneeId));
    assert.ok(!ids.has(leadOtherCompanyId), 'must hide Other Co lead');
  });

  it('list — country scope (EG) sees only EG-tagged ACME leads', async () => {
    const res = await inTenant(() =>
      leads.list({ limit: 100, offset: 0 }, claimsFor(userCountryEgId, roleCountryId)),
    );
    const ids = new Set(res.items.map((l) => l.id));
    assert.ok(ids.has(leadOwnId), 'EG lead visible');
    assert.ok(ids.has(leadOtherId), 'EG lead visible');
    assert.ok(ids.has(leadEgTeammateId), 'EG lead visible');
    assert.ok(!ids.has(leadSaId), 'SA lead hidden');
    assert.ok(!ids.has(leadAcmeNoAssigneeId), 'lead with NULL countryId hidden');
    assert.ok(!ids.has(leadOtherCompanyId), 'Other Co lead hidden');
  });

  it('list — company scope with no UserScopeAssignment returns empty', async () => {
    const res = await inTenant(() =>
      leads.list({ limit: 100, offset: 0 }, claimsFor(userCompanyNoAssignmentId, roleCompanyId)),
    );
    assert.equal(res.items.length, 0);
    assert.equal(res.total, 0);
  });

  // ─── LeadsService.findByIdInScopeOrThrow ─────────────────────────

  it('findByIdInScopeOrThrow — returns the lead when in scope', async () => {
    const got = await inTenant(() =>
      leads.findByIdInScopeOrThrow(leadOwnId, claimsFor(userOwnId, roleOwnId)),
    );
    assert.equal(got.id, leadOwnId);
  });

  it('findByIdInScopeOrThrow — 404s when accessing a lead outside own scope', async () => {
    await assert.rejects(
      () =>
        inTenant(() => leads.findByIdInScopeOrThrow(leadOtherId, claimsFor(userOwnId, roleOwnId))),
      (err: { response?: { code?: string } } & Error) => {
        assert.equal(err.response?.code, 'lead.not_found');
        return true;
      },
    );
  });

  it('findByIdInScopeOrThrow — 404s when company-scoped user has no assignments', async () => {
    await assert.rejects(
      () =>
        inTenant(() =>
          leads.findByIdInScopeOrThrow(
            leadOwnId,
            claimsFor(userCompanyNoAssignmentId, roleCompanyId),
          ),
        ),
      (err: { response?: { code?: string } } & Error) => {
        assert.equal(err.response?.code, 'lead.not_found');
        return true;
      },
    );
  });

  it('findByIdInScopeOrThrow — country scope sees EG lead, not SA lead', async () => {
    const eg = await inTenant(() =>
      leads.findByIdInScopeOrThrow(leadOwnId, claimsFor(userCountryEgId, roleCountryId)),
    );
    assert.equal(eg.id, leadOwnId);

    await assert.rejects(
      () =>
        inTenant(() =>
          leads.findByIdInScopeOrThrow(leadSaId, claimsFor(userCountryEgId, roleCountryId)),
        ),
      (err: { response?: { code?: string } } & Error) => {
        assert.equal(err.response?.code, 'lead.not_found');
        return true;
      },
    );
  });

  // ─── listByStage / listOverdue / listDueToday ────────────────────

  it('listByStage — own scope filters every stage bucket', async () => {
    const res = await inTenant(() =>
      leads.listByStage({ pipelineId, perStage: 50 }, claimsFor(userOwnId, roleOwnId)),
    );
    const allLeads = res.stages.flatMap((s) => s.leads.map((l) => l.id));
    assert.deepEqual(allLeads, [leadOwnId]);
  });

  it('listOverdue — own scope returns only the user own overdue lead', async () => {
    const res = await inTenant(() => leads.listOverdue({}, claimsFor(userOwnId, roleOwnId)));
    const ids = res.map((l) => l.id);
    assert.deepEqual(ids, [leadOwnId]);
  });

  it('listDueToday — team (EG) scope sees teammate lead due today', async () => {
    const res = await inTenant(() => leads.listDueToday({}, claimsFor(userTeamEgId, roleTeamId)));
    const ids = new Set(res.map((l) => l.id));
    assert.ok(ids.has(leadEgTeammateId));
  });

  // ─── Backwards compatibility — legacy calls without claims ──────

  it('list — without userClaims falls back to global behaviour (legacy fixtures)', async () => {
    const res = await inTenant(() => leads.list({ limit: 100, offset: 0 }));
    // Same total as the global-scope test above — 6 tenant leads.
    assert.ok(res.items.length >= 6);
  });
});
