/**
 * Phase D5 — D5.9: /auth/me permission-metadata projection.
 *
 * Pure unit tests for `derivePublicPermissionShape`. No DB.
 *
 * Three layers of assertions:
 *
 *   A. Shape — the result carries `fieldPermissions`,
 *      `deniedReadFieldsByResource`, `deniedWriteFieldsByResource`,
 *      `scopesByResource` (no field VALUES, only metadata).
 *
 *   B. Super-admin bypass — empty deny maps + empty
 *      `fieldPermissions` regardless of any deny rows persisted
 *      against the role row. (`scopesByResource` ships verbatim
 *      so the payload reports the actual persisted scopes.)
 *
 *   C. Agent cohort — a role with the D5.7 + D5.8 default deny
 *      rows produces deny maps that include
 *      `lead.previousOwner` / `lead.ownerHistory` /
 *      `lead.outOfScopeAttemptCount` /
 *      `rotation.fromUser` / `rotation.toUser` / `rotation.actor` /
 *      `rotation.notes` / `rotation.internalPayload` /
 *      `lead.review.ownerContext` /
 *      `lead.review.partnerContext`, mirroring the migration 0040 +
 *      0041 seed.
 *
 * The function is the SOLE source of `/auth/me`'s permission
 * metadata; if a future commit changes its shape, this test file
 * surfaces the change.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { RoleWithCapabilities } from '../rbac/rbac.service';
import { derivePublicPermissionShape } from './auth.service';

// ─── helpers ──────────────────────────────────────────────────────

function makeRole(opts: {
  code?: string;
  fieldPermissions?: ReadonlyArray<{
    resource: string;
    field: string;
    canRead: boolean;
    canWrite: boolean;
  }>;
  scopes?: ReadonlyArray<{ resource: string; scope: string }>;
  capabilities?: readonly string[];
}): RoleWithCapabilities {
  return {
    id: 'role-1',
    code: (opts.code ?? 'sales_agent') as RoleWithCapabilities['code'],
    nameAr: 'وكيل',
    nameEn: 'Sales Agent',
    level: 30,
    isActive: true,
    isSystem: true,
    description: null,
    capabilities: opts.capabilities ?? [],
    scopes: (opts.scopes ?? []) as RoleWithCapabilities['scopes'],
    fieldPermissions: (opts.fieldPermissions ?? []) as RoleWithCapabilities['fieldPermissions'],
  };
}

// ════════════════════════════════════════════════════════════════
// A. Shape
// ════════════════════════════════════════════════════════════════

describe('rbac/D5.9 — derivePublicPermissionShape: shape', () => {
  it('returns the four expected projections (no values, only metadata)', () => {
    const out = derivePublicPermissionShape(
      makeRole({
        fieldPermissions: [{ resource: 'lead', field: 'phone', canRead: false, canWrite: true }],
      }),
    );
    assert.equal(typeof out.fieldPermissions, 'object');
    assert.ok(Array.isArray(out.fieldPermissions));
    assert.equal(typeof out.deniedReadFieldsByResource, 'object');
    assert.equal(typeof out.deniedWriteFieldsByResource, 'object');
    assert.equal(typeof out.scopesByResource, 'object');
    // No VALUES leak — deny maps name resources + fields only.
    const blob = JSON.stringify(out.deniedReadFieldsByResource);
    assert.equal(blob.includes('+201'), false);
    assert.equal(blob.includes('demo@'), false);
  });

  it('empty role → empty maps', () => {
    const out = derivePublicPermissionShape(makeRole({ fieldPermissions: [], scopes: [] }));
    assert.deepEqual(out.fieldPermissions, []);
    assert.deepEqual(out.deniedReadFieldsByResource, {});
    assert.deepEqual(out.deniedWriteFieldsByResource, {});
    assert.deepEqual(out.scopesByResource, {});
  });
});

// ════════════════════════════════════════════════════════════════
// B. Super-admin bypass
// ════════════════════════════════════════════════════════════════

describe('rbac/D5.9 — derivePublicPermissionShape: super-admin bypass', () => {
  it('empty fieldPermissions + empty deny maps regardless of persisted deny rows', () => {
    const out = derivePublicPermissionShape(
      makeRole({
        code: 'super_admin',
        fieldPermissions: [
          // Hypothetical migration mistake: a deny row got written
          // for super-admin. The bypass MUST still apply so the
          // payload is empty.
          { resource: 'lead', field: 'phone', canRead: false, canWrite: false },
          { resource: 'rotation', field: 'fromUser', canRead: false, canWrite: false },
        ],
        scopes: [
          { resource: 'lead', scope: 'global' },
          { resource: 'whatsapp.conversation', scope: 'global' },
        ],
      }),
    );
    assert.deepEqual(out.fieldPermissions, []);
    assert.deepEqual(out.deniedReadFieldsByResource, {});
    assert.deepEqual(out.deniedWriteFieldsByResource, {});
    // scopesByResource ships verbatim (transparency, not enforcement).
    assert.deepEqual(out.scopesByResource, {
      lead: 'global',
      'whatsapp.conversation': 'global',
    });
  });
});

// ════════════════════════════════════════════════════════════════
// C. Agent cohort — D5.7 + D5.8 default deny rows
// ════════════════════════════════════════════════════════════════

describe('rbac/D5.9 — derivePublicPermissionShape: agent cohort defaults', () => {
  it('sales_agent with D5.7 + D5.8 deny rows produces the expected deny maps', () => {
    const role = makeRole({
      code: 'sales_agent',
      fieldPermissions: [
        // D5.7 — rotation owner-history fields.
        { resource: 'rotation', field: 'fromUser', canRead: false, canWrite: false },
        { resource: 'rotation', field: 'toUser', canRead: false, canWrite: false },
        { resource: 'rotation', field: 'actor', canRead: false, canWrite: false },
        { resource: 'rotation', field: 'notes', canRead: false, canWrite: false },
        { resource: 'rotation', field: 'internalPayload', canRead: false, canWrite: false },
        // D5.7 — lead-side previous-owner.
        { resource: 'lead', field: 'previousOwner', canRead: false, canWrite: false },
        { resource: 'lead', field: 'ownerHistory', canRead: false, canWrite: false },
        // D5.8 — out-of-scope count.
        { resource: 'lead', field: 'outOfScopeAttemptCount', canRead: false, canWrite: false },
        // D5.8 — review context (dormant defence-in-depth).
        { resource: 'lead.review', field: 'ownerContext', canRead: false, canWrite: false },
        { resource: 'lead.review', field: 'partnerContext', canRead: false, canWrite: false },
      ],
      scopes: [{ resource: 'lead', scope: 'team' }],
    });
    const out = derivePublicPermissionShape(role);

    // Every entry surfaces in BOTH deny maps (canRead=false AND
    // canWrite=false on every D5.7/D5.8 seed row).
    assert.deepEqual(out.deniedReadFieldsByResource['rotation']!.slice().sort(), [
      'actor',
      'fromUser',
      'internalPayload',
      'notes',
      'toUser',
    ]);
    assert.deepEqual(out.deniedReadFieldsByResource['lead']!.slice().sort(), [
      'outOfScopeAttemptCount',
      'ownerHistory',
      'previousOwner',
    ]);
    assert.deepEqual(out.deniedReadFieldsByResource['lead.review']!.slice().sort(), [
      'ownerContext',
      'partnerContext',
    ]);

    // Write maps mirror read maps for the agent seed (every seed
    // row sets canWrite=false too — see seed.ts).
    assert.deepEqual(out.deniedWriteFieldsByResource['rotation']!.slice().sort(), [
      'actor',
      'fromUser',
      'internalPayload',
      'notes',
      'toUser',
    ]);

    // Scopes pass through.
    assert.equal(out.scopesByResource['lead'], 'team');

    // Backwards-compat: the flat `fieldPermissions` array is non-empty.
    assert.ok(out.fieldPermissions.length >= 10);
  });

  it('a role with mixed canRead/canWrite produces independent deny maps', () => {
    // Read-only on `lead.phone` (canRead=true, canWrite=false) →
    // appears ONLY in the write deny map.
    const out = derivePublicPermissionShape(
      makeRole({
        fieldPermissions: [
          { resource: 'lead', field: 'phone', canRead: true, canWrite: false },
          { resource: 'lead', field: 'campaignName', canRead: false, canWrite: true },
        ],
      }),
    );
    assert.deepEqual(out.deniedReadFieldsByResource, { lead: ['campaignName'] });
    assert.deepEqual(out.deniedWriteFieldsByResource, { lead: ['phone'] });
  });

  it('does not include any field VALUES in the projection (audit-grade)', () => {
    // Defensive sanity: the helper takes structural metadata
    // ONLY (resource + field + booleans). No row data is in scope.
    const out = derivePublicPermissionShape(
      makeRole({
        fieldPermissions: [
          { resource: 'lead', field: 'phone', canRead: false, canWrite: false },
          { resource: 'org.user', field: 'email', canRead: false, canWrite: false },
        ],
      }),
    );
    const blob = JSON.stringify(out);
    // Field names appear (they are metadata).
    assert.ok(blob.includes('phone'));
    assert.ok(blob.includes('email'));
    // No actual lead phone numbers, user emails, or tenant names
    // can leak — there's no path for them to enter the projection.
    assert.equal(blob.includes('+20'), false);
    assert.equal(blob.includes('@'), false);
  });
});
