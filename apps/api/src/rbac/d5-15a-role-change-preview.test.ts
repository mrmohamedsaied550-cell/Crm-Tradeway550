/**
 * Phase D5 — D5.15-A: structural change-set preview for the
 * role builder.
 *
 * Pure unit tests covering:
 *
 *   A. Capability diff — granted / revoked / unchangedCount,
 *      sorted output, identical input → empty diff.
 *
 *   B. Field-permission diff — read- / write-deny additions
 *      and removals, default-permissive rows ignored.
 *
 *   C. Scope diff — added / removed / changed bucketing.
 *
 *   D. Risk summary flags — exportCapabilityAdded /
 *      exportCapabilityRevoked, ownerHistoryVisibilityChanged,
 *      auditVisibilityChanged, backupExportChanged,
 *      permissionAdminChanged, partnerMergeChanged.
 *
 *   E. Dependency analysis passthrough — D5.14 warnings ride
 *      verbatim; `requiresTypedConfirmation` is preserved.
 *
 *   F. No-mutation invariant — the service NEVER touches the
 *      role's stored state. The fake RbacService records every
 *      method call; the test asserts only `findRoleById` was
 *      hit.
 *
 *   G. role.not_found — out-of-tenant role surfaces the same
 *      error code as the rest of the surface.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { RbacService, RoleWithCapabilities } from './rbac.service';
import type { PrismaService } from '../prisma/prisma.service';
import { tenantContext } from '../tenants/tenant-context';
import { RoleChangePreviewService } from './role-change-preview.service';
import { RoleDependencyService, TYPED_CONFIRMATION_PHRASE } from './role-dependency.service';

// ─── helpers ──────────────────────────────────────────────────────

function withTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    tenantContext.run({ tenantId, tenantCode: tenantId, source: 'system' }, () => {
      fn().then(resolve, reject);
    });
  });
}

function makeRole(opts: {
  id?: string;
  code?: string;
  capabilities?: readonly string[];
  scopes?: ReadonlyArray<{ resource: string; scope: string }>;
  fieldPermissions?: ReadonlyArray<{
    resource: string;
    field: string;
    canRead: boolean;
    canWrite: boolean;
  }>;
  isSystem?: boolean;
}): RoleWithCapabilities {
  return {
    id: opts.id ?? 'role-1',
    code: opts.code ?? 'ops_manager',
    nameAr: 'دور',
    nameEn: 'Role',
    level: 60,
    isActive: true,
    isSystem: opts.isSystem ?? false,
    description: null,
    capabilities: opts.capabilities ?? [],
    scopes: (opts.scopes ?? []) as RoleWithCapabilities['scopes'],
    fieldPermissions: (opts.fieldPermissions ?? []) as RoleWithCapabilities['fieldPermissions'],
  };
}

class FakeRbacService {
  public readonly findRoleByIdCalls: string[] = [];
  /** Names of methods called on the fake — used by the no-mutation test. */
  public readonly methodCalls: string[] = [];
  constructor(private readonly rolesById: Map<string, RoleWithCapabilities>) {}
  async findRoleById(id: string): Promise<RoleWithCapabilities | null> {
    this.findRoleByIdCalls.push(id);
    this.methodCalls.push('findRoleById');
    return this.rolesById.get(id) ?? null;
  }
}

function fakePrisma(otherKeeperCount = 5): PrismaService {
  const tx = {
    roleCapability: {
      count: async () => otherKeeperCount,
    },
  };
  return {
    withTenant: async <T>(_tenantId: string, fn: (tx: unknown) => Promise<T>): Promise<T> => {
      return fn(tx);
    },
  } as unknown as PrismaService;
}

function buildPair(
  roles: ReadonlyArray<RoleWithCapabilities>,
  otherKeeperCount = 5,
): { svc: RoleChangePreviewService; rbac: FakeRbacService } {
  const rolesById = new Map(roles.map((r) => [r.id, r]));
  const rbac = new FakeRbacService(rolesById);
  const prisma = fakePrisma(otherKeeperCount);
  const dependency = new RoleDependencyService(prisma, rbac as unknown as RbacService);
  const svc = new RoleChangePreviewService(rbac as unknown as RbacService, dependency);
  return { svc, rbac };
}

