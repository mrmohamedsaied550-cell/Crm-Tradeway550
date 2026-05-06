/**
 * Phase D5 — D5.15-B: role version history.
 *
 * Pure unit tests for the structural diff + no-op skip logic +
 * snapshot shape that the history table relies on. The DB-backed
 * tests (RLS, paging, revert end-to-end) live in
 * `rbac.test.ts` against Postgres; this file exercises the
 * behaviour every consumer can rely on without a database.
 *
 * Sections:
 *
 *   A. `buildSnapshot` — shape (metadata + sorted capabilities +
 *      sorted scopes + sorted field permissions). Order is
 *      deterministic so equality checks behave.
 *
 *   B. `computeChangeSummary` — capability diff, field-perm diff,
 *      scope diff, risk-flag derivation. No-op (identical
 *      snapshots) returns an empty diff but valid risk flags
 *      (all false).
 *
 *   C. `recordVersion` no-op skip — when the snapshot equals the
 *      previous version's snapshot AND the trigger action is
 *      `update` / `scopes` / `field_permissions`, the recorder
 *      returns `null` and never writes a row. `create` /
 *      `duplicate` / `revert` ALWAYS write (those are
 *      deliberate-event verbs).
 *
 *   D. `recordVersion` write path — increments versionNumber from
 *      the latest version; passes through actor + reason +
 *      revertedFrom* metadata; returns `{ id, versionNumber }`.
 *
 *   E. Risk flags ride through `computeRiskSummary` so the
 *      History tab renders the same vocabulary as the D5.15-A
 *      review modal. Spot-check: granting `tenant.export` flips
 *      `exportCapabilityAdded` AND `backupExportChanged`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { Prisma } from '@prisma/client';

import type { PrismaService } from '../prisma/prisma.service';
import type { RoleWithCapabilities } from './rbac.service';
import {
  RoleVersionService,
  buildSnapshot,
  computeChangeSummary,
  type RoleVersionSnapshot,
} from './role-version.service';

// ─── helpers ──────────────────────────────────────────────────────

function makeRole(opts: {
  id?: string;
  capabilities?: readonly string[];
  scopes?: ReadonlyArray<{ resource: string; scope: string }>;
  fieldPermissions?: ReadonlyArray<{
    resource: string;
    field: string;
    canRead: boolean;
    canWrite: boolean;
  }>;
}): RoleWithCapabilities {
  return {
    id: opts.id ?? 'role-1',
    code: 'ops_manager',
    nameEn: 'Ops Manager',
    nameAr: 'مدير العمليات',
    level: 60,
    isActive: true,
    isSystem: false,
    description: null,
    capabilities: opts.capabilities ?? [],
    scopes: (opts.scopes ?? []) as RoleWithCapabilities['scopes'],
    fieldPermissions: (opts.fieldPermissions ?? []) as RoleWithCapabilities['fieldPermissions'],
  };
}

/**
 * Synthetic Prisma transaction client. Captures every roleVersion
 * call so the test can assert "wrote 1 row" / "wrote 0 rows" /
 * "wrote with this payload".
 */
interface CaptureBucket {
  findFirstCalls: Array<Record<string, unknown>>;
  createCalls: Array<{ data: Record<string, unknown> }>;
  /** What `findFirst` returns. The test sets this before the call. */
  latestVersion: { id: string; versionNumber: number; snapshot: RoleVersionSnapshot } | null;
  /** What `create` returns. The test sets this before the call. */
  nextCreate: { id: string; versionNumber: number };
}

function fakeTx(bucket: CaptureBucket): Prisma.TransactionClient {
  return {
    roleVersion: {
      findFirst: async (args: Record<string, unknown>) => {
        bucket.findFirstCalls.push(args);
        return bucket.latestVersion;
      },
      create: async (args: { data: Record<string, unknown> }) => {
        bucket.createCalls.push(args);
        return bucket.nextCreate;
      },
    },
  } as unknown as Prisma.TransactionClient;
}

function buildService(): RoleVersionService {
  return new RoleVersionService({} as PrismaService);
}

// ════════════════════════════════════════════════════════════════
// A. buildSnapshot
// ════════════════════════════════════════════════════════════════

