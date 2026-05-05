/**
 * Phase D5 — D5.3: FieldRedactionInterceptor.
 *
 * Pure unit tests (no Postgres). Each test builds a stub
 * PermissionResolverService that returns a deterministic
 * deniedReadFieldsByResource map, runs the interceptor against a
 * synthesised ExecutionContext + CallHandler, and asserts the
 * outgoing payload shape.
 *
 * Locked behaviours:
 *   1. No `@ResourceFieldGate` metadata → response unchanged.
 *   2. Flag off (D5_DYNAMIC_PERMISSIONS_V1=false) → response unchanged.
 *   3. Flag on + super-admin (empty deny list) → unchanged.
 *   4. Flag on + deny rows on a single object → fields stripped.
 *   5. Flag on + deny rows on a pagination envelope { items: [...] } →
 *      `items` filtered, envelope keys (total, limit, offset) preserved.
 *   6. Flag on + deny rows on a plain array → array filtered.
 *   7. `lead.id` survives even if a deny row is present
 *      (`isRedactable` short-circuit).
 *   8. Primitives / null are returned untouched.
 *   9. No req.user (defensive) → response unchanged.
 *  10. Filtering twice through the legacy service-layer + interceptor
 *      is idempotent — proven by re-running on already-stripped data.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Reflector } from '@nestjs/core';
import { firstValueFrom, of, type Observable } from 'rxjs';
import type { CallHandler, ExecutionContext } from '@nestjs/common';

import { FieldFilterService } from './field-filter.service';
import { FieldRedactionInterceptor } from './field-redaction.interceptor';
import { PermissionResolverService, type ResolvedPermissions } from './permission-resolver.service';
import { RESOURCE_FIELD_GATE_KEY } from './resource-field-gate.decorator';

// ─── helpers ──────────────────────────────────────────────────────

function makeCtx(opts: { req: unknown; metadata?: string }): ExecutionContext {
  const handler = function fakeHandler() {
    /* placeholder */
  };
  if (opts.metadata) {
    Reflect.defineMetadata(RESOURCE_FIELD_GATE_KEY, opts.metadata, handler);
  }
  return {
    switchToHttp: () => ({ getRequest: () => opts.req }),
    getHandler: () => handler,
    getClass: () =>
      class Anon {
        /* placeholder class */
      },
  } as unknown as ExecutionContext;
}

function handlerOf<T>(value: T): CallHandler<T> {
  return {
    handle: (): Observable<T> => of(value),
  };
}

function bundle(opts: {
  code?: string;
  deniedRead?: Record<string, readonly string[]>;
}): ResolvedPermissions {
  return {
    tenantId: 't1',
    userId: 'u1',
    role: {
      id: 'r1',
      code: opts.code ?? 'tl_sales',
      level: 60,
      isSystem: true,
      versionTag: 0,
    },
    capabilities: ['lead.read'],
    scopesByResource: {},
    deniedReadFieldsByResource: opts.deniedRead ?? {},
    deniedWriteFieldsByResource: {},
    userScopes: { companyIds: [], countryIds: [] },
    servedFromCache: false,
  };
}

function makeResolver(resolved: ResolvedPermissions): PermissionResolverService {
  return {
    resolveForUser: async () => resolved,
  } as unknown as PermissionResolverService;
}

const fieldFilter = new FieldFilterService(
  // FieldFilterService.filterRead / filterReadMany don't touch the
  // PrismaService — they're pure functions. Pass an empty stub.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  {} as any,
);

const USER = { typ: 'access' as const, sub: 'u1', tid: 't1', rid: 'r1' };

// Save + restore the env flag so each test runs in isolation.
const ORIGINAL_FLAG = process.env['D5_DYNAMIC_PERMISSIONS_V1'];
function setFlag(value: 'true' | 'false' | undefined): void {
  if (value === undefined) {
    delete process.env['D5_DYNAMIC_PERMISSIONS_V1'];
  } else {
    process.env['D5_DYNAMIC_PERMISSIONS_V1'] = value;
  }
}

// ─── tests ────────────────────────────────────────────────────────

