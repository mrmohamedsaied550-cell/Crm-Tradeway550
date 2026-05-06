/**
 * Phase D5 — D5.14: capability dependency graph + lockout safety.
 *
 * Pure unit tests covering:
 *
 *   A. Graph invariants — acyclic, every code referenced exists in
 *      the global capability registry, every right-hand-side
 *      satisfaction list is non-empty.
 *
 *   B. analyseCapabilitySet — pure helper:
 *        — dependency.missing surfaces when a write/export verb
 *          is set without its paired read cap;
 *        — multi-target dependency (partner.commission.export)
 *          accepts EITHER paired read;
 *        — high-risk warnings fire for export / partner_merge /
 *          lockout_admin / permission_preview kinds;
 *        — balanced sets produce zero warnings.
 *
 *   C. RoleDependencyService.analyseProposal:
 *        — system role triggers `role.system_immutable_attempt`;
 *        — actor editing OWN role + removing a SELF_LOCKOUT cap
 *          triggers `capability.lockout.self_required`;
 *        — TENANT_LAST_KEEPER cap removal with zero other keepers
 *          triggers `capability.lockout.last_admin`;
 *        — non-zero other keepers does NOT trigger lockout;
 *        — `role.not_found` for an unknown role.
 *
 *   D. assertConfirmationOk:
 *        — passes silently when no critical warnings;
 *        — throws `RoleDependencyConfirmationRequiredError` when
 *          critical w/o the phrase;
 *        — passes when phrase matches `CONFIRM ROLE CHANGE` exactly;
 *        — case-sensitive match — wrong case still throws.
 *
 *   E. RoleDependencyConfirmationRequiredError.toResponse —
 *      carries `code`, `requiredPhrase`, and the analysis payload
 *      so the client renders the typed-confirmation modal with
 *      the same warnings the dependency-check endpoint shows.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ALL_CAPABILITY_CODES } from './capabilities.registry';
import {
  CAPABILITY_DEPENDENCIES,
  HIGH_RISK_CAPABILITIES,
  SELF_LOCKOUT_CAPABILITIES,
  TENANT_LAST_KEEPER_CAPABILITIES,
  analyseCapabilitySet,
  assertDependencyGraphAcyclic,
  unknownCodesInGraph,
} from './capability-dependencies';
import type { RbacService, RoleWithCapabilities } from './rbac.service';
import type { PrismaService } from '../prisma/prisma.service';
import { tenantContext } from '../tenants/tenant-context';
import {
  RoleDependencyConfirmationRequiredError,
  RoleDependencyService,
  TYPED_CONFIRMATION_PHRASE,
  type DependencyAnalysis,
} from './role-dependency.service';

/**
 * Run `fn` inside a synthetic tenant context so the service's
 * `requireTenantId()` calls don't throw. Mirrors the production
 * pattern (TenantContextMiddleware sets the store via
 * `tenantContext.run(...)` before any controller runs).
 */
function withTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    tenantContext.run({ tenantId, tenantCode: tenantId, source: 'system' }, () => {
      fn().then(resolve, reject);
    });
  });
}

// ─── helpers ──────────────────────────────────────────────────────

function makeRole(opts: {
  id?: string;
  code?: string;
  capabilities?: readonly string[];
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
    scopes: [],
    fieldPermissions: [],
  };
}

class FakeRbacService {
  constructor(private readonly rolesById: Map<string, RoleWithCapabilities>) {}
  async findRoleById(id: string): Promise<RoleWithCapabilities | null> {
    return this.rolesById.get(id) ?? null;
  }
}

/**
 * Stub PrismaService that captures `withTenant` invocations and
 * answers `tx.roleCapability.count` with a configurable number.
 * The dependency service only consumes that one call shape.
 */