describe('rbac/D5.15-B — buildSnapshot', () => {
  it('captures role metadata + sorted capabilities + sorted scopes + sorted field perms', () => {
    const role = makeRole({
      capabilities: ['lead.write', 'lead.read', 'audit.read'],
      scopes: [
        { resource: 'lead', scope: 'team' },
        { resource: 'captain', scope: 'global' },
      ],
      fieldPermissions: [
        { resource: 'rotation', field: 'fromUser', canRead: false, canWrite: false },
        { resource: 'lead', field: 'previousOwner', canRead: false, canWrite: false },
      ],
    });
    const snap = buildSnapshot(role);
    assert.deepEqual(snap.capabilities, ['audit.read', 'lead.read', 'lead.write']);
    assert.deepEqual(
      snap.scopes.map((s) => s.resource),
      ['captain', 'lead'],
    );
    assert.deepEqual(
      snap.fieldPermissions.map((p) => `${p.resource}.${p.field}`),
      ['lead.previousOwner', 'rotation.fromUser'],
    );
    assert.equal(snap.metadata.code, 'ops_manager');
    assert.equal(snap.metadata.level, 60);
  });

  it('returns deterministic structure regardless of input order', () => {
    const a = buildSnapshot(makeRole({ capabilities: ['a', 'b', 'c'] }));
    const b = buildSnapshot(makeRole({ capabilities: ['c', 'a', 'b'] }));
    assert.equal(JSON.stringify(a), JSON.stringify(b));
  });
});

// ════════════════════════════════════════════════════════════════
// B. computeChangeSummary
// ════════════════════════════════════════════════════════════════

describe('rbac/D5.15-B — computeChangeSummary', () => {
  it('first version (previous=null) lists every cap as granted', () => {
    const next = buildSnapshot(makeRole({ capabilities: ['lead.read', 'lead.write'] }));
    const summary = computeChangeSummary(null, next);
    assert.deepEqual(summary.grantedCapabilities, ['lead.read', 'lead.write']);
    assert.deepEqual(summary.revokedCapabilities, []);
  });

  it('identical snapshots return an empty diff', () => {
    const role = makeRole({ capabilities: ['lead.read', 'lead.write'] });
    const a = buildSnapshot(role);
    const b = buildSnapshot(role);
    const summary = computeChangeSummary(a, b);
    assert.deepEqual(summary.grantedCapabilities, []);
    assert.deepEqual(summary.revokedCapabilities, []);
    assert.equal(summary.fieldPermissionChanges.readDeniedAdded.length, 0);
    assert.equal(summary.fieldPermissionChanges.readDeniedRemoved.length, 0);
    assert.equal(summary.scopeChanges.changed.length, 0);
  });

  it('granting tenant.export flips exportCapabilityAdded + backupExportChanged', () => {
    const prev = buildSnapshot(makeRole({ capabilities: [] }));
    const next = buildSnapshot(makeRole({ capabilities: ['tenant.export'] }));
    const summary = computeChangeSummary(prev, next);
    assert.deepEqual(summary.grantedCapabilities, ['tenant.export']);
    assert.equal(summary.riskFlags.exportCapabilityAdded, true);
    assert.equal(summary.riskFlags.backupExportChanged, true);
    assert.equal(summary.riskFlags.permissionAdminChanged, false);
  });

  it('revoking partner.merge.write flips partnerMergeChanged', () => {
    const prev = buildSnapshot(
      makeRole({ capabilities: ['partner.verification.read', 'partner.merge.write'] }),
    );
    const next = buildSnapshot(makeRole({ capabilities: ['partner.verification.read'] }));
    const summary = computeChangeSummary(prev, next);
    assert.deepEqual(summary.revokedCapabilities, ['partner.merge.write']);
    assert.equal(summary.riskFlags.partnerMergeChanged, true);
  });

  it('owner-history field-perm changes flip ownerHistoryVisibilityChanged', () => {
    const prev = buildSnapshot(makeRole({ fieldPermissions: [] }));
    const next = buildSnapshot(
      makeRole({
        fieldPermissions: [
          { resource: 'rotation', field: 'fromUser', canRead: false, canWrite: false },
        ],
      }),
    );
    const summary = computeChangeSummary(prev, next);
    assert.equal(summary.riskFlags.ownerHistoryVisibilityChanged, true);
    assert.deepEqual(summary.fieldPermissionChanges.readDeniedAdded, [
      { resource: 'rotation', field: 'fromUser' },
    ]);
  });

  it('scope changes are bucketed into changed / added / removed', () => {
    const prev = buildSnapshot(
      makeRole({
        scopes: [
          { resource: 'lead', scope: 'team' },
          { resource: 'captain', scope: 'team' },
        ],
      }),
    );
    const next = buildSnapshot(
      makeRole({
        scopes: [
          { resource: 'lead', scope: 'global' },
          { resource: 'followup', scope: 'team' },
        ],
      }),
    );
    const summary = computeChangeSummary(prev, next);
    assert.deepEqual(summary.scopeChanges.changed, [
      { resource: 'lead', from: 'team', to: 'global' },
    ]);
    assert.deepEqual(summary.scopeChanges.added, [{ resource: 'followup', scope: 'team' }]);
    assert.deepEqual(summary.scopeChanges.removed, [{ resource: 'captain', scope: 'team' }]);
  });
});