const TENANT_ID = 't-1';
const ACTOR = { userId: 'u-1', roleId: 'role-other' };

// ════════════════════════════════════════════════════════════════
// A. capability diff
// ════════════════════════════════════════════════════════════════

describe('rbac/D5.15-A — capability diff', () => {
  it('granted / revoked / unchangedCount are computed correctly', async () => {
    const role = makeRole({
      id: 'r1',
      capabilities: ['lead.read', 'lead.write', 'audit.read'],
    });
    const { svc } = buildPair([role]);
    const out = await withTenant(TENANT_ID, () =>
      svc.preview({
        roleId: 'r1',
        proposedCapabilities: ['lead.read', 'audit.read', 'audit.export'],
        actor: ACTOR,
      }),
    );
    assert.deepEqual(out.changes.capabilities.granted, ['audit.export']);
    assert.deepEqual(out.changes.capabilities.revoked, ['lead.write']);
    assert.equal(out.changes.capabilities.unchangedCount, 2);
    assert.equal(out.hasChanges, true);
  });

  it('identical proposal returns empty diff and hasChanges=false', async () => {
    const role = makeRole({
      id: 'r1',
      capabilities: ['lead.read', 'lead.write'],
    });
    const { svc } = buildPair([role]);
    const out = await withTenant(TENANT_ID, () =>
      svc.preview({
        roleId: 'r1',
        proposedCapabilities: ['lead.write', 'lead.read'],
        actor: ACTOR,
      }),
    );
    assert.deepEqual(out.changes.capabilities.granted, []);
    assert.deepEqual(out.changes.capabilities.revoked, []);
    assert.equal(out.changes.capabilities.unchangedCount, 2);
    assert.equal(out.hasChanges, false);
  });

  it('omitted proposal treats capability axis as unchanged', async () => {
    const role = makeRole({
      id: 'r1',
      capabilities: ['lead.read', 'lead.write'],
    });
    const { svc } = buildPair([role]);
    const out = await withTenant(TENANT_ID, () => svc.preview({ roleId: 'r1', actor: ACTOR }));
    assert.equal(out.changes.capabilities.granted.length, 0);
    assert.equal(out.changes.capabilities.revoked.length, 0);
    assert.equal(out.changes.capabilities.unchangedCount, role.capabilities.length);
  });

  it('granted / revoked lists are sorted alphabetically', async () => {
    const role = makeRole({
      id: 'r1',
      capabilities: [],
    });
    const { svc } = buildPair([role]);
    const out = await withTenant(TENANT_ID, () =>
      svc.preview({
        roleId: 'r1',
        proposedCapabilities: ['lead.write', 'lead.read', 'audit.read'],
        actor: ACTOR,
      }),
    );
    assert.deepEqual(out.changes.capabilities.granted, ['audit.read', 'lead.read', 'lead.write']);
  });
});

// ════════════════════════════════════════════════════════════════
// B. field-permission diff
// ════════════════════════════════════════════════════════════════