function fakePrisma(otherKeeperCount = 0): PrismaService {
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

function buildService(
  roles: ReadonlyArray<RoleWithCapabilities>,
  otherKeeperCount = 0,
): RoleDependencyService {
  const rolesById = new Map(roles.map((r) => [r.id, r]));
  return new RoleDependencyService(
    fakePrisma(otherKeeperCount),
    new FakeRbacService(rolesById) as unknown as RbacService,
  );
}

// All `analyseProposal` calls happen inside a tenant context; the
// production wiring sets it via the tenant middleware. The unit
// tests run the call through `withTenant` so
// `requireTenantId()` doesn't throw.
const TENANT_ID = 't-1';

// ════════════════════════════════════════════════════════════════
// A. Graph invariants
// ════════════════════════════════════════════════════════════════

describe('rbac/D5.14 — capability dependency graph invariants', () => {
  it('is acyclic (topological sort succeeds)', () => {
    assert.doesNotThrow(() => assertDependencyGraphAcyclic());
  });

  it('every code referenced in the graph exists in CAPABILITY_DEFINITIONS', () => {
    const unknown = unknownCodesInGraph();
    assert.deepEqual(
      unknown,
      [],
      `unknown capability codes referenced by the dependency graph: ${unknown.join(', ')}`,
    );
  });

  it('every dependency satisfaction list is non-empty', () => {
    for (const [cap, deps] of Object.entries(CAPABILITY_DEPENDENCIES)) {
      assert.ok(deps.length > 0, `${cap} has an empty dependency list`);
    }
  });

  it('every dependency entry uses a known global capability code', () => {
    const known: ReadonlySet<string> = new Set(ALL_CAPABILITY_CODES);
    for (const [cap, deps] of Object.entries(CAPABILITY_DEPENDENCIES)) {
      assert.ok(known.has(cap), `dependency LHS '${cap}' is not in CAPABILITY_DEFINITIONS`);
      for (const d of deps) {
        assert.ok(
          known.has(d),
          `dependency RHS '${d}' (for ${cap}) is not in CAPABILITY_DEFINITIONS`,
        );
      }
    }
  });

  it('high-risk capability map references only known codes', () => {
    const known: ReadonlySet<string> = new Set(ALL_CAPABILITY_CODES);
    for (const c of Object.keys(HIGH_RISK_CAPABILITIES)) {
      assert.ok(known.has(c), `high-risk code '${c}' is not in CAPABILITY_DEFINITIONS`);
    }
  });

  it('SELF_LOCKOUT_CAPABILITIES + TENANT_LAST_KEEPER_CAPABILITIES reference only known codes', () => {
    const known: ReadonlySet<string> = new Set(ALL_CAPABILITY_CODES);
    for (const c of SELF_LOCKOUT_CAPABILITIES) {
      assert.ok(known.has(c), `self-lockout code '${c}' is not in CAPABILITY_DEFINITIONS`);
    }
    for (const c of TENANT_LAST_KEEPER_CAPABILITIES) {
      assert.ok(known.has(c), `last-keeper code '${c}' is not in CAPABILITY_DEFINITIONS`);
    }
  });
});

// ════════════════════════════════════════════════════════════════
// B. analyseCapabilitySet (pure)
// ════════════════════════════════════════════════════════════════

describe('rbac/D5.14 — analyseCapabilitySet', () => {
  it('lead.write without lead.read fires dependency.missing', () => {
    const w = analyseCapabilitySet(['lead.write']);
    const dep = w.find((x) => x.code === 'capability.dependency.missing');
    assert.ok(dep, 'expected a dependency.missing warning');
    assert.equal(dep!.capability, 'lead.write');
    assert.deepEqual(dep!.dependsOn, ['lead.read']);
    assert.equal(dep!.severity, 'warning');
  });

  it('lead.export without lead.read fires dependency.missing', () => {
    const w = analyseCapabilitySet(['lead.export']);
    const dep = w.find(
      (x) => x.code === 'capability.dependency.missing' && x.capability === 'lead.export',
    );
    assert.ok(dep);
  });

  it('partner.merge.write without partner.verification.read fires dependency.missing', () => {
    const w = analyseCapabilitySet(['partner.merge.write']);
    const dep = w.find(
      (x) => x.code === 'capability.dependency.missing' && x.capability === 'partner.merge.write',
    );
    assert.ok(dep);
    assert.deepEqual(dep!.dependsOn, ['partner.verification.read']);
  });

  it('partner.commission.export accepts EITHER reconciliation.read OR verification.read', () => {
    const a = analyseCapabilitySet(['partner.commission.export', 'partner.reconciliation.read']);
    assert.equal(
      a.find(
        (x) =>
          x.code === 'capability.dependency.missing' &&
          x.capability === 'partner.commission.export',
      ),
      undefined,
      'reconciliation.read should satisfy the OR-dependency',
    );
    const b = analyseCapabilitySet(['partner.commission.export', 'partner.verification.read']);
    assert.equal(
      b.find(
        (x) =>
          x.code === 'capability.dependency.missing' &&
          x.capability === 'partner.commission.export',
      ),
      undefined,
      'verification.read should satisfy the OR-dependency',
    );
    const c = analyseCapabilitySet(['partner.commission.export']);
    assert.ok(
      c.find(
        (x) =>
          x.code === 'capability.dependency.missing' &&
          x.capability === 'partner.commission.export',
      ),
      'absence of both should fire the warning',
    );
  });

  it('tenant.export fires high-risk.export warning', () => {
    const w = analyseCapabilitySet(['tenant.export']);
    const hi = w.find((x) => x.code === 'capability.high_risk.export');
    assert.ok(hi);
    assert.equal(hi!.capability, 'tenant.export');
    assert.equal(hi!.severity, 'warning');
  });

  it('roles.write fires high_risk.lockout_admin warning', () => {
    const w = analyseCapabilitySet(['roles.read', 'roles.write']);
    const hi = w.find((x) => x.code === 'capability.high_risk.lockout_admin');
    assert.ok(hi);
    assert.equal(hi!.capability, 'roles.write');
  });

  it('partner.merge.write fires high_risk.partner_merge warning', () => {
    const w = analyseCapabilitySet(['partner.verification.read', 'partner.merge.write']);
    const hi = w.find((x) => x.code === 'capability.high_risk.partner_merge');
    assert.ok(hi);
  });

  it('permission.preview fires high_risk.permission_preview warning', () => {
    const w = analyseCapabilitySet(['roles.read', 'permission.preview']);
    const hi = w.find((x) => x.code === 'capability.high_risk.permission_preview');
    assert.ok(hi);
  });

  it('balanced read-only set produces zero warnings', () => {
    const w = analyseCapabilitySet(['lead.read', 'followup.read', 'whatsapp.conversation.read']);
    assert.equal(w.length, 0);
  });

  it('every warning uses the documented severity vocabulary', () => {
    const w = analyseCapabilitySet([
      'lead.write',
      'tenant.export',
      'partner.merge.write',
      'permission.preview',
    ]);
    for (const ww of w) {
      assert.ok(['info', 'warning', 'critical'].includes(ww.severity));
    }
  });
});

// ════════════════════════════════════════════════════════════════
// C. RoleDependencyService.analyseProposal — DB-backed checks
// ════════════════════════════════════════════════════════════════

describe('rbac/D5.14 — analyseProposal (system / self-lockout / last-keeper)', () => {
  it('system role triggers role.system_immutable_attempt (critical)', async () => {
    const role = makeRole({
      id: 'role-system',
      code: 'super_admin',
      isSystem: true,
      capabilities: ['lead.read'],
    });
    const svc = buildService([role]);
    const analysis = await withTenant(TENANT_ID, () =>
      svc.analyseProposal({
        roleId: role.id,
        proposedCapabilities: ['lead.read'],
        actor: { userId: 'u-1', roleId: 'role-other' },
      }),
    );
    const warning = analysis.warnings.find((w) => w.code === 'role.system_immutable_attempt');
    assert.ok(warning, 'system roles must surface system_immutable_attempt');
    assert.equal(warning!.severity, 'critical');
    assert.equal(analysis.requiresTypedConfirmation, true);
    assert.equal(analysis.typedConfirmationPhrase, TYPED_CONFIRMATION_PHRASE);
  });

  it('actor editing own role + removing roles.write fires self_required (critical)', async () => {
    const role = makeRole({
      id: 'role-mine',
      code: 'tenant_admin',
      capabilities: ['roles.read', 'roles.write'],
    });
    const svc = buildService([role], 5 /* plenty of other keepers */);
    const analysis = await withTenant(TENANT_ID, () =>
      svc.analyseProposal({
        roleId: role.id,
        proposedCapabilities: ['roles.read'], // dropping roles.write
        actor: { userId: 'u-1', roleId: role.id }, // editing own role
      }),
    );
    const w = analysis.warnings.find((x) => x.code === 'capability.lockout.self_required');
    assert.ok(w);
    assert.equal(w!.severity, 'critical');
    assert.equal(w!.capability, 'roles.write');
    assert.equal(analysis.requiresTypedConfirmation, true);
  });

  it('actor editing different role does NOT fire self_required', async () => {
    const role = makeRole({
      id: 'role-other',
      capabilities: ['roles.read', 'roles.write'],
    });
    const svc = buildService([role], 5);
    const analysis = await withTenant(TENANT_ID, () =>
      svc.analyseProposal({
        roleId: role.id,
        proposedCapabilities: ['roles.read'],
        actor: { userId: 'u-1', roleId: 'role-mine' }, // different role
      }),
    );
    const w = analysis.warnings.find((x) => x.code === 'capability.lockout.self_required');
    assert.equal(w, undefined);
  });

  it('removing roles.write with zero other keepers fires last_admin (critical)', async () => {
    const role = makeRole({
      id: 'role-mine',
      capabilities: ['roles.read', 'roles.write'],
    });
    const svc = buildService([role], 0 /* no other keepers */);
    const analysis = await withTenant(TENANT_ID, () =>
      svc.analyseProposal({
        roleId: role.id,
        proposedCapabilities: ['roles.read'],
        actor: { userId: 'u-1', roleId: 'role-other' },
      }),
    );
    const w = analysis.warnings.find((x) => x.code === 'capability.lockout.last_admin');
    assert.ok(w);
    assert.equal(w!.severity, 'critical');
    assert.equal(w!.capability, 'roles.write');
  });

  it('removing roles.write with other keepers present does NOT fire last_admin', async () => {
    const role = makeRole({
      id: 'role-mine',
      capabilities: ['roles.read', 'roles.write'],
    });
    const svc = buildService([role], 1 /* one other role still has it */);
    const analysis = await withTenant(TENANT_ID, () =>
      svc.analyseProposal({
        roleId: role.id,
        proposedCapabilities: ['roles.read'],
        actor: { userId: 'u-1', roleId: 'role-other' },
      }),
    );
    const w = analysis.warnings.find((x) => x.code === 'capability.lockout.last_admin');
    assert.equal(w, undefined);
  });

  it('analyseProposal throws role.not_found for unknown role', async () => {
    const svc = buildService([]);
    await assert.rejects(
      withTenant(TENANT_ID, () =>
        svc.analyseProposal({
          roleId: 'no-such-role',
          proposedCapabilities: [],
          actor: { userId: 'u-1', roleId: 'role-mine' },
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
// D. assertConfirmationOk
// ════════════════════════════════════════════════════════════════

describe('rbac/D5.14 — assertConfirmationOk', () => {
  function noCriticalAnalysis(): DependencyAnalysis {
    return {
      warnings: [],
      severityCounts: { info: 0, warning: 0, critical: 0 },
      requiresTypedConfirmation: false,
      typedConfirmationPhrase: TYPED_CONFIRMATION_PHRASE,
    };
  }
  function criticalAnalysis(): DependencyAnalysis {
    return {
      warnings: [
        {
          code: 'capability.lockout.self_required',
          severity: 'critical',
          capability: 'roles.write',
          dependsOn: [],
          messageKey: 'admin.roles.dependency.warnings.selfLockout',
          meta: { capability: 'roles.write' },
        },
      ],
      severityCounts: { info: 0, warning: 0, critical: 1 },
      requiresTypedConfirmation: true,
      typedConfirmationPhrase: TYPED_CONFIRMATION_PHRASE,
    };
  }

  const svc = new RoleDependencyService(
    fakePrisma(),
    new FakeRbacService(new Map()) as unknown as RbacService,
  );

  it('passes silently when no critical warnings', () => {
    assert.doesNotThrow(() => svc.assertConfirmationOk(noCriticalAnalysis(), undefined));
    assert.doesNotThrow(() => svc.assertConfirmationOk(noCriticalAnalysis(), 'WHATEVER'));
  });

  it('throws RoleDependencyConfirmationRequiredError when critical w/o phrase', () => {
    assert.throws(
      () => svc.assertConfirmationOk(criticalAnalysis(), undefined),
      RoleDependencyConfirmationRequiredError,
    );
  });

  it('throws when phrase is wrong (case-sensitive)', () => {
    assert.throws(
      () => svc.assertConfirmationOk(criticalAnalysis(), 'confirm role change'),
      RoleDependencyConfirmationRequiredError,
    );
  });

  it('passes when phrase matches CONFIRM ROLE CHANGE exactly', () => {
    assert.doesNotThrow(() =>
      svc.assertConfirmationOk(criticalAnalysis(), TYPED_CONFIRMATION_PHRASE),
    );
  });
});

// ════════════════════════════════════════════════════════════════
// E. RoleDependencyConfirmationRequiredError.toResponse shape
// ════════════════════════════════════════════════════════════════

describe('rbac/D5.14 — RoleDependencyConfirmationRequiredError', () => {
  it('toResponse carries code, requiredPhrase, and the analysis', () => {
    const analysis: DependencyAnalysis = {
      warnings: [
        {
          code: 'capability.lockout.last_admin',
          severity: 'critical',
          capability: 'roles.write',
          dependsOn: [],
          messageKey: 'admin.roles.dependency.warnings.lastAdmin',
          meta: { capability: 'roles.write', otherKeepers: 0 },
        },
      ],
      severityCounts: { info: 0, warning: 0, critical: 1 },
      requiresTypedConfirmation: true,
      typedConfirmationPhrase: TYPED_CONFIRMATION_PHRASE,
    };
    const err = new RoleDependencyConfirmationRequiredError(analysis);
    const res = err.toResponse();
    assert.equal(res.code, 'role.dependency.confirmation_required');
    assert.equal(res.requiredPhrase, TYPED_CONFIRMATION_PHRASE);
    assert.equal(res.analysis.requiresTypedConfirmation, true);
    assert.equal(res.analysis.warnings.length, 1);
    assert.equal(res.analysis.warnings[0]?.code, 'capability.lockout.last_admin');
    // `message` is human-readable but stable enough to assert on.
    assert.match(res.message, /typed confirmation|confirmation phrase/i);
  });
});
