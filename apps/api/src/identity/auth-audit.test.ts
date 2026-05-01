/**
 * P2-04 — auth audit-event tests.
 *
 * Real Postgres + a throwaway tenant. Wires AuthService with a real
 * AuditService and asserts that every supported flow emits the
 * expected `auth.*` row, with IP + user-agent in the payload.
 *
 * Audit writes are dispatched fire-and-forget (the auth path does
 * not await them) so each test that asserts a row settles a
 * `setImmediate` before reading the audit table.
 */

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JwtService } from '@nestjs/jwt';
import { PrismaClient } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { TenantsService } from '../tenants/tenants.service';
import { hashPassword } from './password.util';
import { AuthService } from './auth.service';
import { LockoutService } from './lockout.service';
import { SessionsService } from './sessions.service';
import { TokensService } from './tokens.service';

const TENANT_CODE = '__p2_04_auth_audit__';
const PWD = 'Password@123';
const IP = '203.0.113.7';
const UA = 'p2-04-test-agent/1.0';

let prisma: PrismaClient;
let auth: AuthService;
let prismaSvc: PrismaService;
let tenantId: string;
let userEmail: string;

async function withTenantRaw<T>(tid: string, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return prisma.$transaction(async (tx: any) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.tenant_id = '${tid}'`);
    return fn(tx);
  });
}

/**
 * Audit writes are fire-and-forget. The auth methods return BEFORE
 * the underlying `prisma.withTenant(...)` resolves, so we have to
 * settle the microtask + macrotask queues before querying the
 * audit_events table.
 */
async function settle(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

async function readAuthRows(): Promise<
  { action: string; payload: unknown; actor: string | null }[]
> {
  return withTenantRaw(tenantId, async (tx) => {
    const rows = await tx.auditEvent.findMany({
      where: { action: { startsWith: 'auth.' } },
      orderBy: { createdAt: 'desc' },
      select: { action: true, payload: true, actorUserId: true },
    });
    return rows.map((r) => ({ action: r.action, payload: r.payload, actor: r.actorUserId }));
  });
}

describe('auth — audit log (P2-04)', () => {
  before(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    prismaSvc = new PrismaService();
    const tenants = new TenantsService(prismaSvc);
    const tokens = new TokensService(new JwtService());
    const sessions = new SessionsService(prismaSvc, tokens);
    const lockout = new LockoutService(prismaSvc);
    const audit = new AuditService(prismaSvc);
    auth = new AuthService(prismaSvc, tenants, sessions, tokens, lockout, audit);

    const tenant = await prisma.tenant.upsert({
      where: { code: TENANT_CODE },
      update: { isActive: true },
      create: { code: TENANT_CODE, name: 'P2-04 auth audit' },
    });
    tenantId = tenant.id;
    userEmail = `p204-user-${tenant.id.slice(0, 6)}@auth.test`;

    await withTenantRaw(tenantId, async (tx) => {
      const role = await tx.role.create({
        data: {
          tenantId,
          code: 'sales_agent',
          nameAr: 'وكيل',
          nameEn: 'Sales Agent',
          level: 30,
        },
      });
      await tx.user.create({
        data: {
          tenantId,
          email: userEmail,
          name: 'P2-04 user',
          passwordHash: await hashPassword(PWD, 4),
          roleId: role.id,
        },
      });
    });
  });

  after(async () => {
    await prisma.tenant.delete({ where: { code: TENANT_CODE } }).catch(() => {});
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    // Each test starts with a clean audit table + fresh user counters
    // so failures from one case can't bleed into another's expectations.
    await withTenantRaw(tenantId, async (tx) => {
      await tx.auditEvent.deleteMany({ where: { action: { startsWith: 'auth.' } } });
      await tx.user.updateMany({
        where: { email: userEmail },
        data: { failedLoginCount: 0, lockedUntil: null, status: 'active' },
      });
    });
  });

  it('writes auth.login.success on a valid login (with ip + user-agent)', async () => {
    await auth.login({
      email: userEmail,
      password: PWD,
      tenantCode: TENANT_CODE,
      ip: IP,
      userAgent: UA,
    });
    await settle();
    const rows = await readAuthRows();
    const success = rows.find((r) => r.action === 'auth.login.success');
    assert.ok(success, 'expected auth.login.success row');
    const payload = success!.payload as Record<string, unknown>;
    assert.equal(payload.ip, IP);
    assert.equal(payload.userAgent, UA);
    assert.equal(payload.email, userEmail);
    assert.ok(typeof payload.sessionId === 'string');
  });

  it('writes auth.login.failed with reason=wrong_password on bad password', async () => {
    await assert.rejects(() =>
      auth.login({
        email: userEmail,
        password: 'wrong-password',
        tenantCode: TENANT_CODE,
        ip: IP,
        userAgent: UA,
      }),
    );
    await settle();
    const rows = await readAuthRows();
    const failed = rows.find((r) => r.action === 'auth.login.failed');
    assert.ok(failed, 'expected auth.login.failed row');
    const payload = failed!.payload as Record<string, unknown>;
    assert.equal(payload.reason, 'wrong_password');
    assert.equal(payload.email, userEmail);
    assert.equal(payload.ip, IP);
  });

  it('writes auth.login.failed with reason=user_not_found for a missing email', async () => {
    await assert.rejects(() =>
      auth.login({
        email: 'no-such-user@nope.test',
        password: PWD,
        tenantCode: TENANT_CODE,
        ip: IP,
        userAgent: UA,
      }),
    );
    await settle();
    const rows = await readAuthRows();
    const failed = rows.find((r) => r.action === 'auth.login.failed');
    assert.ok(failed);
    const payload = failed!.payload as Record<string, unknown>;
    assert.equal(payload.reason, 'user_not_found');
    assert.equal(failed!.actor, null);
  });

  it('writes auth.lockout when the 5th failure tips into a locked state', async () => {
    for (let i = 0; i < LockoutService.MAX_ATTEMPTS; i += 1) {
      await assert.rejects(() =>
        auth.login({
          email: userEmail,
          password: 'wrong',
          tenantCode: TENANT_CODE,
          ip: IP,
          userAgent: UA,
        }),
      );
    }
    await settle();
    const rows = await readAuthRows();
    const lockout = rows.find((r) => r.action === 'auth.lockout');
    assert.ok(lockout, 'expected auth.lockout row');
    const payload = lockout!.payload as Record<string, unknown>;
    assert.equal(payload.email, userEmail);
    assert.ok(typeof payload.lockedUntil === 'string');
    // Must also have written 5 wrong_password failures.
    const wrongPwd = rows.filter(
      (r) =>
        r.action === 'auth.login.failed' &&
        (r.payload as Record<string, unknown>).reason === 'wrong_password',
    );
    assert.equal(wrongPwd.length, LockoutService.MAX_ATTEMPTS);
  });

  it('writes auth.token.refresh on a valid rotation', async () => {
    const session = await auth.login({
      email: userEmail,
      password: PWD,
      tenantCode: TENANT_CODE,
      ip: IP,
      userAgent: UA,
    });
    await auth.refresh(session.refreshToken, { ip: IP, userAgent: UA });
    await settle();
    const rows = await readAuthRows();
    const rotated = rows.find((r) => r.action === 'auth.token.refresh');
    assert.ok(rotated, 'expected auth.token.refresh row');
    const payload = rotated!.payload as Record<string, unknown>;
    assert.equal(payload.ip, IP);
    assert.ok(typeof payload.newSessionId === 'string');
    assert.ok(typeof payload.oldSessionId === 'string');
    assert.notEqual(payload.newSessionId, payload.oldSessionId);
  });

  it('writes auth.token.refresh.reuse_detected when a rotated refresh is replayed', async () => {
    const session = await auth.login({
      email: userEmail,
      password: PWD,
      tenantCode: TENANT_CODE,
    });
    await auth.refresh(session.refreshToken, {});
    // Replay the now-rotated original — the service should fire
    // reuse-detected and revoke the descendant chain.
    await assert.rejects(() => auth.refresh(session.refreshToken, { ip: IP }));
    await settle();
    const rows = await readAuthRows();
    const reuse = rows.find((r) => r.action === 'auth.token.refresh.reuse_detected');
    assert.ok(reuse, 'expected auth.token.refresh.reuse_detected row');
  });

  it('writes auth.logout on a successful logout', async () => {
    const session = await auth.login({
      email: userEmail,
      password: PWD,
      tenantCode: TENANT_CODE,
    });
    await auth.logout(session.refreshToken, { ip: IP, userAgent: UA });
    await settle();
    const rows = await readAuthRows();
    const logout = rows.find((r) => r.action === 'auth.logout');
    assert.ok(logout, 'expected auth.logout row');
    const payload = logout!.payload as Record<string, unknown>;
    assert.equal(payload.ip, IP);
    assert.ok(typeof payload.sessionId === 'string');
  });

  it('writes auth.logout.all on logoutAll', async () => {
    const me = await auth.login({
      email: userEmail,
      password: PWD,
      tenantCode: TENANT_CODE,
    });
    await auth.logoutAll(tenantId, me.user.id, { ip: IP, userAgent: UA });
    await settle();
    const rows = await readAuthRows();
    assert.ok(rows.find((r) => r.action === 'auth.logout.all'));
  });

  it('list({ action: "auth.*" }) returns only auth rows', async () => {
    await auth.login({
      email: userEmail,
      password: PWD,
      tenantCode: TENANT_CODE,
      ip: IP,
    });
    await settle();
    // Borrow a tenant context for the AuditService.list call.
    const { tenantContext } = await import('../tenants/tenant-context');
    const auditSvc = new AuditService(prismaSvc);
    const rows = await tenantContext.run(
      { tenantId, tenantCode: TENANT_CODE, source: 'header' },
      () => auditSvc.list({ action: 'auth.*', limit: 50 }),
    );
    assert.ok(rows.length > 0);
    for (const r of rows) {
      assert.match(r.action, /^auth\./);
    }
  });
});