describe('rbac/D5.15-A — field-permission diff', () => {
  it('readDeniedAdded captures rows that newly deny read', async () => {
    const role = makeRole({
      id: 'r1',
      capabilities: ['lead.read'],
      fieldPermissions: [],
    });
    const { svc } = buildPair([role]);
    const out = await withTenant(TENANT_ID, () =>
      svc.preview({
        roleId: 'r1',
        proposedFieldPermissions: [
          { resource: 'lead', field: 'previousOwner', canRead: false, canWrite: true },
        ],
        actor: ACTOR,
      }),
    );
    assert.deepEqual(out.changes.fieldPermissions.readDeniedAdded, [
      { resource: 'lead', field: 'previousOwner' },
    ]);
    assert.equal(out.changes.fieldPermissions.readDeniedRemoved.length, 0);
  });

  it('readDeniedRemoved captures rows that no longer deny read', async () => {
    const role = makeRole({
      id: 'r1',
      capabilities: ['lead.read'],
      fieldPermissions: [
        { resource: 'lead', field: 'previousOwner', canRead: false, canWrite: true },
      ],
    });
    const { svc } = buildPair([role]);
    const out = await withTenant(TENANT_ID, () =>
      svc.preview({
        roleId: 'r1',
        proposedFieldPermissions: [],
        actor: ACTOR,
      }),
    );
    assert.deepEqual(out.changes.fieldPermissions.readDeniedRemoved, [
      { resource: 'lead', field: 'previousOwner' },
    ]);
  });

  it('default-permissive rows (canRead=true, canWrite=true) do not enter the deny diff', async () => {
    const role = makeRole({ id: 'r1', capabilities: ['lead.read'], fieldPermissions: [] });
    const { svc } = buildPair([role]);
    const out = await withTenant(TENANT_ID, () =>
      svc.preview({
        roleId: 'r1',
        proposedFieldPermissions: [
          { resource: 'lead', field: 'phone', canRead: true, canWrite: true },
        ],
        actor: ACTOR,
      }),
    );
    assert.equal(out.changes.fieldPermissions.readDeniedAdded.length, 0);
    assert.equal(out.changes.fieldPermissions.writeDeniedAdded.length, 0);
  });

  it('write-deny diff is independent of read-deny diff', async () => {
    const role = makeRole({ id: 'r1', capabilities: ['lead.read'], fieldPermissions: [] });
    const { svc } = buildPair([role]);
    const out = await withTenant(TENANT_ID, () =>
      svc.preview({
        roleId: 'r1',
        proposedFieldPermissions: [
          // Read OK, Write denied
          { resource: 'lead', field: 'companyId', canRead: true, canWrite: false },
        ],
        actor: ACTOR,
      }),
    );
    assert.equal(out.changes.fieldPermissions.readDeniedAdded.length, 0);
    assert.deepEqual(out.changes.fieldPermissions.writeDeniedAdded, [
      { resource: 'lead', field: 'companyId' },
    ]);
  });
});

// ════════════════════════════════════════════════════════════════
// C. scope diff
// ════════════════════════════════════════════════════════════════

describe('rbac/D5.15-A — scope diff', () => {
  it('changed scope rows surface from / to', async () => {
    const role = makeRole({
      id: 'r1',
      capabilities: ['lead.read'],
      scopes: [{ resource: 'lead', scope: 'team' }],
    });
    const { svc } = buildPair([role]);
    const out = await withTenant(TENANT_ID, () =>
      svc.preview({
        roleId: 'r1',
        proposedScopes: [{ resource: 'lead', scope: 'global' }],
        actor: ACTOR,
      }),
    );
    assert.equal(out.changes.scopes.changed.length, 1);
    assert.deepEqual(out.changes.scopes.changed[0], {
      resource: 'lead',
      from: 'team',
      to: 'global',
    });
    assert.equal(out.changes.scopes.added.length, 0);
    assert.equal(out.changes.scopes.removed.length, 0);
  });

  it('added scope row surfaces in `added` bucket', async () => {
    const role = makeRole({ id: 'r1', capabilities: ['lead.read'], scopes: [] });
    const { svc } = buildPair([role]);
    const out = await withTenant(TENANT_ID, () =>
      svc.preview({
        roleId: 'r1',
        proposedScopes: [{ resource: 'captain', scope: 'team' }],
        actor: ACTOR,
      }),
    );
    assert.deepEqual(out.changes.scopes.added, [{ resource: 'captain', scope: 'team' }]);
    assert.equal(out.changes.scopes.changed.length, 0);
  });

  it('removed scope row surfaces in `removed` bucket', async () => {
    const role = makeRole({
      id: 'r1',
      capabilities: ['lead.read'],
      scopes: [{ resource: 'captain', scope: 'team' }],
    });
    const { svc } = buildPair([role]);
    const out = await withTenant(TENANT_ID, () =>
      svc.preview({
        roleId: 'r1',
        proposedScopes: [],
        actor: ACTOR,
      }),
    );
    assert.deepEqual(out.changes.scopes.removed, [{ resource: 'captain', scope: 'team' }]);
  });
});

