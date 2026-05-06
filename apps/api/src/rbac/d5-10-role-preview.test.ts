/**
 * Phase D5 — D5.10: role permission preview.
 *
 * Five layers of assertions:
 *
 *   A. Capability registry — `permission.preview` is registered
 *      and granted ONLY to super_admin (via ALL_CAPABILITY_CODES)
 *      and ops_manager. Account manager / TL / agent cohort do
 *      NOT receive it.
 *
 *   B. RolePreviewService.previewRole — projection contains the
 *      expected sections, no field VALUES, audit row written.
 *
 *   C. Super-admin sandwich — only a super-admin caller may
 *      preview the super_admin role. ops_manager is rejected
 *      with `role.preview.forbidden` even with the cap.
 *
 *   D. Warnings — derived deterministically:
 *        — has_export_capabilities when role has any *.export
 *          or tenant.export
 *        — has_partner_data_access when role has partner.*.read
 *        — has_partner_merge_capability when role has partner.merge.write
 *        — has_audit_payload_access when role has audit.read AND
 *          no audit.payload deny
 *        — no_lead_read_capability when role lacks lead.read
 *        — has_hidden_owner_history_fields when D5.7 deny rows
 *          are present
 *        — has_super_admin_bypass on the super_admin role
 *
 *   E. UI hints — exportCapabilities lists *.export caps;
 *      hiddenFieldsByResource mirrors deniedRead;
 *      readOnlyFieldsByResource mirrors deniedWrite.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CAPABILITY_DEFINITIONS } from './capabilities.registry';
import { ROLE_DEFINITIONS } from './roles.registry';

import { AuditService } from '../audit/audit.service';
import type { RbacService, RoleWithCapabilities } from './rbac.service';
import {
  RolePreviewService,
  type RolePreviewResult,
  type RolePreviewWarningCode,
} from './role-preview.service';

// ─── helpers ──────────────────────────────────────────────────────

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
    code: (opts.code ?? 'ops_manager') as RoleWithCapabilities['code'],
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
  constructor(private readonly rolesById: Map<string, RoleWithCapabilities>) {}
  async findRoleById(id: string): Promise<RoleWithCapabilities | null> {
    return this.rolesById.get(id) ?? null;
  }
}

class CapturingAuditService extends AuditService {
  public readonly calls: Array<Parameters<AuditService['writeEvent']>[0]> = [];
  constructor() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    super({} as any);
  }
  override async writeEvent(input: Parameters<AuditService['writeEvent']>[0]): Promise<void> {
    this.calls.push(input);
  }
}

function buildSvc(rolesById: Map<string, RoleWithCapabilities>): {
  svc: RolePreviewService;
  audit: CapturingAuditService;
} {
  const fakeRbac = new FakeRbacService(rolesById) as unknown as RbacService;
  const audit = new CapturingAuditService();
  return { svc: new RolePreviewService(fakeRbac, audit), audit };
}

// ════════════════════════════════════════════════════════════════
// A. Capability registry + role grants
// ════════════════════════════════════════════════════════════════

describe('rbac/D5.10 — capability registry', () => {
  it('permission.preview is registered exactly once', () => {
    const matches = CAPABILITY_DEFINITIONS.filter((c) => c.code === 'permission.preview');
    assert.equal(matches.length, 1, 'permission.preview must be registered exactly once');
  });

  it('super_admin holds permission.preview (via ALL_CAPABILITY_CODES)', () => {
    const sa = ROLE_DEFINITIONS.find((r) => r.code === 'super_admin')!;
    assert.ok((sa.capabilities as readonly string[]).includes('permission.preview'));
  });

  it('ops_manager holds permission.preview', () => {
    const ops = ROLE_DEFINITIONS.find((r) => r.code === 'ops_manager')!;
    assert.ok((ops.capabilities as readonly string[]).includes('permission.preview'));
  });

  it('account_manager does NOT hold permission.preview by default', () => {
    const am = ROLE_DEFINITIONS.find((r) => r.code === 'account_manager')!;
    assert.equal(
      (am.capabilities as readonly string[]).includes('permission.preview'),
      false,
      'account_manager must not get permission.preview by default (D5.10 conservative grant)',
    );
  });

  it('TL roles do NOT hold permission.preview by default', () => {
    for (const code of ['tl_sales', 'tl_activation', 'tl_driving']) {
      const r = ROLE_DEFINITIONS.find((x) => x.code === code)!;
      assert.equal(
        (r.capabilities as readonly string[]).includes('permission.preview'),
        false,
        `${code} must not get permission.preview by default`,
      );
    }
  });

  it('agent + qa + viewer cohorts do NOT hold permission.preview', () => {
    for (const code of [
      'sales_agent',
      'activation_agent',
      'driving_agent',
      'qa_specialist',
      'viewer',
    ]) {
      const r = ROLE_DEFINITIONS.find((x) => x.code === code)!;
      assert.equal(
        (r.capabilities as readonly string[]).includes('permission.preview'),
        false,
        `${code} must not get permission.preview`,
      );
    }
  });
});

// ════════════════════════════════════════════════════════════════
// B. RolePreviewService — projection shape + audit
// ════════════════════════════════════════════════════════════════

describe('rbac/D5.10 — RolePreviewService.previewRole projection', () => {
  it('returns role / permissions / uiHints / warnings sections', async () => {
    const target = makeRole({
      id: 'r-target',
      code: 'sales_agent',
      capabilities: ['lead.read', 'lead.activity.write'],
      scopes: [{ resource: 'lead', scope: 'team' }],
      fieldPermissions: [
        { resource: 'lead', field: 'phone', canRead: false, canWrite: true },
        { resource: 'lead', field: 'previousOwner', canRead: false, canWrite: false },
      ],
    });
    const actor = makeRole({ id: 'r-actor', code: 'ops_manager' });
    const { svc } = buildSvc(
      new Map([
        [target.id, target],
        [actor.id, actor],
      ]),
    );

    const out = await svc.previewRole(target.id, {
      userId: 'u-actor',
      roleCode: 'ops_manager',
    });

    assert.equal(out.role.id, 'r-target');
    assert.equal(out.role.code, 'sales_agent');
    assert.deepEqual(out.permissions.scopesByResource, { lead: 'team' });
    assert.deepEqual(out.permissions.deniedReadFieldsByResource, {
      lead: ['phone', 'previousOwner'],
    });
    assert.deepEqual(out.permissions.deniedWriteFieldsByResource, { lead: ['previousOwner'] });
    assert.deepEqual(
      out.uiHints.hiddenFieldsByResource,
      out.permissions.deniedReadFieldsByResource,
    );
    assert.deepEqual(
      out.uiHints.readOnlyFieldsByResource,
      out.permissions.deniedWriteFieldsByResource,
    );
    assert.deepEqual(out.uiHints.exportCapabilities, []);
    assert.equal(out.uiHints.hasLeadRead, true);
  });

  it('payload contains structural metadata only — no row VALUES', async () => {
    const target = makeRole({
      id: 'r-1',
      code: 'sales_agent',
      capabilities: ['lead.read'],
      fieldPermissions: [{ resource: 'lead', field: 'phone', canRead: false, canWrite: false }],
    });
    const { svc } = buildSvc(new Map([[target.id, target]]));
    const out = await svc.previewRole(target.id, {
      userId: 'u-1',
      roleCode: 'super_admin',
    });
    const blob = JSON.stringify(out);
    // Field NAMES are present (metadata).
    assert.ok(blob.includes('phone'));
    // No PII / row VALUES can leak — there is no path for them.
    assert.equal(blob.includes('+201'), false);
    assert.equal(blob.includes('@example'), false);
  });

  it('writes an audit row with structural counters + warning codes', async () => {
    const target = makeRole({
      id: 'r-1',
      code: 'sales_agent',
      capabilities: ['lead.read'],
      fieldPermissions: [
        { resource: 'lead', field: 'previousOwner', canRead: false, canWrite: false },
        { resource: 'rotation', field: 'fromUser', canRead: false, canWrite: false },
      ],
    });
    const { svc, audit } = buildSvc(new Map([[target.id, target]]));
    await svc.previewRole(target.id, { userId: 'u-actor', roleCode: 'ops_manager' });

    assert.equal(audit.calls.length, 1);
    const call = audit.calls[0]!;
    assert.equal(call.action, 'rbac.role.previewed');
    assert.equal(call.entityType, 'role');
    assert.equal(call.entityId, 'r-1');
    assert.equal(call.actorUserId, 'u-actor');
    const payload = call.payload as {
      targetRoleId: string;
      targetRoleCode: string;
      capabilitiesCount: number;
      deniedReadCount: number;
      deniedWriteCount: number;
      warnings: string[];
    };
    assert.equal(payload.targetRoleId, 'r-1');
    assert.equal(payload.targetRoleCode, 'sales_agent');
    assert.equal(payload.capabilitiesCount, 1);
    assert.equal(payload.deniedReadCount, 2);
    assert.equal(payload.deniedWriteCount, 2);
    assert.ok(payload.warnings.includes('has_hidden_owner_history_fields'));
    // No row VALUES in audit payload.
    const blob = JSON.stringify(call.payload);
    assert.equal(blob.includes('+201'), false);
    assert.equal(blob.includes('@'), false);
  });

  it('returns the projection even when audit write throws', async () => {
    const target = makeRole({ id: 'r-1', capabilities: ['lead.read'] });
    const fakeRbac = {
      findRoleById: async () => target,
    } as unknown as RbacService;
    class ThrowingAudit extends AuditService {
      constructor() {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        super({} as any);
      }
      override async writeEvent(): Promise<void> {
        throw new Error('audit-down');
      }
    }
    const svc = new RolePreviewService(fakeRbac, new ThrowingAudit());
    // Must NOT throw — preview always ships.
    const out = await svc.previewRole('r-1', {
      userId: 'u-1',
      roleCode: 'ops_manager',
    });
    assert.equal(out.role.id, 'r-1');
  });

  it('throws role.not_found for an unknown role id', async () => {
    const { svc } = buildSvc(new Map());
    await assert.rejects(
      () => svc.previewRole('does-not-exist', { userId: 'u', roleCode: 'ops_manager' }),
      (err: { response?: { code?: string } } & Error) => {
        assert.equal(err.response?.code, 'role.not_found');
        return true;
      },
    );
  });
});

// ════════════════════════════════════════════════════════════════
// C. Super-admin sandwich
// ════════════════════════════════════════════════════════════════

describe('rbac/D5.10 — super-admin sandwich', () => {
  it('super-admin caller can preview super_admin', async () => {
    const target = makeRole({ id: 'r-sa', code: 'super_admin', capabilities: ['lead.read'] });
    const { svc } = buildSvc(new Map([[target.id, target]]));
    const out = await svc.previewRole(target.id, {
      userId: 'u-sa',
      roleCode: 'super_admin',
    });
    assert.equal(out.role.code, 'super_admin');
    assert.ok(out.warnings.includes('has_super_admin_bypass'));
  });

  it('ops_manager caller is REJECTED when previewing super_admin', async () => {
    const target = makeRole({ id: 'r-sa', code: 'super_admin', capabilities: ['lead.read'] });
    const { svc, audit } = buildSvc(new Map([[target.id, target]]));
    await assert.rejects(
      () =>
        svc.previewRole(target.id, {
          userId: 'u-ops',
          roleCode: 'ops_manager',
        }),
      (err: { response?: { code?: string } } & Error) => {
        assert.equal(err.response?.code, 'role.preview.forbidden');
        return true;
      },
    );
    // No audit row on the rejected path — the caller never saw
    // the projection.
    assert.equal(audit.calls.length, 0);
  });

  it('ops_manager can preview a normal role', async () => {
    const target = makeRole({ id: 'r-1', code: 'sales_agent', capabilities: ['lead.read'] });
    const { svc } = buildSvc(new Map([[target.id, target]]));
    const out = await svc.previewRole(target.id, {
      userId: 'u-ops',
      roleCode: 'ops_manager',
    });
    assert.equal(out.role.code, 'sales_agent');
  });
});

// ════════════════════════════════════════════════════════════════
// D. Warnings — deterministic derivation
// ════════════════════════════════════════════════════════════════

describe('rbac/D5.10 — warnings', () => {
  async function previewWith(
    capabilities: readonly string[],
    fieldPermissions: ReadonlyArray<{
      resource: string;
      field: string;
      canRead: boolean;
      canWrite: boolean;
    }> = [],
    code: string = 'custom_role',
  ): Promise<RolePreviewResult> {
    const target = makeRole({
      id: 'r-1',
      code,
      capabilities,
      fieldPermissions,
    });
    const { svc } = buildSvc(new Map([[target.id, target]]));
    return svc.previewRole(target.id, { userId: 'u', roleCode: 'super_admin' });
  }

  function expectWarning(out: RolePreviewResult, w: RolePreviewWarningCode): void {
    assert.ok(
      out.warnings.includes(w),
      `expected warning '${w}' in ${JSON.stringify(out.warnings)}`,
    );
  }
  function expectNoWarning(out: RolePreviewResult, w: RolePreviewWarningCode): void {
    assert.equal(
      out.warnings.includes(w),
      false,
      `expected NO warning '${w}' in ${JSON.stringify(out.warnings)}`,
    );
  }

  it('has_export_capabilities — *.export or tenant.export', async () => {
    const out = await previewWith(['lead.read', 'report.export']);
    expectWarning(out, 'has_export_capabilities');
    assert.deepEqual(out.uiHints.exportCapabilities, ['report.export']);
  });

  it('has_export_capabilities — picks tenant.export', async () => {
    const out = await previewWith(['lead.read', 'tenant.export']);
    expectWarning(out, 'has_export_capabilities');
    assert.deepEqual(out.uiHints.exportCapabilities, ['tenant.export']);
  });

  it('no warning when role lacks any export capability', async () => {
    const out = await previewWith(['lead.read']);
    expectNoWarning(out, 'has_export_capabilities');
    assert.deepEqual(out.uiHints.exportCapabilities, []);
  });

  it('has_partner_data_access — partner.*.read present', async () => {
    const out = await previewWith(['lead.read', 'partner.verification.read']);
    expectWarning(out, 'has_partner_data_access');
  });

  it('has_partner_merge_capability — partner.merge.write present', async () => {
    const out = await previewWith(['lead.read', 'partner.merge.write']);
    expectWarning(out, 'has_partner_merge_capability');
  });

  it('has_audit_payload_access — audit.read without payload denies', async () => {
    const out = await previewWith(['lead.read', 'audit.read']);
    expectWarning(out, 'has_audit_payload_access');
  });

  it('no audit warning when audit.payload is denied', async () => {
    const out = await previewWith(
      ['lead.read', 'audit.read'],
      [{ resource: 'audit', field: 'payload', canRead: false, canWrite: false }],
    );
    expectNoWarning(out, 'has_audit_payload_access');
  });

  it('no_lead_read_capability — when lead.read is missing', async () => {
    const out = await previewWith(['captain.read']);
    expectWarning(out, 'no_lead_read_capability');
    assert.equal(out.uiHints.hasLeadRead, false);
  });

  it('has_hidden_owner_history_fields — D5.7 deny rows', async () => {
    const out = await previewWith(
      ['lead.read'],
      [
        { resource: 'rotation', field: 'fromUser', canRead: false, canWrite: false },
        { resource: 'lead', field: 'previousOwner', canRead: false, canWrite: false },
      ],
    );
    expectWarning(out, 'has_hidden_owner_history_fields');
  });

  it('has_super_admin_bypass — only on super_admin role', async () => {
    const target = makeRole({
      id: 'r-sa',
      code: 'super_admin',
      capabilities: ['lead.read'],
    });
    const { svc } = buildSvc(new Map([[target.id, target]]));
    const out = await svc.previewRole(target.id, {
      userId: 'u-sa',
      roleCode: 'super_admin',
    });
    expectWarning(out, 'has_super_admin_bypass');
  });

  it('no warnings on a minimal role', async () => {
    const out = await previewWith(['lead.read']);
    assert.deepEqual([...out.warnings], []);
  });
});

// ════════════════════════════════════════════════════════════════
// E. UI hints
// ════════════════════════════════════════════════════════════════

describe('rbac/D5.10 — uiHints', () => {
  it('exportCapabilities is sorted', async () => {
    const target = makeRole({
      id: 'r-1',
      capabilities: [
        'tenant.export',
        'audit.export',
        'lead.read',
        'lead.export',
        'partner.commission.export',
      ],
    });
    const { svc } = buildSvc(new Map([[target.id, target]]));
    const out = await svc.previewRole(target.id, {
      userId: 'u',
      roleCode: 'super_admin',
    });
    assert.deepEqual(out.uiHints.exportCapabilities, [
      'audit.export',
      'lead.export',
      'partner.commission.export',
      'tenant.export',
    ]);
  });

  it('exportCapabilities ignores non-export caps even with .export-like substrings', async () => {
    const target = makeRole({
      id: 'r-1',
      // Hypothetical cap that contains the letters but doesn't end with .export.
      capabilities: ['lead.read', 'partner.exportable.metric.read'],
    });
    const { svc } = buildSvc(new Map([[target.id, target]]));
    const out = await svc.previewRole(target.id, {
      userId: 'u',
      roleCode: 'super_admin',
    });
    assert.deepEqual(out.uiHints.exportCapabilities, []);
  });
});