describe('rbac/FieldRedactionInterceptor — D5.3', () => {
  let interceptor: FieldRedactionInterceptor;

  beforeEach(() => {
    setFlag('true');
  });

  afterEach(() => {
    setFlag(ORIGINAL_FLAG === undefined ? undefined : (ORIGINAL_FLAG as 'true' | 'false'));
  });

  it('no @ResourceFieldGate metadata → response unchanged', async () => {
    const resolver = makeResolver(bundle({ deniedRead: { lead: ['previousOwner'] } }));
    interceptor = new FieldRedactionInterceptor(new Reflector(), resolver, fieldFilter);

    const payload = { id: 'lead-1', previousOwner: { id: 'u-prev' } };
    const ctx = makeCtx({ req: { user: USER } /* no metadata */ });
    const out = await firstValueFrom(interceptor.intercept(ctx, handlerOf(payload)));
    assert.deepEqual(out, payload);
    assert.equal((out as Record<string, unknown>)['previousOwner'], payload.previousOwner);
  });

  it('flag off (D5_DYNAMIC_PERMISSIONS_V1=false) → response unchanged even with metadata', async () => {
    setFlag('false');
    const resolver = makeResolver(
      bundle({ deniedRead: { lead: ['previousOwner', 'attribution.campaign'] } }),
    );
    interceptor = new FieldRedactionInterceptor(new Reflector(), resolver, fieldFilter);

    const payload = {
      id: 'lead-1',
      previousOwner: { id: 'u-prev', name: 'Prev' },
      attribution: { campaign: 'eg_q2_2026' },
    };
    const ctx = makeCtx({ req: { user: USER }, metadata: 'lead' });
    const out = await firstValueFrom(interceptor.intercept(ctx, handlerOf(payload)));
    assert.deepEqual(out, payload);
  });

  it('super_admin bypass → empty deny list returns response unchanged', async () => {
    const resolver = makeResolver(bundle({ code: 'super_admin', deniedRead: {} }));
    interceptor = new FieldRedactionInterceptor(new Reflector(), resolver, fieldFilter);

    const payload = { id: 'lead-1', previousOwner: { id: 'u-prev' } };
    const ctx = makeCtx({ req: { user: USER }, metadata: 'lead' });
    const out = await firstValueFrom(interceptor.intercept(ctx, handlerOf(payload)));
    assert.deepEqual(out, payload);
  });

  it('deny rows on a single object → fields stripped', async () => {
    const resolver = makeResolver(
      bundle({ deniedRead: { lead: ['previousOwner', 'attribution.campaign'] } }),
    );
    interceptor = new FieldRedactionInterceptor(new Reflector(), resolver, fieldFilter);

    const payload = {
      id: 'lead-1',
      name: 'Captain X',
      previousOwner: { id: 'u-prev', name: 'Prev' },
      attribution: { source: 'meta', campaign: 'eg_q2_2026' },
    };
    const ctx = makeCtx({ req: { user: USER }, metadata: 'lead' });
    const out = (await firstValueFrom(interceptor.intercept(ctx, handlerOf(payload)))) as Record<
      string,
      unknown
    >;
    assert.equal(out['id'], 'lead-1');
    assert.equal(out['name'], 'Captain X');
    assert.equal('previousOwner' in out, false);
    assert.deepEqual(out['attribution'], { source: 'meta' });
  });

  it('pagination envelope { items: [...] } → items stripped, envelope preserved', async () => {
    const resolver = makeResolver(bundle({ deniedRead: { lead: ['previousOwner'] } }));
    interceptor = new FieldRedactionInterceptor(new Reflector(), resolver, fieldFilter);

    const payload = {
      items: [
        { id: 'lead-1', name: 'A', previousOwner: { id: 'u-x' } },
        { id: 'lead-2', name: 'B', previousOwner: { id: 'u-y' } },
      ],
      total: 2,
      limit: 50,
      offset: 0,
    };
    const ctx = makeCtx({ req: { user: USER }, metadata: 'lead' });
    const out = (await firstValueFrom(interceptor.intercept(ctx, handlerOf(payload)))) as {
      items: Array<Record<string, unknown>>;
      total: number;
      limit: number;
      offset: number;
    };
    assert.equal(out.total, 2);
    assert.equal(out.limit, 50);
    assert.equal(out.offset, 0);
    assert.equal(out.items.length, 2);
    for (const row of out.items) {
      assert.equal('previousOwner' in row, false);
      assert.ok(row['id']);
      assert.ok(row['name']);
    }
  });

  it('plain array → all rows stripped', async () => {
    const resolver = makeResolver(bundle({ deniedRead: { lead: ['previousOwner'] } }));
    interceptor = new FieldRedactionInterceptor(new Reflector(), resolver, fieldFilter);

    const payload = [
      { id: 'lead-1', previousOwner: { id: 'u-x' } },
      { id: 'lead-2', previousOwner: { id: 'u-y' } },
    ];
    const ctx = makeCtx({ req: { user: USER }, metadata: 'lead' });
    const out = (await firstValueFrom(interceptor.intercept(ctx, handlerOf(payload)))) as Array<
      Record<string, unknown>
    >;
    assert.equal(out.length, 2);
    for (const row of out) {
      assert.equal('previousOwner' in row, false);
    }
  });

  it('lead.id survives even when a deny row is present', async () => {
    // The catalogue marks `lead.id` as `redactable: false`. The
    // interceptor MUST filter that deny path out before stripping.
    const resolver = makeResolver(bundle({ deniedRead: { lead: ['id', 'previousOwner'] } }));
    interceptor = new FieldRedactionInterceptor(new Reflector(), resolver, fieldFilter);

    const payload = { id: 'lead-1', previousOwner: { id: 'u-prev' }, name: 'X' };
    const ctx = makeCtx({ req: { user: USER }, metadata: 'lead' });
    const out = (await firstValueFrom(interceptor.intercept(ctx, handlerOf(payload)))) as Record<
      string,
      unknown
    >;
    assert.equal(out['id'], 'lead-1', 'lead.id must always survive');
    assert.equal('previousOwner' in out, false);
    assert.equal(out['name'], 'X');
  });

  it('null / primitive / undefined responses are returned untouched', async () => {
    const resolver = makeResolver(bundle({ deniedRead: { lead: ['previousOwner'] } }));
    interceptor = new FieldRedactionInterceptor(new Reflector(), resolver, fieldFilter);

    const ctx = makeCtx({ req: { user: USER }, metadata: 'lead' });
    assert.equal(await firstValueFrom(interceptor.intercept(ctx, handlerOf(null))), null);
    assert.equal(await firstValueFrom(interceptor.intercept(ctx, handlerOf(undefined))), undefined);
    assert.equal(
      await firstValueFrom(interceptor.intercept(ctx, handlerOf('hello' as unknown))),
      'hello',
    );
    assert.equal(await firstValueFrom(interceptor.intercept(ctx, handlerOf(42 as unknown))), 42);
  });

  it('no req.user → response unchanged (defensive)', async () => {
    const resolver = makeResolver(bundle({ deniedRead: { lead: ['previousOwner'] } }));
    interceptor = new FieldRedactionInterceptor(new Reflector(), resolver, fieldFilter);

    const payload = { id: 'lead-1', previousOwner: { id: 'u-prev' } };
    const ctx = makeCtx({
      req: {
        /* no user */
      },
      metadata: 'lead',
    });
    const out = await firstValueFrom(interceptor.intercept(ctx, handlerOf(payload)));
    assert.deepEqual(out, payload);
  });

  it('idempotent — running twice on already-stripped data is a no-op', async () => {
    const resolver = makeResolver(bundle({ deniedRead: { lead: ['previousOwner'] } }));
    interceptor = new FieldRedactionInterceptor(new Reflector(), resolver, fieldFilter);

    const payload = { id: 'lead-1', previousOwner: { id: 'u-prev' } };
    const ctx = makeCtx({ req: { user: USER }, metadata: 'lead' });
    const once = await firstValueFrom(interceptor.intercept(ctx, handlerOf(payload)));
    const twice = await firstValueFrom(interceptor.intercept(ctx, handlerOf(once)));
    assert.deepEqual(once, twice);
    assert.equal('previousOwner' in (once as object), false);
  });

  it('non-lead metadata → does NOT consult lead deny list', async () => {
    // D5.3 only wires lead. A future @ResourceFieldGate('captain') call
    // must read its own deny list, not lead's. Defensive check.
    const resolver = makeResolver(bundle({ deniedRead: { lead: ['previousOwner'] } }));
    interceptor = new FieldRedactionInterceptor(new Reflector(), resolver, fieldFilter);

    const payload = { id: 'cap-1', previousOwner: { id: 'u-prev' } };
    const ctx = makeCtx({ req: { user: USER }, metadata: 'captain' });
    const out = await firstValueFrom(interceptor.intercept(ctx, handlerOf(payload)));
    assert.deepEqual(out, payload, 'lead deny rows must not bleed into captain responses');
  });
});