// ════════════════════════════════════════════════════════════════
// D. risk summary
// ════════════════════════════════════════════════════════════════

describe('rbac/D5.15-A — risk summary flags', () => {
  it('exportCapabilityAdded fires when an export verb is granted', async () => {
    const role = makeRole({ id: 'r1', capabilities: ['report.read'] });
    const { svc } = buildPair([role]);
    const out = await withTenant(TENANT_ID, () =>
      svc.preview({
        roleId: 'r1',
        proposedCapabilities: ['report.read', 'report.export'],
        actor: ACTOR,
      }),
    );
    assert.equal(out.riskSummary.exportCapabilityAdded, true);
    assert.equal(out.riskSummary.exportCapabilityRevoked, false);
  });

  it('exportCapabilityRevoked fires when an export verb is removed', async () => {
    const role = makeRole({
      id: 'r1',
      capabilities: ['report.read', 'report.export'],
    });
    const { svc } = buildPair([role]);
    const out = await withTenant(TENANT_ID, () =>
      svc.preview({
        roleId: 'r1',
        proposedCapabilities: ['report.read'],
        actor: ACTOR,
      }),
    );
    assert.equal(out.riskSummary.exportCapabilityRevoked, true);
    assert.equal(out.riskSummary.exportCapabilityAdded, false);
  });

  it('backupExportChanged fires when tenant.export / lead.export / audit.export change', async () => {
    const role = makeRole({ id: 'r1', capabilities: [] });
    const { svc } = buildPair([role]);
    const out = await withTenant(TENANT_ID, () =>
      svc.preview({
        roleId: 'r1',
        proposedCapabilities: ['tenant.export'],
        actor: ACTOR,
      }),
    );
    assert.equal(out.riskSummary.backupExportChanged, true);
  });

  it('permissionAdminChanged fires for roles.write / permission.preview changes', async () => {
    const role = makeRole({ id: 'r1', capabilities: [] });
    const { svc } = buildPair([role]);
    const out = await withTenant(TENANT_ID, () =>
      svc.preview({
        roleId: 'r1',
        proposedCapabilities: ['roles.read', 'roles.write'],
        actor: ACTOR,
      }),
    );
    assert.equal(out.riskSummary.permissionAdminChanged, true);
  });

  it('partnerMergeChanged fires when partner.merge.write is granted or revoked', async () => {
    const role = makeRole({
      id: 'r1',
      capabilities: ['partner.verification.read'],
    });
    const { svc } = buildPair([role]);
    const out = await withTenant(TENANT_ID, () =>
      svc.preview({
        roleId: 'r1',
        proposedCapabilities: ['partner.verification.read', 'partner.merge.write'],
        actor: ACTOR,
      }),
    );
    assert.equal(out.riskSummary.partnerMergeChanged, true);
  });

  it('auditVisibilityChanged fires for audit.read toggle OR audit.payload field perm change', async () => {
    const role = makeRole({ id: 'r1', capabilities: [] });
    const { svc } = buildPair([role]);
    const a = await withTenant(TENANT_ID, () =>
      svc.preview({
        roleId: 'r1',
        proposedCapabilities: ['audit.read'],
        actor: ACTOR,
      }),
    );
    assert.equal(a.riskSummary.auditVisibilityChanged, true);

    const b = await withTenant(TENANT_ID, () =>
      svc.preview({
        roleId: 'r1',
        proposedFieldPermissions: [
          { resource: 'audit', field: 'payload', canRead: false, canWrite: true },
        ],
        actor: ACTOR,
      }),
    );
    assert.equal(b.riskSummary.auditVisibilityChanged, true);
  });

  it('ownerHistoryVisibilityChanged fires when owner-history field perms change', async () => {
    const role = makeRole({ id: 'r1', capabilities: ['lead.read'] });
    const { svc } = buildPair([role]);
    const out = await withTenant(TENANT_ID, () =>
      svc.preview({
        roleId: 'r1',
        proposedFieldPermissions: [
          { resource: 'rotation', field: 'fromUser', canRead: false, canWrite: true },
        ],
        actor: ACTOR,
      }),
    );
    assert.equal(out.riskSummary.ownerHistoryVisibilityChanged, true);
  });

  it('balanced read-only proposal produces no risk flags', async () => {
    const role = makeRole({ id: 'r1', capabilities: ['lead.read'] });
    const { svc } = buildPair([role]);
    const out = await withTenant(TENANT_ID, () =>
      svc.preview({
        roleId: 'r1',
        proposedCapabilities: ['lead.read', 'followup.read'],
        actor: ACTOR,
      }),
    );
    assert.equal(out.riskSummary.exportCapabilityAdded, false);
    assert.equal(out.riskSummary.exportCapabilityRevoked, false);
    assert.equal(out.riskSummary.backupExportChanged, false);
    assert.equal(out.riskSummary.auditVisibilityChanged, false);
    assert.equal(out.riskSummary.ownerHistoryVisibilityChanged, false);
    assert.equal(out.riskSummary.permissionAdminChanged, false);
    assert.equal(out.riskSummary.partnerMergeChanged, false);
  });
});

