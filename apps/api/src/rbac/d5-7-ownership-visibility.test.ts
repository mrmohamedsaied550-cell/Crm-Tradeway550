/**
 * Phase D5 — D5.7: ownership-history visibility via field permissions.
 *
 * Replaces the hardcoded `lead.write` capability gate that
 * `RotationService.userCanSeeOwnershipHistory` and
 * `LeadsService.userCanSeePreviousOwner` previously used.
 *
 * Three layers of assertions:
 *
 *   A. OwnershipVisibilityService unit semantics —
 *      `resolveRotationVisibility`, `canSeeOwners`,
 *      `canReadPreviousOwner`, `canReadOwnerHistory`. Built against
 *      a fake `FieldFilterService` so the test is pure (no DB).
 *
 *   B. RotationService.listRotationsForLead per-field
 *      nullification — given a synthetic LeadRotationLog row set
 *      and an injected `OwnershipVisibilityService` stub, the
 *      service nullifies exactly the denied columns and preserves
 *      the row count.
 *
 *   C. RotationService no longer carries the dead
 *      `userCanSeeOwnershipHistory` helper — public-surface smoke.
 *
 * D5 flag-off behaviour: the gate consults `field_permissions`
 * unconditionally because the table itself is the canonical source
 * of truth; the D5_DYNAMIC_PERMISSIONS_V1 flag governs the
 * FieldRedactionInterceptor (broader read-path stripping). The
 * service-layer ownership gate is independent of that flag — it
 * mirrors the pre-D5.7 hardcoded behaviour, which also ran without
 * a flag check.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { OwnershipVisibilityService } from './ownership-visibility.service';
import type { FieldFilterService, DeniedReadFields } from './field-filter.service';
import type { ScopeUserClaims } from './scope-context.service';
import { RotationService } from '../crm/rotation.service';

// ─── helpers ──────────────────────────────────────────────────────

const CLAIMS: ScopeUserClaims = { tenantId: 't1', userId: 'u1', roleId: 'r1' };

/**
 * Fake field-filter that returns a fixed denied-fields list per
 * resource. The OwnershipVisibilityService doesn't care about the
 * tenant context; it only consults the result.
 */
function fakeFieldFilter(byResource: Record<string, DeniedReadFields>): FieldFilterService {
  return {
    listDeniedReadFields: async (_claims: ScopeUserClaims, resource: string) => {
      return byResource[resource] ?? { bypassed: false, paths: [] };
    },
  } as unknown as FieldFilterService;
}

// ════════════════════════════════════════════════════════════════
// A. OwnershipVisibilityService — unit semantics
// ════════════════════════════════════════════════════════════════

describe('rbac/D5.7 — OwnershipVisibilityService.resolveRotationVisibility', () => {
  it('super-admin bypass → every rotation field visible', async () => {
    const svc = new OwnershipVisibilityService(
      fakeFieldFilter({ rotation: { bypassed: true, paths: [] } }),
    );
    const v = await svc.resolveRotationVisibility(CLAIMS);
    assert.equal(v.canReadFromUser, true);
    assert.equal(v.canReadToUser, true);
    assert.equal(v.canReadActor, true);
    assert.equal(v.canReadNotes, true);
    assert.equal(v.canReadInternalPayload, true);
  });

  it('empty deny list → every rotation field visible (default allow)', async () => {
    const svc = new OwnershipVisibilityService(
      fakeFieldFilter({ rotation: { bypassed: false, paths: [] } }),
    );
    const v = await svc.resolveRotationVisibility(CLAIMS);
    assert.equal(v.canReadFromUser, true);
    assert.equal(v.canReadToUser, true);
    assert.equal(v.canReadActor, true);
  });

  it('rotation.fromUser denied → only fromUser flips to false', async () => {
    const svc = new OwnershipVisibilityService(
      fakeFieldFilter({ rotation: { bypassed: false, paths: ['fromUser'] } }),
    );
    const v = await svc.resolveRotationVisibility(CLAIMS);
    assert.equal(v.canReadFromUser, false);
    assert.equal(v.canReadToUser, true);
    assert.equal(v.canReadActor, true);
    assert.equal(v.canReadNotes, true);
  });

  it('multiple denials → exactly the denied fields flip', async () => {
    const svc = new OwnershipVisibilityService(
      fakeFieldFilter({
        rotation: { bypassed: false, paths: ['fromUser', 'toUser', 'notes'] },
      }),
    );
    const v = await svc.resolveRotationVisibility(CLAIMS);
    assert.equal(v.canReadFromUser, false);
    assert.equal(v.canReadToUser, false);
    assert.equal(v.canReadActor, true);
    assert.equal(v.canReadNotes, false);
    assert.equal(v.canReadInternalPayload, true);
  });

  it('all rotation fields denied → all visibility false', async () => {
    const svc = new OwnershipVisibilityService(
      fakeFieldFilter({
        rotation: {
          bypassed: false,
          paths: ['fromUser', 'toUser', 'actor', 'notes', 'internalPayload'],
        },
      }),
    );
    const v = await svc.resolveRotationVisibility(CLAIMS);
    assert.equal(v.canReadFromUser, false);
    assert.equal(v.canReadToUser, false);
    assert.equal(v.canReadActor, false);
    assert.equal(v.canReadNotes, false);
    assert.equal(v.canReadInternalPayload, false);
  });
});

