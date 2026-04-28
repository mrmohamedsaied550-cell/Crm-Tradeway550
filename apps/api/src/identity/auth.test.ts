/**
 * Integration tests for the C9 auth API.
 *
 * Wires AuthService + its dependencies manually (no full Nest bootstrap).
 * Tests run against the real Postgres tenant data seeded in C8.
 *
 * Coverage:
 *   - login happy path (super_admin + Password@123)
 *   - login bad password -> auth.invalid_credentials
 *   - lockout after MAX_ATTEMPTS failures (auth.locked + locked_until set)
 *   - disabled user rejected (auth.disabled)
 *   - /me returns the correct shape
 *   - refresh rotation issues a new token pair
 *   - reuse detection (replaying an already-rotated refresh revokes the chain)
 *   - logout revokes the active session
 *   - logout-all revokes every active session for the user
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JwtService } from '@nestjs/jwt';
import { PrismaClient } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { TenantsService } from '../tenants/tenants.service';
import { AuthService } from './auth.service';
import { LockoutService } from './lockout.service';
import { SessionsService } from './sessions.service';
import { TokensService } from './tokens.service';
import { hashPassword } from './password.util';

const TENANT_CODE = 'trade_way_default';
const SEED_PASSWORD = process.env['SEED_DEFAULT_PASSWORD'] ?? 'Password@123';
const TEST_TENANT_CODE = '__c9_auth_test__';

const TEST_DISABLED_EMAIL = '__c9_disabled@auth.test';
const TEST_LOCKOUT_EMAIL = '__c9_lockout@auth.test';

let prisma: PrismaClient;
let auth: AuthService;
let testTenantId: string;
let salesAgentRoleId: string;

function buildAuth(): AuthService {
  const prismaSvc = new PrismaService();
  const tenants = new TenantsService(prismaSvc);
  const tokens = new TokensService(new JwtService());
  const sessions = new SessionsService(prismaSvc, tokens);
  const lockout = new LockoutService(prismaSvc);
  return new AuthService(prismaSvc, tenants, sessions, tokens, lockout);
}

async function withTenant<T>(tenantId: string, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return prisma.$transaction(async (tx: any) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.tenant_id = '${tenantId}'`);
    return fn(tx);
  });
}

describe('auth — login + me', () => {
  before(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    auth = buildAuth();
  });

  after(async () => {
    await prisma.$disconnect();
  });

  it('login with seeded super_admin returns tokens + user + capabilities', async () => {
    const result = await auth.login({
      email: 'super@tradeway.com',
      password: SEED_PASSWORD,
      tenantCode: TENANT_CODE,
    });
    assert.match(result.accessToken, /^[\w-]+\.[\w-]+\.[\w-]+$/);
    assert.match(result.refreshToken, /^[\w-]+\.[\w-]+\.[\w-]+$/);
    assert.equal(result.user.email, 'super@tradeway.com');
    assert.equal(result.user.role.code, 'super_admin');
    assert.equal(result.user.capabilities.length, 14);
    assert.ok(result.user.capabilities.includes('users.read'));
  });

  it('login with wrong password throws auth.invalid_credentials', async () => {
    await assert.rejects(
      () =>
        auth.login({
          email: 'super@tradeway.com',
          password: 'definitely-wrong',
          tenantCode: TENANT_CODE,
        }),
      /Invalid credentials/,
    );
  });

  it('login with unknown email throws auth.invalid_credentials', async () => {
    await assert.rejects(
      () =>
        auth.login({
          email: 'no-such-user@example.com',
          password: SEED_PASSWORD,
          tenantCode: TENANT_CODE,
        }),
      /Invalid credentials/,
    );
  });

  it('login with unknown tenant throws auth.invalid_credentials', async () => {
    await assert.rejects(
      () =>
        auth.login({
          email: 'super@tradeway.com',
          password: SEED_PASSWORD,
          tenantCode: 'no-such-tenant',
        }),
      /Invalid credentials/,
    );
  });

  it('me returns the same shape as login.user', async () => {
    const login = await auth.login({
      email: 'super@tradeway.com',
      password: SEED_PASSWORD,
      tenantCode: TENANT_CODE,
    });
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { code: TENANT_CODE } });
    const me = await auth.me(tenant.id, login.user.id);
    assert.equal(me.email, login.user.email);
    assert.equal(me.role.code, 'super_admin');
    assert.equal(me.capabilities.length, 14);
  });
});

describe('auth — lockout + disabled', () => {
  before(async () => {
    // Set up an isolated tenant so lockout state on a real seeded user
    // doesn't break other tests in the same run.
    const t = await prisma.tenant.upsert({
      where: { code: TEST_TENANT_CODE },
      update: { isActive: true },
      create: { code: TEST_TENANT_CODE, name: 'C9 auth test tenant' },
    });
    testTenantId = t.id;

    // Mirror trade_way_default's role catalogue minimally — we just need a role
    // to bind the test users to.
    const role = await withTenant(testTenantId, (tx) =>
      tx.role.upsert({
        where: { tenantId_code: { tenantId: testTenantId, code: 'sales_agent' } },
        update: {},
        create: {
          tenantId: testTenantId,
          code: 'sales_agent',
          nameAr: 'وكيل',
          nameEn: 'Sales Agent',
          level: 30,
        },
      }),
    );
    salesAgentRoleId = role.id;

    const hash = await hashPassword(SEED_PASSWORD, 4);

    // Seed a disabled user.
    await withTenant(testTenantId, (tx) =>
      tx.user.upsert({
        where: {
          tenantId_email: { tenantId: testTenantId, email: TEST_DISABLED_EMAIL },
        },
        update: { status: 'disabled', passwordHash: hash, roleId: salesAgentRoleId },
        create: {
          tenantId: testTenantId,
          email: TEST_DISABLED_EMAIL,
          name: 'Disabled User',
          passwordHash: hash,
          roleId: salesAgentRoleId,
          status: 'disabled',
        },
      }),
    );

    // Seed an active user we will lock out.
    await withTenant(testTenantId, (tx) =>
      tx.user.upsert({
        where: {
          tenantId_email: { tenantId: testTenantId, email: TEST_LOCKOUT_EMAIL },
        },
        update: {
          status: 'active',
          passwordHash: hash,
          roleId: salesAgentRoleId,
          failedLoginCount: 0,
          lockedUntil: null,
        },
        create: {
          tenantId: testTenantId,
          email: TEST_LOCKOUT_EMAIL,
          name: 'Lockout User',
          passwordHash: hash,
          roleId: salesAgentRoleId,
          status: 'active',
        },
      }),
    );
  });

  after(async () => {
    // Cascading delete cleans roles + users + sessions in the test tenant.
    await prisma.tenant.delete({ where: { code: TEST_TENANT_CODE } }).catch(() => {});
  });

  it('disabled user gets auth.disabled, not invalid_credentials', async () => {
    await assert.rejects(
      () =>
        auth.login({
          email: TEST_DISABLED_EMAIL,
          password: SEED_PASSWORD,
          tenantCode: TEST_TENANT_CODE,
        }),
      /Account is disabled/,
    );
  });

  it('5 wrong attempts lock the account; the 5th throws auth.locked', async () => {
    let lastErr: unknown;
    for (let i = 0; i < 5; i++) {
      try {
        await auth.login({
          email: TEST_LOCKOUT_EMAIL,
          password: 'wrong',
          tenantCode: TEST_TENANT_CODE,
        });
      } catch (e) {
        lastErr = e;
      }
    }
    // The fifth attempt fires the lockout branch.
    assert.match(String((lastErr as Error).message), /locked/i);

    // Subsequent good password still rejected with locked.
    await assert.rejects(
      () =>
        auth.login({
          email: TEST_LOCKOUT_EMAIL,
          password: SEED_PASSWORD,
          tenantCode: TEST_TENANT_CODE,
        }),
      /locked/i,
    );

    // DB row reflects the lock.
    const u = await withTenant(testTenantId, (tx) =>
      tx.user.findUniqueOrThrow({
        where: { tenantId_email: { tenantId: testTenantId, email: TEST_LOCKOUT_EMAIL } },
        select: { failedLoginCount: true, lockedUntil: true },
      }),
    );
    assert.notEqual(u.lockedUntil, null);
    assert.ok(u.lockedUntil!.getTime() > Date.now());
  });
});

describe('auth — refresh rotation + reuse detection + logout', () => {
  before(async () => {
    // Reset super_admin lock state before this suite (in case prior runs left
    // counters elevated). This is read-only data otherwise.
    const t = await prisma.tenant.findUniqueOrThrow({ where: { code: TENANT_CODE } });
    await withTenant(t.id, (tx) =>
      tx.user.updateMany({
        where: { email: 'super@tradeway.com' },
        data: { failedLoginCount: 0, lockedUntil: null },
      }),
    );
  });

  it('refresh rotates: new refresh token issued, user payload returned', async () => {
    const login = await auth.login({
      email: 'super@tradeway.com',
      password: SEED_PASSWORD,
      tenantCode: TENANT_CODE,
    });

    const rotated = await auth.refresh(login.refreshToken, {});
    // Refresh token always changes (different `sid`).
    assert.notEqual(rotated.refreshToken, login.refreshToken);
    // Access token is JWT-signed and may be byte-equal when both calls
    // resolve in the same wall-clock second — assert structural validity
    // instead of inequality.
    assert.match(rotated.accessToken, /^[\w-]+\.[\w-]+\.[\w-]+$/);
    assert.equal(rotated.user.email, 'super@tradeway.com');
  });

  it('replaying the original refresh after rotation revokes the chain', async () => {
    const login = await auth.login({
      email: 'super@tradeway.com',
      password: SEED_PASSWORD,
      tenantCode: TENANT_CODE,
    });
    const rotated = await auth.refresh(login.refreshToken, {});

    // Replay the old token — should be detected as reuse.
    await assert.rejects(() => auth.refresh(login.refreshToken, {}), /Invalid credentials/);

    // The rotated token should also be revoked now.
    await assert.rejects(() => auth.refresh(rotated.refreshToken, {}), /Invalid credentials/);
  });

  it('logout revokes the active session; subsequent refresh fails', async () => {
    const login = await auth.login({
      email: 'super@tradeway.com',
      password: SEED_PASSWORD,
      tenantCode: TENANT_CODE,
    });
    await auth.logout(login.refreshToken);
    await assert.rejects(() => auth.refresh(login.refreshToken, {}), /Invalid credentials/);
  });

  it('logout is idempotent on an unknown / already-revoked token', async () => {
    // Should not throw.
    await auth.logout('not.a.valid.token');
  });

  it('logoutAll revokes every active session for the user', async () => {
    const a = await auth.login({
      email: 'super@tradeway.com',
      password: SEED_PASSWORD,
      tenantCode: TENANT_CODE,
    });
    const b = await auth.login({
      email: 'super@tradeway.com',
      password: SEED_PASSWORD,
      tenantCode: TENANT_CODE,
    });
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { code: TENANT_CODE } });
    await auth.logoutAll(tenant.id, a.user.id);

    await assert.rejects(() => auth.refresh(a.refreshToken, {}), /Invalid credentials/);
    await assert.rejects(() => auth.refresh(b.refreshToken, {}), /Invalid credentials/);
  });
});