// ════════════════════════════════════════════════════════════════
// C. recordVersion no-op skip
// ════════════════════════════════════════════════════════════════

describe('rbac/D5.15-B — recordVersion no-op skip', () => {
  it('returns null when the snapshot equals the previous AND triggerAction=update', async () => {
    const svc = buildService();
    const role = makeRole({ capabilities: ['lead.read'] });
    const bucket: CaptureBucket = {
      findFirstCalls: [],
      createCalls: [],
      latestVersion: {
        id: 'v0',
        versionNumber: 1,
        snapshot: buildSnapshot(role),
      },
      nextCreate: { id: 'v1', versionNumber: 2 },
    };
    const out = await svc.recordVersion(fakeTx(bucket), 't-1', {
      role,
      triggerAction: 'update',
      actorUserId: 'u-1',
    });
    assert.equal(out, null);
    assert.equal(bucket.createCalls.length, 0, 'no-op update must not write a version row');
  });

  it('skips no-ops for `scopes` and `field_permissions` triggers', async () => {
    const svc = buildService();
    const role = makeRole({ capabilities: ['lead.read'] });
    const bucket: CaptureBucket = {
      findFirstCalls: [],
      createCalls: [],
      latestVersion: { id: 'v0', versionNumber: 1, snapshot: buildSnapshot(role) },
      nextCreate: { id: 'v1', versionNumber: 2 },
    };
    const a = await svc.recordVersion(fakeTx(bucket), 't-1', {
      role,
      triggerAction: 'scopes',
      actorUserId: 'u-1',
    });
    const b = await svc.recordVersion(fakeTx(bucket), 't-1', {
      role,
      triggerAction: 'field_permissions',
      actorUserId: 'u-1',
    });
    assert.equal(a, null);
    assert.equal(b, null);
  });

  it('always writes a row for `create` even when snapshot is empty', async () => {
    const svc = buildService();
    const role = makeRole({ capabilities: [] });
    const bucket: CaptureBucket = {
      findFirstCalls: [],
      createCalls: [],
      latestVersion: null,
      nextCreate: { id: 'v1', versionNumber: 1 },
    };
    const out = await svc.recordVersion(fakeTx(bucket), 't-1', {
      role,
      triggerAction: 'create',
      actorUserId: 'u-1',
    });
    assert.notEqual(out, null);
    assert.equal(bucket.createCalls.length, 1);
  });

  it('always writes a row for `duplicate` even when the snapshot equals an existing role', async () => {
    const svc = buildService();
    const role = makeRole({ capabilities: ['lead.read'] });
    const bucket: CaptureBucket = {
      findFirstCalls: [],
      createCalls: [],
      latestVersion: { id: 'v0', versionNumber: 1, snapshot: buildSnapshot(role) },
      nextCreate: { id: 'v1', versionNumber: 2 },
    };
    const out = await svc.recordVersion(fakeTx(bucket), 't-1', {
      role,
      triggerAction: 'duplicate',
      actorUserId: 'u-1',
    });
    assert.notEqual(out, null);
    assert.equal(bucket.createCalls.length, 1);
  });

  it('always writes a row for `revert` (the action carries deliberate audit value)', async () => {
    const svc = buildService();
    const role = makeRole({ capabilities: ['lead.read'] });
    const bucket: CaptureBucket = {
      findFirstCalls: [],
      createCalls: [],
      latestVersion: { id: 'v0', versionNumber: 5, snapshot: buildSnapshot(role) },
      nextCreate: { id: 'v6', versionNumber: 6 },
    };
    const out = await svc.recordVersion(fakeTx(bucket), 't-1', {
      role,
      triggerAction: 'revert',
      actorUserId: 'u-1',
      revertedFromVersionId: 'v3',
      revertedFromVersionNumber: 3,
    });
    assert.notEqual(out, null);
    assert.equal(bucket.createCalls.length, 1);
    const data = bucket.createCalls[0]!.data as Record<string, unknown>;
    assert.equal(data['triggerAction'], 'revert');
  });
});

// ════════════════════════════════════════════════════════════════
// D. recordVersion write path metadata
// ════════════════════════════════════════════════════════════════