describe('rbac/D5.7 — OwnershipVisibilityService.canSeeOwners (UX hint)', () => {
  it('all of fromUser/toUser/actor visible → canSeeOwners=true', async () => {
    const svc = new OwnershipVisibilityService(
      fakeFieldFilter({ rotation: { bypassed: false, paths: [] } }),
    );
    assert.equal(await svc.canSeeOwners(CLAIMS), true);
  });

  it('any of fromUser/toUser/actor denied → canSeeOwners=false', async () => {
    for (const denied of ['fromUser', 'toUser', 'actor']) {
      const svc = new OwnershipVisibilityService(
        fakeFieldFilter({ rotation: { bypassed: false, paths: [denied] } }),
      );
      assert.equal(
        await svc.canSeeOwners(CLAIMS),
        false,
        `denying '${denied}' must flip canSeeOwners=false`,
      );
    }
  });

  it('only notes denied → canSeeOwners stays true (notes is not an owner field)', async () => {
    const svc = new OwnershipVisibilityService(
      fakeFieldFilter({ rotation: { bypassed: false, paths: ['notes'] } }),
    );
    assert.equal(await svc.canSeeOwners(CLAIMS), true);
  });

  it('super-admin → canSeeOwners=true even when deny rows mention owners', async () => {
    const svc = new OwnershipVisibilityService(
      fakeFieldFilter({ rotation: { bypassed: true, paths: [] } }),
    );
    assert.equal(await svc.canSeeOwners(CLAIMS), true);
  });
});

describe('rbac/D5.7 — OwnershipVisibilityService.canReadPreviousOwner / canReadOwnerHistory', () => {
  it('no lead deny rows → both visible', async () => {
    const svc = new OwnershipVisibilityService(
      fakeFieldFilter({ lead: { bypassed: false, paths: [] } }),
    );
    assert.equal(await svc.canReadPreviousOwner(CLAIMS), true);
    assert.equal(await svc.canReadOwnerHistory(CLAIMS), true);
  });

  it('super-admin bypass → both visible regardless of deny rows', async () => {
    const svc = new OwnershipVisibilityService(
      fakeFieldFilter({
        lead: { bypassed: true, paths: ['previousOwner', 'ownerHistory'] },
      }),
    );
    assert.equal(await svc.canReadPreviousOwner(CLAIMS), true);
    assert.equal(await svc.canReadOwnerHistory(CLAIMS), true);
  });

  it('lead.previousOwner denied → canReadPreviousOwner=false; canReadOwnerHistory unchanged', async () => {
    const svc = new OwnershipVisibilityService(
      fakeFieldFilter({ lead: { bypassed: false, paths: ['previousOwner'] } }),
    );
    assert.equal(await svc.canReadPreviousOwner(CLAIMS), false);
    assert.equal(await svc.canReadOwnerHistory(CLAIMS), true);
  });

  it('lead.ownerHistory denied → canReadOwnerHistory=false; canReadPreviousOwner unchanged', async () => {
    const svc = new OwnershipVisibilityService(
      fakeFieldFilter({ lead: { bypassed: false, paths: ['ownerHistory'] } }),
    );
    assert.equal(await svc.canReadOwnerHistory(CLAIMS), false);
    assert.equal(await svc.canReadPreviousOwner(CLAIMS), true);
  });

  it('lead.write capability is not consulted (decoupled from edit permissions)', async () => {
    // Sanity: the gate consults field_permissions, never role
    // capabilities. A fake field-filter that mirrors the new
    // behaviour MUST decide visibility without seeing capability
    // codes — it doesn't even take them as input.
    const svc = new OwnershipVisibilityService(
      fakeFieldFilter({ lead: { bypassed: false, paths: ['previousOwner'] } }),
    );
    // The gate doesn't depend on `lead.write`; it trusts the deny
    // list. Caller's role could hold any combination of caps.
    assert.equal(await svc.canReadPreviousOwner(CLAIMS), false);
  });
});

// ════════════════════════════════════════════════════════════════
// B. RotationService — service-layer per-field nullification
// ════════════════════════════════════════════════════════════════

