/**
 * P2-01 — CapabilityGuard.
 *
 * Pure unit tests (no Postgres): Reflector + a stub PrismaService.
 * Covers:
 *   - no-metadata routes are no-ops (guard returns true).
 *   - present caps allow; missing caps throw 403.
 *   - capabilities cached on req.user are reused on a second pass.
 *   - missing req.user → 401.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ForbiddenException, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { CapabilityGuard } from './capability.guard';
import { CAPABILITY_KEY } from './require-capability.decorator';
import type { PrismaService } from '../prisma/prisma.service';

function ctxWith(req: unknown, metadata?: readonly string[]): ExecutionContext {
  const handler = function fakeHandler() {
    /* placeholder */
  };
  if (metadata) Reflect.defineMetadata(CAPABILITY_KEY, metadata, handler);
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => handler,
    getClass: () =>
      class Anon {
        /* placeholder class */
      },
  } as unknown as ExecutionContext;
}

function makePrismaStub(caps: readonly string[]): PrismaService {
  return {
    withTenant: async <T>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> =>
      fn({
        role: {
          findUnique: async () => ({
            capabilities: caps.map((code) => ({ capability: { code } })),
          }),
        },
      }),
  } as unknown as PrismaService;
}

describe('rbac/CapabilityGuard', () => {
  it('no metadata → returns true (no-op)', async () => {
    const guard = new CapabilityGuard(new Reflector(), makePrismaStub([]));
    const ctx = ctxWith({ user: { tid: 'x', sub: 'y', rid: 'z' } });
    assert.equal(await guard.canActivate(ctx), true);
  });

  it('user has the required cap → allows', async () => {
    const guard = new CapabilityGuard(new Reflector(), makePrismaStub(['lead.write']));
    const ctx = ctxWith({ user: { tid: 'x', sub: 'y', rid: 'z' } }, ['lead.write']);
    assert.equal(await guard.canActivate(ctx), true);
  });

  it('user missing the required cap → 403', async () => {
    const guard = new CapabilityGuard(new Reflector(), makePrismaStub(['lead.read']));
    const ctx = ctxWith({ user: { tid: 'x', sub: 'y', rid: 'z' } }, ['lead.write']);
    await assert.rejects(() => guard.canActivate(ctx), ForbiddenException);
  });

  it('caches capabilities on req.user after the first lookup', async () => {
    let calls = 0;
    const stub = {
      withTenant: async <T>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> => {
        calls += 1;
        return fn({
          role: {
            findUnique: async () => ({ capabilities: [{ capability: { code: 'lead.write' } }] }),
          },
        });
      },
    } as unknown as PrismaService;
    const guard = new CapabilityGuard(new Reflector(), stub);
    const user: { tid: string; sub: string; rid: string; capabilities?: readonly string[] } = {
      tid: 'x',
      sub: 'y',
      rid: 'z',
    };
    const ctx = ctxWith({ user }, ['lead.write']);
    assert.equal(await guard.canActivate(ctx), true);
    assert.equal(await guard.canActivate(ctx), true);
    assert.equal(calls, 1, 'second canActivate should reuse req.user.capabilities');
    assert.deepEqual(user.capabilities, ['lead.write']);
  });

  it('missing req.user → 401', async () => {
    const guard = new CapabilityGuard(new Reflector(), makePrismaStub([]));
    const ctx = ctxWith({}, ['lead.write']);
    await assert.rejects(() => guard.canActivate(ctx), UnauthorizedException);
  });
});
