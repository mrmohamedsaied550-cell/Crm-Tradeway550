/**
 * C27 — `TenantContextMiddleware` production gates.
 *
 * The middleware accepts the `X-Tenant` header as a dev fallback.
 * Production must reject it: the only accepted source of tenant scope
 * in deployed environments is a verified JWT `tid` claim.
 *
 * No Postgres, no Express server — we drive the middleware with stub
 * Request objects and stub TenantsService / TokensService.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { TenantContextMiddleware } from './tenant-context.middleware';
import { tenantContext } from './tenant-context';
import type { TenantsService } from './tenants.service';
import type { TokensService } from '../identity/tokens.service';

interface FakeReq {
  header(name: string): string | undefined;
}

function makeReq(headers: Record<string, string>): FakeReq {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return { header: (name) => lower[name.toLowerCase()] };
}

const tenantsStub = {
  findById: async () => null,
  findByCode: async (code: string) =>
    code === 'acme'
      ? {
          id: '00000000-0000-4000-8000-000000000001',
          code: 'acme',
          isActive: true,
          name: 'Acme',
        }
      : null,
} as unknown as TenantsService;

const tokensStub = {
  verifyAccess: () => {
    throw new Error('no jwt');
  },
} as unknown as TokensService;

describe('tenants/tenant-context.middleware (C27 production gates)', () => {
  const originalNodeEnv = process.env['NODE_ENV'];

  afterEach(() => {
    process.env['NODE_ENV'] = originalNodeEnv;
  });

  it('honours X-Tenant header outside production', async () => {
    process.env['NODE_ENV'] = 'test';
    const mw = new TenantContextMiddleware(tenantsStub, tokensStub);

    let resolvedSource: string | undefined;
    await new Promise<void>((resolve, reject) => {
      // The middleware's body uses `tenantContext.run(...)` which keeps
      // the store live for the duration of `next()` — read the value
      // from inside that call.
      const next = (): void => {
        resolvedSource = tenantContext.getStore()?.source;
        resolve();
      };
      mw.use(makeReq({ 'x-tenant': 'acme' }) as never, {} as never, next).catch(reject);
    });
    assert.equal(resolvedSource, 'header');
  });

  it('IGNORES X-Tenant header in production — request passes through unscoped', async () => {
    process.env['NODE_ENV'] = 'production';
    const mw = new TenantContextMiddleware(tenantsStub, tokensStub);

    let storeAtNext: ReturnType<typeof tenantContext.getStore>;
    await new Promise<void>((resolve, reject) => {
      const next = (): void => {
        storeAtNext = tenantContext.getStore();
        resolve();
      };
      mw.use(makeReq({ 'x-tenant': 'acme' }) as never, {} as never, next).catch(reject);
    });
    assert.equal(storeAtNext, undefined, 'production must not honour the X-Tenant fallback');
  });
});
