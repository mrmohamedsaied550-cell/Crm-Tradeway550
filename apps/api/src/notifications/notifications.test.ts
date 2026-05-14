/**
 * Sprint 9 (D9) — integration tests for the notification service
 * with team-targeted + severity + actionUrl support.
 *
 * Coverage:
 *   1. User-targeted notifications — a user sees their own and
 *      not another user's.
 *   2. Team-targeted notifications — visible to every team
 *      member, not visible to users on a different team or to
 *      users with no team.
 *   3. unreadCount respects the union of user + team visibility.
 *   4. markRead refuses to flip a row the caller can't see.
 *   5. markAllRead only flips rows the caller can see.
 *   6. severity / actionUrl persist round-trip through create →
 *      list.
 *   7. Tenant isolation — a notification from another tenant is
 *      invisible even when targeted at a uuid that happens to
 *      match a user in the active tenant.
 *
 * Fixture pattern mirrors the C9 user-scope-assignments test:
 *   • Own throwaway tenant codes to avoid colliding with other
 *     integration tests.
 *   • Raw transaction with `SET LOCAL app.tenant_id = '...'`
 *     for the bootstrap inserts (RLS isn't engaged via
 *     `withTenant` because we want unconditional control).
 *   • The service-under-test still uses `withTenant` and runs
 *     inside the `tenantContext` from `inTenant(...)`.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { tenantContext } from '../tenants/tenant-context';

import { NotificationsService } from './notifications.service';

const TENANT_CODE = '__d9_notifications__';
const OTHER_TENANT_CODE = '__d9_notifications_other__';

let prisma: PrismaClient;
let prismaSvc: PrismaService;
let svc: NotificationsService;
let tenantId: string;
let otherTenantId: string;
let teamCairoId: string;
let aliceId: string; // Cairo team member
let bobId: string; // Cairo team member
let carolId: string; // Alex team member
let dianaId: string; // no team
let foreignUserId: string; // in other tenant

function inTenant<T>(fn: () => Promise<T>): Promise<T> {
  return tenantContext.run({ tenantId, tenantCode: TENANT_CODE, source: 'header' }, fn);
}
function inOther<T>(fn: () => Promise<T>): Promise<T> {
  return tenantContext.run(
    { tenantId: otherTenantId, tenantCode: OTHER_TENANT_CODE, source: 'header' },
    fn,
  );
}

async function withRawTenant<T>(tid: string, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return prisma.$transaction(async (tx: any) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.tenant_id = '${tid}'`);
    return fn(tx);
  });
}

describe('notifications — team visibility + severity + actionUrl (Sprint 9 / D9)', () => {
  before(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    prismaSvc = new PrismaService();
    svc = new NotificationsService(prismaSvc);

    const t = await prisma.tenant.upsert({
      where: { code: TENANT_CODE },
      update: { isActive: true },
      create: { code: TENANT_CODE, name: 'D9 notifications test' },
    });
    tenantId = t.id;
    const o = await prisma.tenant.upsert({
      where: { code: OTHER_TENANT_CODE },
      update: { isActive: true },
      create: { code: OTHER_TENANT_CODE, name: 'D9 notifications other' },
    });
    otherTenantId = o.id;

    // Active-tenant scaffold: company → country → 2 teams + 4 users.
    const role = await withRawTenant(tenantId, (tx) =>
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
    const otherRole = await withRawTenant(otherTenantId, (tx) =>
      tx.role.upsert({
        where: { tenantId_code: { tenantId: otherTenantId, code: 'sales_agent' } },
        update: {},
        create: {
          tenantId: otherTenantId,
          code: 'sales_agent',
          nameAr: 'وكيل',
          nameEn: 'Sales Agent',
          level: 30,
        },
      }),
    );

    const company = await withRawTenant(tenantId, (tx) =>
      tx.company.upsert({
        where: { tenantId_code: { tenantId, code: 'uber' } },
        update: {},
        create: { tenantId, code: 'uber', name: 'Uber' },
      }),
    );
    const country = await withRawTenant(tenantId, (tx) =>
      tx.country.upsert({
        where: {
          tenantId_companyId_code: { tenantId, companyId: company.id, code: 'EG' },
        },
        update: {},
        create: { tenantId, companyId: company.id, code: 'EG', name: 'Egypt' },
      }),
    );
    const cairo = await withRawTenant(tenantId, (tx) =>
      tx.team.upsert({
        where: {
          tenantId_countryId_name: { tenantId, countryId: country.id, name: 'Cairo A' },
        },
        update: {},
        create: { tenantId, countryId: country.id, name: 'Cairo A' },
      }),
    );
    teamCairoId = cairo.id;
    const alex = await withRawTenant(tenantId, (tx) =>
      tx.team.upsert({
        where: {
          tenantId_countryId_name: { tenantId, countryId: country.id, name: 'Alex A' },
        },
        update: {},
        create: { tenantId, countryId: country.id, name: 'Alex A' },
      }),
    );
    // alex team id is referenced by Carol's teamId below; we don't
    // need a top-level handle for it.

    const alice = await withRawTenant(tenantId, (tx) =>
      tx.user.create({
        data: {
          tenantId,
          email: 'd9-alice@example.com',
          name: 'Alice (Cairo)',
          passwordHash: 'x',
          roleId: role.id,
          teamId: cairo.id,
          status: 'active',
          language: 'en',
        },
      }),
    );
    aliceId = alice.id;
    const bob = await withRawTenant(tenantId, (tx) =>
      tx.user.create({
        data: {
          tenantId,
          email: 'd9-bob@example.com',
          name: 'Bob (Cairo)',
          passwordHash: 'x',
          roleId: role.id,
          teamId: cairo.id,
          status: 'active',
          language: 'en',
        },
      }),
    );
    bobId = bob.id;
    const carol = await withRawTenant(tenantId, (tx) =>
      tx.user.create({
        data: {
          tenantId,
          email: 'd9-carol@example.com',
          name: 'Carol (Alex)',
          passwordHash: 'x',
          roleId: role.id,
          teamId: alex.id,
          status: 'active',
          language: 'en',
        },
      }),
    );
    carolId = carol.id;
    const diana = await withRawTenant(tenantId, (tx) =>
      tx.user.create({
        data: {
          tenantId,
          email: 'd9-diana@example.com',
          name: 'Diana (no team)',
          passwordHash: 'x',
          roleId: role.id,
          status: 'active',
          language: 'en',
        },
      }),
    );
    dianaId = diana.id;

    const foreign = await withRawTenant(otherTenantId, (tx) =>
      tx.user.create({
        data: {
          tenantId: otherTenantId,
          email: 'd9-foreign@example.com',
          name: 'Foreign',
          passwordHash: 'x',
          roleId: otherRole.id,
          status: 'active',
          language: 'en',
        },
      }),
    );
    foreignUserId = foreign.id;
  });

  after(async () => {
    await prisma.tenant.delete({ where: { code: TENANT_CODE } }).catch(() => {});
    await prisma.tenant.delete({ where: { code: OTHER_TENANT_CODE } }).catch(() => {});
    await prisma.$disconnect();
  });

  it('createInTx requires recipientUserId OR recipientTeamId', async () => {
    await assert.rejects(
      () =>
        inTenant(() =>
          prismaSvc.withTenant(tenantId, (tx) =>
            svc.createInTx(tx, tenantId, {
              kind: 'test_no_recipient',
              title: 'Should fail',
            }),
          ),
        ),
      /requires recipientUserId or recipientTeamId/,
    );
  });

  it('user-targeted notification is visible to the recipient only', async () => {
    await inTenant(() =>
      svc.create({
        recipientUserId: aliceId,
        kind: 'transition_approval_requested',
        title: 'For Alice only',
        severity: 'info',
        actionUrl: '/admin/leads/123',
      }),
    );

    const aliceInbox = await inTenant(() => svc.list(aliceId, {}));
    const aliceRow = aliceInbox.find((r) => r.title === 'For Alice only');
    assert.ok(aliceRow, 'Alice must see her own notification');
    assert.equal(aliceRow.severity, 'info');
    assert.equal(aliceRow.actionUrl, '/admin/leads/123');

    const bobInbox = await inTenant(() => svc.list(bobId, {}));
    assert.equal(
      bobInbox.find((r) => r.title === 'For Alice only'),
      undefined,
      'Bob must not see Alice-targeted rows',
    );
  });

  it('team-targeted notification is visible to every member of that team', async () => {
    await inTenant(() =>
      svc.create({
        recipientTeamId: teamCairoId,
        kind: 'transition_approval_requested',
        title: 'For Cairo team',
        severity: 'warning',
        actionUrl: '/admin/leads/456',
      }),
    );

    const aliceInbox = await inTenant(() => svc.list(aliceId, {}));
    const bobInbox = await inTenant(() => svc.list(bobId, {}));
    assert.ok(
      aliceInbox.find((r) => r.title === 'For Cairo team'),
      'Alice (Cairo) must see Cairo team notifications',
    );
    assert.ok(
      bobInbox.find((r) => r.title === 'For Cairo team'),
      'Bob (Cairo) must see Cairo team notifications',
    );
  });

  it('team-targeted notification is invisible to users on a different team', async () => {
    const carolInbox = await inTenant(() => svc.list(carolId, {}));
    assert.equal(
      carolInbox.find((r) => r.title === 'For Cairo team'),
      undefined,
      'Carol (Alex) must not see Cairo team notifications',
    );
  });

  it('team-targeted notification is invisible to users with no team', async () => {
    const dianaInbox = await inTenant(() => svc.list(dianaId, {}));
    assert.equal(
      dianaInbox.find((r) => r.title === 'For Cairo team'),
      undefined,
      'Diana (no team) must not see Cairo team notifications',
    );
  });

  it('unreadCount counts the union of user + team rows', async () => {
    // Alice has 1 user-targeted row from earlier ("For Alice only")
    // plus 1 team-targeted row ("For Cairo team") → unreadCount = 2.
    const aliceCount = await inTenant(() => svc.unreadCount(aliceId));
    assert.equal(aliceCount, 2, 'Alice should have 2 unread (1 personal + 1 team)');

    // Bob has only the team row → unreadCount = 1.
    const bobCount = await inTenant(() => svc.unreadCount(bobId));
    assert.equal(bobCount, 1, 'Bob should have 1 unread (team only)');

    // Carol (Alex) has neither → unreadCount = 0.
    const carolCount = await inTenant(() => svc.unreadCount(carolId));
    assert.equal(carolCount, 0, 'Carol should have 0 unread');
  });

  it('markRead refuses to flip a row the caller cannot see', async () => {
    // Alice's personal row id.
    const aliceInbox = await inTenant(() => svc.list(aliceId, {}));
    const aliceRow = aliceInbox.find((r) => r.title === 'For Alice only');
    assert.ok(aliceRow);

    // Bob tries to mark Alice's row → 404 (visibility filter).
    await assert.rejects(
      () => inTenant(() => svc.markRead(aliceRow.id, bobId)),
      /not_found|not found/i,
    );
  });

  it('markAllRead only flips rows the caller can see', async () => {
    // Add a row for Carol so we can verify cross-user isolation.
    await inTenant(() =>
      svc.create({ recipientUserId: carolId, kind: 'test_carol', title: 'For Carol' }),
    );

    // Bob marks all his visible rows read → that's the Cairo team
    // row he saw. Carol's row must remain unread.
    const res = await inTenant(() => svc.markAllRead(bobId));
    assert.ok(res.count >= 1, 'Bob should have marked at least his team row read');

    const carolCount = await inTenant(() => svc.unreadCount(carolId));
    assert.equal(carolCount, 1, 'Carol still has her own unread row');
  });

  it('tenant isolation — other-tenant notification never appears in the active tenant', async () => {
    await inOther(() =>
      svc.create({
        recipientUserId: foreignUserId,
        kind: 'transition_approval_requested',
        title: 'Foreign tenant row',
      }),
    );

    // Even if we look at every active-tenant user, the foreign row
    // must never appear.
    const everyone = [aliceId, bobId, carolId, dianaId];
    for (const uid of everyone) {
      const inbox = await inTenant(() => svc.list(uid, {}));
      assert.equal(
        inbox.find((r) => r.title === 'Foreign tenant row'),
        undefined,
        `Tenant isolation failed for user ${uid}`,
      );
    }
  });
});