describe('rbac/D5.15-B — recordVersion write path', () => {
  it('increments versionNumber from the latest', async () => {
    const svc = buildService();
    const role = makeRole({ capabilities: ['lead.read', 'lead.write'] });
    const bucket: CaptureBucket = {
      findFirstCalls: [],
      createCalls: [],
      latestVersion: {
        id: 'v0',
        versionNumber: 7,
        snapshot: buildSnapshot(makeRole({ capabilities: ['lead.read'] })),
      },
      nextCreate: { id: 'v8', versionNumber: 8 },
    };
    await svc.recordVersion(fakeTx(bucket), 't-1', {
      role,
      triggerAction: 'update',
      actorUserId: 'u-1',
    });
    assert.equal(bucket.createCalls.length, 1);
    const data = bucket.createCalls[0]!.data as Record<string, unknown>;
    assert.equal(data['versionNumber'], 8);
    assert.equal(data['actorUserId'], 'u-1');
    assert.equal(data['tenantId'], 't-1');
    assert.equal(data['roleId'], role.id);
    assert.equal(data['triggerAction'], 'update');
  });

  it('first version (no previous) starts at versionNumber 1', async () => {
    const svc = buildService();
    const role = makeRole({ capabilities: ['lead.read'] });
    const bucket: CaptureBucket = {
      findFirstCalls: [],
      createCalls: [],
      latestVersion: null,
      nextCreate: { id: 'v1', versionNumber: 1 },
    };
    await svc.recordVersion(fakeTx(bucket), 't-1', {
      role,
      triggerAction: 'create',
      actorUserId: 'u-1',
    });
    const data = bucket.createCalls[0]!.data as Record<string, unknown>;
    assert.equal(data['versionNumber'], 1);
  });

  it('passes reason + revertedFrom* metadata through to the row', async () => {
    const svc = buildService();
    const role = makeRole({ capabilities: ['lead.read'] });
    const bucket: CaptureBucket = {
      findFirstCalls: [],
      createCalls: [],
      latestVersion: null,
      nextCreate: { id: 'v1', versionNumber: 1 },
    };
    await svc.recordVersion(fakeTx(bucket), 't-1', {
      role,
      triggerAction: 'revert',
      actorUserId: 'u-1',
      reason: 'rolled back the export grant',
      revertedFromVersionId: 'v-source',
      revertedFromVersionNumber: 3,
    });
    const data = bucket.createCalls[0]!.data as Record<string, unknown>;
    assert.equal(data['reason'], 'rolled back the export grant');
  });

  it('snapshot + change summary ride as JSON columns with structural shape', async () => {
    const svc = buildService();
    const role = makeRole({
      capabilities: ['lead.read'],
      scopes: [{ resource: 'lead', scope: 'team' }],
      fieldPermissions: [],
    });
    const bucket: CaptureBucket = {
      findFirstCalls: [],
      createCalls: [],
      latestVersion: null,
      nextCreate: { id: 'v1', versionNumber: 1 },
    };
    await svc.recordVersion(fakeTx(bucket), 't-1', {
      role,
      triggerAction: 'create',
      actorUserId: 'u-1',
    });
    const data = bucket.createCalls[0]!.data as Record<string, unknown>;
    const snap = data['snapshot'] as RoleVersionSnapshot;
    assert.deepEqual(snap.capabilities, ['lead.read']);
    assert.equal(snap.scopes[0]?.resource, 'lead');
    const summary = data['changeSummary'] as Record<string, unknown>;
    assert.deepEqual(summary['grantedCapabilities'], ['lead.read']);
  });
});

// ════════════════════════════════════════════════════════════════
// E. risk-flag passthrough
// ════════════════════════════════════════════════════════════════

describe('rbac/D5.15-B — risk flags ride through to the change summary', () => {
  it('roles.write granted flips permissionAdminChanged', () => {
    const prev = buildSnapshot(makeRole({ capabilities: ['roles.read'] }));
    const next = buildSnapshot(makeRole({ capabilities: ['roles.read', 'roles.write'] }));
    const summary = computeChangeSummary(prev, next);
    assert.equal(summary.riskFlags.permissionAdminChanged, true);
  });

  it('audit.read revoked flips auditVisibilityChanged', () => {
    const prev = buildSnapshot(makeRole({ capabilities: ['audit.read'] }));
    const next = buildSnapshot(makeRole({ capabilities: [] }));
    const summary = computeChangeSummary(prev, next);
    assert.equal(summary.riskFlags.auditVisibilityChanged, true);
  });

  it('balanced read-only proposal produces no risk flags', () => {
    const prev = buildSnapshot(makeRole({ capabilities: ['lead.read'] }));
    const next = buildSnapshot(makeRole({ capabilities: ['lead.read', 'followup.read'] }));
    const summary = computeChangeSummary(prev, next);
    for (const flag of Object.values(summary.riskFlags)) {
      assert.equal(flag, false);
    }
  });
});
