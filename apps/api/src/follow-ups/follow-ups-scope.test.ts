/**
 * Phase C — C10A: scope enforcement for follow-ups.
 *
 * Mirrors `leads-scope.test.ts`'s fixture pattern but for the
 * `followup` resource. Throwaway tenant, three roles (own / team /
 * company / country / global) plus super_admin, two leads (one
 * owned by Alice in EG, one owned by Bob in SA via a different
 * company), and follow-ups on each.
 *
 * The product rule under test: a follow-up is visible to exactly
 * the same set of users that can see its parent lead. The
 * follow-up's own `assignedToId` is NOT consulted.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { ScopeContextService, type ScopeUserClaims } from '../rbac/scope-context.service';
import { tenantContext } from '../tenants/tenant-context';
import { TenantSettingsService } from '../tenants/tenant-settings.service';

import { FollowUpsService } from './follow-ups.service';

const TENANT_CODE = '__c10a_followup__';

let prisma: PrismaClient;
let prismaSvc: PrismaService;
let scope: ScopeContextService;
let svc: FollowUpsService;
let tenantId: string;

let companyAcmeId: string;
let companyOtherId: string;
let countryEgId: string;
let countrySaId: string;
let teamEgId: string;
let teamSaId: string;

let roleGlobalId: string;
let roleOwnId: string;
let roleTeamId: string;
let roleCompanyId: string;
let roleCountryId: string;
let roleSuperAdminId: string;

let userGlobalId: string;
let userSuperAdminId: string;
let userOwnAliceId: string;
let userOwnBobId: string;
let userTeamEgId: string;
let userTeamEgMateId: string;
let userTeamSaId: string;
let userCompanyAcmeId: string;
let userCountryEgId: string;

let pipelineId: string;
let newStageId: string;

let leadAliceEgAcmeId: string; // owned by Alice, EG, ACME
let leadBobSaOtherId: string; // owned by Bob, SA, OTHER company
let leadEgMateOwnedId: string; // owned by Alice's teammate, EG, ACME

let followUpAliceLeadId: string;
let followUpBobLeadId: string;
let followUpMateLeadId: string;

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

function claimsFor(userId: string, roleId: string): ScopeUserClaims {
  return { userId, tenantId, roleId };
}

describe('follow-ups — scope enforcement (C10A)', () => {
  before(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    prismaSvc = new PrismaService();
    scope = new ScopeContextService(prismaSvc);
    const audit = new AuditService(prismaSvc);
    const notifications = new NotificationsService(prismaSvc);
    const tenantSettings = new TenantSettingsService(prismaSvc, audit);
    svc = new FollowUpsService(prismaSvc, audit, notifications, tenantSettings, scope);

    const tenant = await prisma.tenant.upsert({
      where: { code: TENANT_CODE },
      update: { isActive: true },
      create: { code: TENANT_CODE, name: 'C10A follow-up scope' },
    });
    tenantId = tenant.id;

    await withTenantRaw(tenantId, async (tx) => {
      await tx.tenantSettings.upsert({
        where: { tenantId },
        update: {},
        create: { tenantId, timezone: 'Africa/Cairo', slaMinutes: 60, defaultDialCode: '+20' },
      });

      const acme = await tx.company.create({ data: { tenantId, code: 'acme', name: 'ACME' } });
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
        data: { tenantId, companyId: companyOtherId, code: 'SA', name: 'Saudi' },
      });
      countrySaId = sa.id;
      const teamEg = await tx.team.create({
        data: { tenantId, countryId: countryEgId, name: 'EG team' },
      });
      teamEgId = teamEg.id;
      const teamSa = await tx.team.create({
        data: { tenantId, countryId: countrySaId, name: 'SA team' },
      });
      teamSaId = teamSa.id;

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
            data: { tenantId, roleId: role.id, resource, scope: scopeValue },
          });
        }
        return role.id;
      }
      roleGlobalId = await makeRole('c10a_global', 'global');
      roleOwnId = await makeRole('c10a_own', 'own');
      roleTeamId = await makeRole('c10a_team', 'team');
      roleCompanyId = await makeRole('c10a_company', 'company');
      roleCountryId = await makeRole('c10a_country', 'country');
      // Super admin bypass — even with own scope on followup, sees all.
      roleSuperAdminId = await makeRole('super_admin', 'own');

      async function makeUser(emailLocal: string, roleId: string, teamId: string | null) {
        const u = await tx.user.create({
          data: {
            tenantId,
            email: `c10a-${emailLocal}@test`,
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
      userSuperAdminId = await makeUser('super', roleSuperAdminId, null);
      userOwnAliceId = await makeUser('alice', roleOwnId, null);
      userOwnBobId = await makeUser('bob', roleOwnId, null);
      userTeamEgId = await makeUser('teameg', roleTeamId, teamEgId);
      userTeamEgMateId = await makeUser('teamegmate', roleTeamId, teamEgId);
      userTeamSaId = await makeUser('teamsa', roleTeamId, teamSaId);
      userCompanyAcmeId = await makeUser('coacme', roleCompanyId, null);
      userCountryEgId = await makeUser('coueg', roleCountryId, null);

      // Scope assignments for company / country roles.
      await tx.userScopeAssignment.create({
        data: { tenantId, userId: userCompanyAcmeId, companyId: companyAcmeId },
      });
      await tx.userScopeAssignment.create({
        data: { tenantId, userId: userCountryEgId, countryId: countryEgId },
      });

      const pipe = await tx.pipeline.create({
        data: { tenantId, name: 'Default', isDefault: true, isActive: true },
        select: { id: true },
      });
      pipelineId = pipe.id;
      const sNew = await tx.pipelineStage.create({
        data: { tenantId, pipelineId, code: 'new', name: 'New', order: 10 },
      });
      newStageId = sNew.id;

      // Three leads:
      //   • Alice's own lead, EG, ACME
      //   • Bob's lead, SA, OTHER company
      //   • A teammate-of-Alice's lead, EG, ACME
      const leadAlice = await tx.lead.create({
        data: {
          tenantId,
          stageId: newStageId,
          pipelineId,
          name: 'Alice lead',
          phone: '+20100000001',
          source: 'manual',
          assignedToId: userOwnAliceId,
          companyId: companyAcmeId,
          countryId: countryEgId,
        },
      });
      leadAliceEgAcmeId = leadAlice.id;
      const leadBob = await tx.lead.create({
        data: {
          tenantId,
          stageId: newStageId,
          pipelineId,
          name: 'Bob lead',
          phone: '+966500000001',
          source: 'manual',
          assignedToId: userOwnBobId,
          companyId: companyOtherId,
          countryId: countrySaId,
        },
      });
      leadBobSaOtherId = leadBob.id;
      const leadMate = await tx.lead.create({
        data: {
          tenantId,
          stageId: newStageId,
          pipelineId,
          name: 'EG mate lead',
          phone: '+20100000003',
          source: 'manual',
          assignedToId: userTeamEgMateId,
          companyId: companyAcmeId,
          countryId: countryEgId,
        },
      });
      leadEgMateOwnedId = leadMate.id;

      // One pending follow-up per lead, due tomorrow, assigned to the
      // lead's owner so the `assignedToId` filter on `listMine` matches
      // when the owner queries.
      const dueAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const fAlice = await tx.leadFollowUp.create({
        data: {
          tenantId,
          leadId: leadAliceEgAcmeId,
          actionType: 'call',
          dueAt,
          assignedToId: userOwnAliceId,
        },
      });
      followUpAliceLeadId = fAlice.id;
      const fBob = await tx.leadFollowUp.create({
        data: {
          tenantId,
          leadId: leadBobSaOtherId,
          actionType: 'call',
          dueAt,
          assignedToId: userOwnBobId,
        },
      });
      followUpBobLeadId = fBob.id;
      const fMate = await tx.leadFollowUp.create({
        data: {
          tenantId,
          leadId: leadEgMateOwnedId,
          actionType: 'call',
          dueAt,
          assignedToId: userTeamEgMateId,
        },
      });
      followUpMateLeadId = fMate.id;
    });
  });

  after(async () => {
    await prisma.tenant.delete({ where: { code: TENANT_CODE } }).catch(() => {});
    await prisma.$disconnect();
  });

  // ───────────────────────────────────────────────────────────────────
  // listForLead — read-side scope on the parent lead
  // ───────────────────────────────────────────────────────────────────

  it('listForLead: own scope → 200 on own lead, lead.not_found on other owners', async () => {
    const aliceClaims = claimsFor(userOwnAliceId, roleOwnId);
    const aliceFollowUps = await inTenant(() => svc.listForLead(leadAliceEgAcmeId, aliceClaims));
    assert.equal(aliceFollowUps.length, 1);

    await assert.rejects(
      () => inTenant(() => svc.listForLead(leadBobSaOtherId, aliceClaims)),
      /not found in active tenant/,
    );
  });

  it('listForLead: team scope → teammate-owned lead is visible', async () => {
    const teamClaims = claimsFor(userTeamEgId, roleTeamId);
    const rows = await inTenant(() => svc.listForLead(leadEgMateOwnedId, teamClaims));
    assert.equal(rows.length, 1);

    // SA team's lead is NOT visible.
    await assert.rejects(
      () => inTenant(() => svc.listForLead(leadBobSaOtherId, teamClaims)),
      /not found in active tenant/,
    );
  });

  it('listForLead: company scope → leads inside assigned company visible', async () => {
    const companyClaims = claimsFor(userCompanyAcmeId, roleCompanyId);
    const rows = await inTenant(() => svc.listForLead(leadAliceEgAcmeId, companyClaims));
    assert.equal(rows.length, 1);
    await assert.rejects(
      () => inTenant(() => svc.listForLead(leadBobSaOtherId, companyClaims)),
      /not found in active tenant/,
    );
  });

  it('listForLead: country scope → leads in assigned country only', async () => {
    const countryClaims = claimsFor(userCountryEgId, roleCountryId);
    const rows = await inTenant(() => svc.listForLead(leadAliceEgAcmeId, countryClaims));
    assert.equal(rows.length, 1);
    await assert.rejects(
      () => inTenant(() => svc.listForLead(leadBobSaOtherId, countryClaims)),
      /not found in active tenant/,
    );
  });

  it('listForLead: global → every parent lead visible', async () => {
    const globalClaims = claimsFor(userGlobalId, roleGlobalId);
    const rows = await inTenant(() => svc.listForLead(leadBobSaOtherId, globalClaims));
    assert.equal(rows.length, 1);
  });

  it('listForLead: super_admin bypass — even with own scope sees foreign follow-ups', async () => {
    const superClaims = claimsFor(userSuperAdminId, roleSuperAdminId);
    const rows = await inTenant(() => svc.listForLead(leadBobSaOtherId, superClaims));
    assert.equal(rows.length, 1);
  });

  // ───────────────────────────────────────────────────────────────────
  // listInRange — calendar feed honours scope on top of caller filter
  // ───────────────────────────────────────────────────────────────────

  it('listInRange: team-scoped user sees only follow-ups on team-visible leads', async () => {
    const teamClaims = claimsFor(userTeamEgId, roleTeamId);
    const from = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const to = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    // mine='0' + allowAllAssignees → tenant-wide window pre-scope.
    const rows = await inTenant(() =>
      svc.listInRange(
        userTeamEgId,
        { from, to, mine: '0', limit: 100, allowAllAssignees: true },
        teamClaims,
      ),
    );
    // Expect: only the EG-team lead's follow-up (Alice is NOT on EG
    // team). Bob's SA lead is excluded.
    const ids = rows.map((r) => r.id).sort();
    assert.deepEqual(ids, [followUpMateLeadId].sort());
  });

  it('listInRange: global scope sees every follow-up tenant-wide', async () => {
    const globalClaims = claimsFor(userGlobalId, roleGlobalId);
    const from = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const to = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const rows = await inTenant(() =>
      svc.listInRange(
        userGlobalId,
        { from, to, mine: '0', limit: 100, allowAllAssignees: true },
        globalClaims,
      ),
    );
    const ids = new Set(rows.map((r) => r.id));
    assert.ok(ids.has(followUpAliceLeadId));
    assert.ok(ids.has(followUpBobLeadId));
    assert.ok(ids.has(followUpMateLeadId));
  });

  // ───────────────────────────────────────────────────────────────────
  // listMine — caller's follow-ups, narrowed by scope
  // ───────────────────────────────────────────────────────────────────

  it('listMine: company-scoped user only sees their own follow-ups on in-scope leads', async () => {
    // Manufacture: Bob's user is own-scoped today; promote a fresh
    // user inside this test would be heavier than necessary. Instead,
    // assign Bob's follow-up to userCompanyAcmeId so the assignee
    // filter matches but the parent lead is in the OTHER company.
    await withTenantRaw(tenantId, (tx) =>
      tx.leadFollowUp.update({
        where: { id: followUpBobLeadId },
        data: { assignedToId: userCompanyAcmeId },
      }),
    );
    const claims = claimsFor(userCompanyAcmeId, roleCompanyId);
    const rows = await inTenant(() =>
      svc.listMine(userCompanyAcmeId, { status: 'all', limit: 100 }, claims),
    );
    const ids = rows.map((r) => r.id);
    // Bob's follow-up is on a lead in the OTHER company; even though
    // userCompanyAcmeId is the assignee, scope should hide it.
    assert.equal(
      ids.includes(followUpBobLeadId),
      false,
      'company scope must hide cross-company follow-up even when assigned to caller',
    );
    // Restore.
    await withTenantRaw(tenantId, (tx) =>
      tx.leadFollowUp.update({
        where: { id: followUpBobLeadId },
        data: { assignedToId: userOwnBobId },
      }),
    );
  });

  // ───────────────────────────────────────────────────────────────────
  // summaryForUser — counters reflect scope
  // ───────────────────────────────────────────────────────────────────

  it('summaryForUser: counts shrink to scope-visible follow-ups', async () => {
    // Reuse same trick: assign Bob's follow-up to country-scoped user,
    // due-today; expect that scope hides it from the country user's
    // counters.
    const dueToday = new Date();
    dueToday.setHours(12, 0, 0, 0);
    await withTenantRaw(tenantId, (tx) =>
      tx.leadFollowUp.update({
        where: { id: followUpBobLeadId },
        data: { assignedToId: userCountryEgId, dueAt: dueToday },
      }),
    );
    const claims = claimsFor(userCountryEgId, roleCountryId);
    const summary = await inTenant(() => svc.summaryForUser(userCountryEgId, claims));
    assert.equal(
      summary.dueTodayCount,
      0,
      'follow-up on a lead in SA must not count toward EG-country user',
    );
    // Restore.
    await withTenantRaw(tenantId, (tx) =>
      tx.leadFollowUp.update({
        where: { id: followUpBobLeadId },
        data: {
          assignedToId: userOwnBobId,
          dueAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      }),
    );
  });

  // ───────────────────────────────────────────────────────────────────
  // write paths — out-of-scope parent lead → lead.not_found
  // ───────────────────────────────────────────────────────────────────

  it('create: rejects when parent lead is outside the actor scope', async () => {
    const aliceClaims = claimsFor(userOwnAliceId, roleOwnId);
    await assert.rejects(
      () =>
        inTenant(() =>
          svc.create(
            leadBobSaOtherId,
            { actionType: 'call', dueAt: new Date(Date.now() + 3600_000).toISOString() },
            userOwnAliceId,
            aliceClaims,
          ),
        ),
      /not found in active tenant/,
    );
  });

  it('update: rejects when parent lead is outside the actor scope', async () => {
    const aliceClaims = claimsFor(userOwnAliceId, roleOwnId);
    await assert.rejects(
      () =>
        inTenant(() =>
          svc.update(
            followUpBobLeadId,
            { snoozedUntil: new Date(Date.now() + 86400_000).toISOString() },
            userOwnAliceId,
            aliceClaims,
          ),
        ),
      /not found in active tenant/,
    );
  });

  it('complete: rejects when parent lead is outside the actor scope', async () => {
    const aliceClaims = claimsFor(userOwnAliceId, roleOwnId);
    await assert.rejects(
      () => inTenant(() => svc.complete(followUpBobLeadId, userOwnAliceId, aliceClaims)),
      /not found in active tenant/,
    );
  });

  it('remove: rejects when parent lead is outside the actor scope', async () => {
    const aliceClaims = claimsFor(userOwnAliceId, roleOwnId);
    await assert.rejects(
      () => inTenant(() => svc.remove(followUpBobLeadId, userOwnAliceId, aliceClaims)),
      /not found in active tenant/,
    );
    // Confirm the row still exists.
    const stillThere = await withTenantRaw(tenantId, (tx) =>
      tx.leadFollowUp.findUnique({ where: { id: followUpBobLeadId }, select: { id: true } }),
    );
    assert.ok(stillThere, 'rejected delete must not have removed the row');
  });

  it('write paths: super_admin bypass allows mutating cross-scope follow-ups', async () => {
    const superClaims = claimsFor(userSuperAdminId, roleSuperAdminId);
    const created = await inTenant(() =>
      svc.create(
        leadBobSaOtherId,
        { actionType: 'call', dueAt: new Date(Date.now() + 3600_000).toISOString() },
        userSuperAdminId,
        superClaims,
      ),
    );
    assert.ok(created.id);
  });

  it('write paths: legacy callers without claims still work (back-compat)', async () => {
    const created = await inTenant(() =>
      svc.create(
        leadAliceEgAcmeId,
        { actionType: 'call', dueAt: new Date(Date.now() + 3600_000).toISOString() },
        userOwnAliceId,
        // no claims → resolver returns null → no extra filter
      ),
    );
    assert.ok(created.id);
  });

  // Reference unused fixture vars to avoid noUnusedLocals when the
  // suite is trimmed — keeps the fixture intent clear.
  it('fixture references stay live', () => {
    void teamSaId;
    void userTeamSaId;
    void leadEgMateOwnedId;
    void followUpMateLeadId;
  });
});