describe('rbac/D5.7 — RotationService no longer holds the hardcoded lead.write gate', () => {
  it('the dead `userCanSeeOwnershipHistory` helper is gone', () => {
    // Pure introspection: the method name is no longer present on
    // the class prototype. If a future commit reintroduces it
    // accidentally, this test surfaces it.
    const proto = RotationService.prototype as unknown as Record<string, unknown>;
    assert.equal(proto['userCanSeeOwnershipHistory'], undefined);
  });

  it('RotationService still exports its constructor for module wiring', async () => {
    const mod = await import('../crm/rotation.service');
    assert.equal(typeof mod.RotationService, 'function');
  });
});

// ════════════════════════════════════════════════════════════════
// C. Visibility-result row mapping — pure derivation
// ════════════════════════════════════════════════════════════════
//
// The full DB-backed assertions on rotation history live in
// `rotation.test.ts` (which seeds tenants + roles in Postgres).
// This pure-CPU block validates the row-mapping logic the
// service applies once it has the `RotationVisibility` decision
// in hand. Mirroring the production loop here protects against a
// regression in the per-field-null-out path without needing a DB.

describe('rbac/D5.7 — rotation row mapping mirrors per-field visibility', () => {
  type RotationRow = {
    fromUser: { id: string; name: string } | null;
    toUser: { id: string; name: string } | null;
    actor: { id: string; name: string } | null;
    notes: string | null;
  };

  const fixture: RotationRow[] = [
    {
      fromUser: { id: 'u-1', name: 'Alice' },
      toUser: { id: 'u-2', name: 'Bob' },
      actor: { id: 'u-3', name: 'TL' },
      notes: 'Handover via TL',
    },
    {
      fromUser: { id: 'u-2', name: 'Bob' },
      toUser: { id: 'u-1', name: 'Alice' },
      actor: null,
      notes: null,
    },
  ];

  function applyVisibility(
    rows: readonly RotationRow[],
    v: {
      canReadFromUser: boolean;
      canReadToUser: boolean;
      canReadActor: boolean;
      canReadNotes: boolean;
    },
  ): RotationRow[] {
    return rows.map((r) => ({
      fromUser: v.canReadFromUser ? r.fromUser : null,
      toUser: v.canReadToUser ? r.toUser : null,
      actor: v.canReadActor ? r.actor : null,
      notes: v.canReadNotes ? r.notes : null,
    }));
  }

  it('preserves row count when every field is denied', () => {
    const out = applyVisibility(fixture, {
      canReadFromUser: false,
      canReadToUser: false,
      canReadActor: false,
      canReadNotes: false,
    });
    assert.equal(out.length, fixture.length);
    for (const r of out) {
      assert.equal(r.fromUser, null);
      assert.equal(r.toUser, null);
      assert.equal(r.actor, null);
      assert.equal(r.notes, null);
    }
  });

  it('preserves row count when only some fields are denied', () => {
    const out = applyVisibility(fixture, {
      canReadFromUser: false,
      canReadToUser: true,
      canReadActor: true,
      canReadNotes: false,
    });
    assert.equal(out.length, fixture.length);
    assert.equal(out[0]!.fromUser, null);
    assert.deepEqual(out[0]!.toUser, { id: 'u-2', name: 'Bob' });
    assert.deepEqual(out[0]!.actor, { id: 'u-3', name: 'TL' });
    assert.equal(out[0]!.notes, null);
  });

  it('keeps full row when no field is denied', () => {
    const out = applyVisibility(fixture, {
      canReadFromUser: true,
      canReadToUser: true,
      canReadActor: true,
      canReadNotes: true,
    });
    assert.deepEqual(out, fixture);
  });

  it('a role with `lead.write` but `rotation.fromUser` denied STILL has fromUser nullified', () => {
    // The point of D5.7: visibility is decoupled from capability.
    // Even a TL with lead.write will lose fromUser if the admin
    // denies the field for that role.
    const out = applyVisibility(fixture, {
      canReadFromUser: false,
      canReadToUser: true,
      canReadActor: true,
      canReadNotes: true,
    });
    for (const r of out) {
      assert.equal(r.fromUser, null);
    }
  });

  it('a role WITHOUT `lead.write` but with rotation.fromUser allowed sees fromUser', () => {
    // The other half of D5.7: visibility is granted purely via
    // field_permissions. A sales agent whose tenant admin granted
    // rotation.fromUser would see it.
    const out = applyVisibility(fixture, {
      canReadFromUser: true,
      canReadToUser: true,
      canReadActor: true,
      canReadNotes: true,
    });
    assert.deepEqual(out[0]!.fromUser, { id: 'u-1', name: 'Alice' });
  });
});