// ════════════════════════════════════════════════════════════════
// E. dependency analysis passthrough (D5.14 invariants)
// ════════════════════════════════════════════════════════════════

describe('rbac/D5.15-A — dependency analysis passthrough', () => {
  it('dependency warnings ride verbatim on the preview response', async () => {
    const role = makeRole({ id: 'r1', capabilities: [] });
    const { svc } = buildPair([role]);
    const out = await withTenant(TENANT_ID, () =>
      svc.preview({
        roleId: 'r1',
        // lead.write without lead.read fires dependency.missing
        proposedCapabilities: ['lead.write'],
        actor: ACTOR,
      }),
    );
    const w = out.warnings.find(
      (x) => x.code === 'capability.dependency.missing' && x.capability === 'lead.write',
    );
    assert.ok(w, 'preview response must surface D5.14 dependency.missing warnings');
    assert.equal(out.typedConfirmationPhrase, TYPED_CONFIRMATION_PHRASE);
  });

  it('critical warnings set requiresTypedConfirmation=true on preview', async () => {
    const role = makeRole({
      id: 'role-mine',
      capabilities: ['roles.read', 'roles.write'],
    });
    // Actor editing OWN role + dropping roles.write fires self_required.
    const { svc } = buildPair([role], 5);
    const out = await withTenant(TENANT_ID, () =>
      svc.preview({
        roleId: 'role-mine',
        proposedCapabilities: ['roles.read'],
        actor: { userId: 'u-1', roleId: 'role-mine' },
      }),
    );
    assert.equal(out.requiresTypedConfirmation, true);
    assert.equal(out.severityCounts.critical >= 1, true);
  });

  it('non-critical proposals leave requiresTypedConfirmation=false', async () => {
    const role = makeRole({ id: 'r1', capabilities: ['lead.read'] });
    const { svc } = buildPair([role]);
    const out = await withTenant(TENANT_ID, () =>
      svc.preview({
        roleId: 'r1',
        proposedCapabilities: ['lead.read', 'followup.read'],
        actor: ACTOR,
      }),
    );
    assert.equal(out.requiresTypedConfirmation, false);
    assert.equal(out.severityCounts.critical, 0);
  });
});

// ════════════════════════════════════════════════════════════════
// F. no-mutation invariant
// ════════════════════════════════════════════════════════════════

