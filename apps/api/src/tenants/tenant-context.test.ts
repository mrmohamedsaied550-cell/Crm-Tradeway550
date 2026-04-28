import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getTenantContext, requireTenantId, tenantContext } from './tenant-context';

describe('tenant-context', () => {
  it('returns undefined when called outside any tenant scope', () => {
    assert.equal(getTenantContext(), undefined);
  });

  it('throws from requireTenantId() when called outside any tenant scope', () => {
    assert.throws(() => requireTenantId(), /No tenant context/);
  });

  it('exposes tenantId and tenantCode inside tenantContext.run()', () => {
    const id = '00000000-0000-4000-8000-000000000001';
    tenantContext.run({ tenantId: id, tenantCode: 'acme', source: 'header' }, () => {
      const ctx = getTenantContext();
      assert.deepEqual(ctx, { tenantId: id, tenantCode: 'acme', source: 'header' });
      assert.equal(requireTenantId(), id);
    });
    // Scope is gone after .run() returns.
    assert.equal(getTenantContext(), undefined);
  });

  it('isolates concurrent stores via async hooks', async () => {
    const a = '00000000-0000-4000-8000-000000000001';
    const b = '00000000-0000-4000-8000-000000000002';
    const seen: string[] = [];

    await Promise.all([
      tenantContext.run({ tenantId: a, tenantCode: 'a', source: 'header' }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        seen.push(requireTenantId());
      }),
      tenantContext.run({ tenantId: b, tenantCode: 'b', source: 'header' }, async () => {
        await new Promise((r) => setTimeout(r, 1));
        seen.push(requireTenantId());
      }),
    ]);

    assert.equal(seen.length, 2);
    assert.ok(seen.includes(a));
    assert.ok(seen.includes(b));
  });
});