describe('rbac/D5.15-A — preview never mutates role state', () => {
  it('only `findRoleById` is called on the rbac service', async () => {
    const role = makeRole({
      id: 'r1',
      capabilities: ['lead.read', 'lead.write'],
    });
    const { svc, rbac } = buildPair([role]);
    await withTenant(TENANT_ID, () =>
      svc.preview({
        roleId: 'r1',
        proposedCapabilities: ['lead.read', 'audit.read', 'audit.export'],
        proposedScopes: [{ resource: 'lead', scope: 'global' }],
        proposedFieldPermissions: [
          { resource: 'audit', field: 'payload', canRead: false, canWrite: false },
        ],
        actor: ACTOR,
      }),
    );
    // findRoleById is hit by the preview itself + once more by
    // the dependency analyser. Both are READS — no write methods.
    assert.equal(
      rbac.methodCalls.every((m) => m === 'findRoleById'),
      true,
      `non-read method was invoked on RbacService during preview: ${rbac.methodCalls.join(',')}`,
    );
    assert.ok(rbac.findRoleByIdCalls.length >= 1);
  });

  it('preview does not modify the input role object', async () => {
    const role = makeRole({
      id: 'r1',
      capabilities: ['lead.read', 'lead.write'],
    });
    const { svc } = buildPair([role]);
    const before = JSON.stringify({
      capabilities: role.capabilities,
      scopes: role.scopes,
      fieldPermissions: role.fieldPermissions,
    });
    await withTenant(TENANT_ID, () =>
      svc.preview({
        roleId: 'r1',
        proposedCapabilities: ['lead.read'],
        actor: ACTOR,
      }),
    );
    const after = JSON.stringify({
      capabilities: role.capabilities,
      scopes: role.scopes,
      fieldPermissions: role.fieldPermissions,
    });
    assert.equal(after, before, 'preview must not mutate the role row');
  });
});

// ════════════════════════════════════════════════════════════════
// G. role.not_found
// ════════════════════════════════════════════════════════════════

describe('rbac/D5.15-A — tenant scoping', () => {
  it('preview throws role.not_found when the role is not in the tenant', async () => {
    const { svc } = buildPair([]);
    await assert.rejects(
      withTenant(TENANT_ID, () =>
        svc.preview({
          roleId: 'no-such-role',
          proposedCapabilities: [],
          actor: ACTOR,
        }),
      ),
      (err: unknown) => {
        const e = err as { getResponse?: () => { code?: string } };
        return e.getResponse?.()?.code === 'role.not_found';
      },
    );
  });
});

// ════════════════════════════════════════════════════════════════
// H. preview audit shape (smoke)
// ════════════════════════════════════════════════════════════════

describe('rbac/D5.15-A — writePreviewAudit metadata shape', () => {
  it('emits a metadata-only payload (no proposed cap set, no row values)', async () => {
    const role = makeRole({ id: 'r1', capabilities: ['lead.read'] });
    const calls: Array<{ action: string; payload: Record<string, unknown> }> = [];
    const captureAudit = {
      writeEvent: async (input: { action: string; payload?: Record<string, unknown> }) => {
        calls.push({ action: input.action, payload: input.payload ?? {} });
      },
    };
    const rolesById = new Map([[role.id, role]]);
    const rbac = new FakeRbacService(rolesById);
    const dependency = new RoleDependencyService(fakePrisma(), rbac as unknown as RbacService);
    const svc = new RoleChangePreviewService(
      rbac as unknown as RbacService,
      dependency,
      captureAudit as unknown as import('../audit/audit.service').AuditService,
    );
    const result = await withTenant(TENANT_ID, () =>
      svc.preview({
        roleId: 'r1',
        proposedCapabilities: ['lead.read', 'audit.read', 'audit.export'],
        actor: ACTOR,
      }),
    );
    await svc.writePreviewAudit({
      actorUserId: ACTOR.userId,
      targetRoleId: role.id,
      targetRoleCode: role.code,
      result,
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.action, 'rbac.role.change_previewed');
    const p = calls[0]!.payload as Record<string, unknown>;
    // Metadata only — counts + flags. No proposed capability set,
    // no row values.
    assert.equal(typeof p['grantedCount'], 'number');
    assert.equal(typeof p['revokedCount'], 'number');
    assert.equal(typeof p['fieldChangeCount'], 'number');
    assert.equal(typeof p['scopeChangeCount'], 'number');
    assert.equal(typeof p['warningCount'], 'number');
    assert.equal(typeof p['requiresTypedConfirmation'], 'boolean');
    assert.equal(typeof p['riskFlags'], 'object');
    assert.equal(p['proposedCapabilities'], undefined);
    assert.equal(p['capabilities'], undefined);
  });
});
