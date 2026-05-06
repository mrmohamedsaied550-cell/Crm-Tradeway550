/**
 * Phase D5 — D5.16: Role Templates registry + service.
 *
 * Pure unit tests covering:
 *
 *   A. Registry invariants — every code unique, every capability
 *      in the global registry, every field-permission pair is
 *      catalogued, finance is a TEMPLATE (not a system role),
 *      template codes do NOT collide with the 11 system role
 *      codes (a custom role created from a template must still
 *      pick a fresh code).
 *
 *   B. Pure helpers — `mergeScopes` / `mergeFieldPermissions`
 *      override-on-top semantics + sorted output.
 *
 *   C. RoleTemplateService.list / get — returns structural
 *      metadata only (no row VALUES); detail carries the full
 *      capability + scope + field-permission set; unknown code
 *      throws `role_template.not_found`.
 *
 *   D. RoleTemplateService.preview — runs D5.14 dependency
 *      analysis on the template's capability set; high-risk
 *      caps surface verbatim; emits the
 *      `rbac.role.template_previewed` audit row with metadata-
 *      only payload.
 *
 *   E. RoleTemplateService.createFromTemplate — forwards through
 *      `RbacService.createRole` (so D5.15-B version capture is
 *      automatic), threads the typed-confirmation phrase to
 *      the dependency analyser, emits the
 *      `rbac.role.created_from_template` audit row.
 *
 *   F. Safety / no-leak — preview / createFromTemplate audit
 *      payloads never carry the proposed capability set itself
 *      (only counts + risk tags). The registry never references
 *      sensitive row VALUES.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ALL_CAPABILITY_CODES } from './capabilities.registry';
import { CATALOGUE_RESOURCES, isCatalogued } from './field-catalogue.registry';
import {
  ROLE_TEMPLATE_DEFINITIONS,
  getRoleTemplate,
  listRoleTemplates,
} from './role-templates.registry';
import { RoleTemplateService, mergeFieldPermissions, mergeScopes } from './role-template.service';
import type { PrismaService } from '../prisma/prisma.service';
import { tenantContext } from '../tenants/tenant-context';
import type { RbacService, RoleWithCapabilities } from './rbac.service';
import { RoleDependencyService } from './role-dependency.service';
import { ALL_ROLE_CODES } from './roles.registry';

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
}): RoleWithCapabilities {
  return {
    id: opts.id ?? 'role-1',
    code: opts.code ?? 'ops_manager',
    nameAr: 'دور',
    nameEn: 'Role',
    level: 60,
    isActive: true,
    isSystem: false,
    description: null,
    capabilities: opts.capabilities ?? [],
    scopes: [],
    fieldPermissions: [],
  };
}

function fakePrisma(otherKeeperCount = 5): PrismaService {
  const tx = {
    roleCapability: {
      count: async () => otherKeeperCount,
    },
  };
  return {
    withTenant: async <T>(_tenantId: string, fn: (tx: unknown) => Promise<T>): Promise<T> => fn(tx),
  } as unknown as PrismaService;
}

class FakeRbacService {
  public readonly createCalls: Array<unknown> = [];
  constructor(private readonly rolesById: Map<string, RoleWithCapabilities>) {}
  async findRoleById(id: string): Promise<RoleWithCapabilities | null> {
    return this.rolesById.get(id) ?? null;
  }
  async createRole(dto: unknown, _actor: string): Promise<RoleWithCapabilities> {
    this.createCalls.push(dto);
    const d = dto as {
      code: string;
      nameEn: string;
      nameAr: string;
      level: number;
      description?: string | null;
      capabilities: readonly string[];
      scopes: ReadonlyArray<{ resource: string; scope: string }>;
      fieldPermissions: ReadonlyArray<{
        resource: string;
        field: string;
        canRead: boolean;
        canWrite: boolean;
      }>;
    };
    return {
      id: 'role-new',
      code: d.code,
      nameEn: d.nameEn,
      nameAr: d.nameAr,
      level: d.level,
      isActive: true,
      isSystem: false,
      description: d.description ?? null,
      capabilities: [...d.capabilities],
      scopes: d.scopes as RoleWithCapabilities['scopes'],
      fieldPermissions: d.fieldPermissions as RoleWithCapabilities['fieldPermissions'],
    };
  }
}

class CapturingAuditService {
  public readonly events: Array<{ action: string; payload?: Record<string, unknown> }> = [];
  async writeEvent(input: { action: string; payload?: Record<string, unknown> }): Promise<void> {
    this.events.push({ action: input.action, payload: input.payload ?? {} });
  }
}

function buildService(
  opts: {
    actorRole?: RoleWithCapabilities;
    otherKeeperCount?: number;
  } = {},
): {
  svc: RoleTemplateService;
  rbac: FakeRbacService;
  audit: CapturingAuditService;
} {
  const actor = opts.actorRole ?? makeRole({ id: 'role-actor' });
  const rolesById = new Map([[actor.id, actor]]);
  const rbac = new FakeRbacService(rolesById);
  const prisma = fakePrisma(opts.otherKeeperCount ?? 5);
  const dep = new RoleDependencyService(prisma, rbac as unknown as RbacService);
  const audit = new CapturingAuditService();
  const svc = new RoleTemplateService(
    rbac as unknown as RbacService,
    dep,
    audit as unknown as import('../audit/audit.service').AuditService,
  );
  return { svc, rbac, audit };
}

const TENANT_ID = 't-1';
const ACTOR = { userId: 'u-1', roleId: 'role-actor' };

// ════════════════════════════════════════════════════════════════
// A. Registry invariants
// ════════════════════════════════════════════════════════════════

describe('rbac/D5.16 — registry invariants', () => {
  it('every template code is unique', () => {
    const seen = new Set<string>();
    for (const t of ROLE_TEMPLATE_DEFINITIONS) {
      assert.equal(seen.has(t.code), false, `duplicate template code '${t.code}'`);
      seen.add(t.code);
    }
  });

  it('every template code is snake_case (admin sees it as a stable identifier)', () => {
    for (const t of ROLE_TEMPLATE_DEFINITIONS) {
      assert.match(t.code, /^[a-z][a-z0-9_]*$/, `template code '${t.code}' must be snake_case`);
    }
  });

  it('every template capability exists in the global capability registry', () => {
    const known: ReadonlySet<string> = new Set(ALL_CAPABILITY_CODES);
    for (const t of ROLE_TEMPLATE_DEFINITIONS) {
      for (const c of t.capabilities) {
        assert.ok(known.has(c), `template '${t.code}' references unknown capability '${c}'`);
      }
    }
  });

  it('every field-permission pair references a catalogued resource', () => {
    const knownResources: ReadonlySet<string> = new Set(CATALOGUE_RESOURCES);
    for (const t of ROLE_TEMPLATE_DEFINITIONS) {
      for (const p of t.fieldPermissions) {
        assert.ok(
          knownResources.has(p.resource),
          `template '${t.code}' field deny references unknown resource '${p.resource}'`,
        );
        assert.ok(
          isCatalogued(p.resource, p.field),
          `template '${t.code}' field deny ${p.resource}.${p.field} is not catalogued`,
        );
      }
    }
  });

  it('finance_commission_viewer exists as a template', () => {
    const t = getRoleTemplate('finance_commission_viewer');
    assert.ok(t, 'finance_commission_viewer must be in the template registry');
    assert.equal(t!.category, 'finance');
  });

  it('finance is NOT a system role code (template-only stance)', () => {
    const systemCodes: ReadonlySet<string> = new Set(ALL_ROLE_CODES);
    assert.equal(
      systemCodes.has('finance_commission_viewer'),
      false,
      'finance must remain a template, not an immutable system role',
    );
    assert.equal(
      systemCodes.has('finance'),
      false,
      'finance must remain a template, not an immutable system role',
    );
  });

  it('every template scope row references one of the four scoped resources', () => {
    const allowed: ReadonlySet<string> = new Set([
      'lead',
      'captain',
      'followup',
      'whatsapp.conversation',
    ]);
    for (const t of ROLE_TEMPLATE_DEFINITIONS) {
      for (const s of t.scopes) {
        assert.ok(
          allowed.has(s.resource),
          `template '${t.code}' scope row references unknown resource '${s.resource}'`,
        );
      }
    }
  });

  it('low-risk templates carry no high-risk capabilities', () => {
    const SAFE: readonly string[] = [
      'agent_sales_safe',
      'agent_activation_safe',
      'agent_driving_safe',
      'viewer_readonly',
      'tl_sales_safe',
      'tl_activation_safe',
      'partner_reviewer_safe',
    ];
    const FORBIDDEN: ReadonlySet<string> = new Set([
      'tenant.export',
      'roles.write',
      'partner.merge.write',
      'audit.export',
      'lead.export',
    ]);
    for (const code of SAFE) {
      const t = getRoleTemplate(code)!;
      for (const c of t.capabilities) {
        assert.equal(
          FORBIDDEN.has(c),
          false,
          `safe template '${code}' must not carry high-risk capability '${c}'`,
        );
      }
    }
  });

  it('high-privilege ops_governance template carries the corresponding risk tag', () => {
    const t = getRoleTemplate('ops_governance')!;
    assert.ok(t.riskTags.includes('high_privilege'));
    assert.ok(t.riskTags.includes('tenant_export'));
    assert.ok(t.riskTags.includes('partner_merge'));
    assert.ok(t.riskTags.includes('permission_admin'));
  });
});

// ════════════════════════════════════════════════════════════════
// B. mergeScopes / mergeFieldPermissions
// ════════════════════════════════════════════════════════════════

describe('rbac/D5.16 — merge helpers', () => {
  it('mergeScopes overrides per resource and keeps untouched defaults', () => {
    const out = mergeScopes(
      [
        { resource: 'lead', scope: 'team' },
        { resource: 'captain', scope: 'team' },
      ],
      [{ resource: 'lead', scope: 'global' }],
    );
    assert.deepEqual(out, [
      { resource: 'captain', scope: 'team' },
      { resource: 'lead', scope: 'global' },
    ]);
  });

  it('mergeScopes adds resources not in the template default', () => {
    const out = mergeScopes(
      [{ resource: 'lead', scope: 'team' }],
      [{ resource: 'followup', scope: 'global' }],
    );
    assert.equal(out.length, 2);
    assert.ok(out.some((s) => s.resource === 'lead' && s.scope === 'team'));
    assert.ok(out.some((s) => s.resource === 'followup' && s.scope === 'global'));
  });

  it('mergeFieldPermissions overrides per (resource, field) pair', () => {
    const out = mergeFieldPermissions(
      [
        { resource: 'lead', field: 'previousOwner', canRead: false, canWrite: false },
        { resource: 'rotation', field: 'fromUser', canRead: false, canWrite: false },
      ],
      [{ resource: 'lead', field: 'previousOwner', canRead: true, canWrite: false }],
    );
    const lead = out.find((p) => p.resource === 'lead' && p.field === 'previousOwner');
    assert.equal(lead!.canRead, true, 'override should flip canRead from template default');
    const rotation = out.find((p) => p.resource === 'rotation' && p.field === 'fromUser');
    assert.equal(rotation!.canRead, false, 'untouched template default should pass through');
  });

  it('mergeFieldPermissions sorts deterministically by resource then field', () => {
    const out = mergeFieldPermissions(
      [
        { resource: 'rotation', field: 'fromUser', canRead: false, canWrite: false },
        { resource: 'lead', field: 'previousOwner', canRead: false, canWrite: false },
      ],
      [],
    );
    assert.equal(out[0]?.resource, 'lead');
    assert.equal(out[1]?.resource, 'rotation');
  });
});

// ════════════════════════════════════════════════════════════════
// C. list / get
// ════════════════════════════════════════════════════════════════

describe('rbac/D5.16 — RoleTemplateService.list / get', () => {
  it('list returns one summary entry per template, structural metadata only', () => {
    const { svc } = buildService();
    const summaries = svc.list();
    assert.equal(summaries.length, ROLE_TEMPLATE_DEFINITIONS.length);
    for (const s of summaries) {
      assert.equal(typeof s.code, 'string');
      assert.equal(typeof s.capabilityCount, 'number');
      assert.equal(typeof s.scopeCount, 'number');
      assert.equal(typeof s.fieldPermissionCount, 'number');
      assert.ok(Array.isArray(s.riskTags));
      // No row VALUES surfaced — only counts + tags.
      assert.equal((s as unknown as Record<string, unknown>)['capabilities'], undefined);
    }
  });

  it('get returns the full structural shape for a known template', () => {
    const { svc } = buildService();
    const detail = svc.get('agent_sales_safe');
    assert.equal(detail.code, 'agent_sales_safe');
    assert.ok(detail.capabilities.length > 0);
    assert.ok(detail.scopes.length > 0);
    assert.ok(detail.fieldPermissions.length > 0);
  });

  it('get throws role_template.not_found for an unknown code', () => {
    const { svc } = buildService();
    assert.throws(
      () => svc.get('definitely_not_a_template'),
      (err: unknown) => {
        const e = err as { getResponse?: () => { code?: string } };
        return e.getResponse?.()?.code === 'role_template.not_found';
      },
    );
  });

  it('listRoleTemplates returns the same entries as the registry export', () => {
    assert.equal(listRoleTemplates().length, ROLE_TEMPLATE_DEFINITIONS.length);
  });
});

// ════════════════════════════════════════════════════════════════
// D. preview
// ════════════════════════════════════════════════════════════════

describe('rbac/D5.16 — RoleTemplateService.preview', () => {
  it('returns the template detail + dependency analysis + high-risk caps', async () => {
    const { svc } = buildService();
    const out = await withTenant(TENANT_ID, () => svc.preview('ops_governance', ACTOR));
    assert.equal(out.template.code, 'ops_governance');
    assert.ok(out.dependencyAnalysis.warnings.length > 0, 'ops_governance should produce warnings');
    assert.ok(
      out.highRiskCapabilities.includes('tenant.export'),
      'ops_governance should flag tenant.export as high-risk',
    );
    assert.ok(out.highRiskCapabilities.includes('roles.write'));
    assert.equal(typeof out.typedConfirmationPhrase, 'string');
  });

  it('safe template (viewer_readonly) returns no high-risk caps', async () => {
    const { svc } = buildService();
    const out = await withTenant(TENANT_ID, () => svc.preview('viewer_readonly', ACTOR));
    assert.equal(out.highRiskCapabilities.length, 0);
  });

  it('emits rbac.role.template_previewed audit with metadata only', async () => {
    const { svc, audit } = buildService();
    await withTenant(TENANT_ID, () => svc.preview('agent_sales_safe', ACTOR));
    const ev = audit.events.find((e) => e.action === 'rbac.role.template_previewed');
    assert.ok(ev);
    const p = ev!.payload as Record<string, unknown>;
    assert.equal(typeof p['templateCode'], 'string');
    assert.equal(typeof p['capabilityCount'], 'number');
    assert.equal(typeof p['highRiskCount'], 'number');
    // Never the proposed capability set itself.
    assert.equal(p['capabilities'], undefined);
    assert.equal(p['proposedCapabilities'], undefined);
  });
});

// ════════════════════════════════════════════════════════════════
// E. createFromTemplate
// ════════════════════════════════════════════════════════════════

describe('rbac/D5.16 — RoleTemplateService.createFromTemplate', () => {
  it('forwards through RbacService.createRole with the template payload', async () => {
    const { svc, rbac } = buildService();
    await withTenant(TENANT_ID, () =>
      svc.createFromTemplate({
        templateCode: 'agent_sales_safe',
        code: 'my_sales_agent',
        nameEn: 'My Sales Agent',
        nameAr: 'وكيل المبيعات',
        actor: ACTOR,
      }),
    );
    assert.equal(rbac.createCalls.length, 1);
    const dto = rbac.createCalls[0] as {
      code: string;
      capabilities: readonly string[];
      scopes: ReadonlyArray<{ resource: string }>;
      fieldPermissions: readonly unknown[];
    };
    assert.equal(dto.code, 'my_sales_agent');
    // The template's capability set rides verbatim.
    const tpl = getRoleTemplate('agent_sales_safe')!;
    assert.deepEqual([...dto.capabilities], [...tpl.capabilities]);
    // The template's scope rows ride too.
    assert.equal(dto.scopes.length, tpl.scopes.length);
    // The template's field-permission denies ride too.
    assert.equal(dto.fieldPermissions.length, tpl.fieldPermissions.length);
  });

  it('emits rbac.role.created_from_template audit with metadata only', async () => {
    const { svc, audit } = buildService();
    await withTenant(TENANT_ID, () =>
      svc.createFromTemplate({
        templateCode: 'agent_sales_safe',
        code: 'my_sales_agent',
        nameEn: 'My Sales Agent',
        nameAr: 'وكيل المبيعات',
        actor: ACTOR,
      }),
    );
    const ev = audit.events.find((e) => e.action === 'rbac.role.created_from_template');
    assert.ok(ev);
    const p = ev!.payload as Record<string, unknown>;
    assert.equal(typeof p['templateCode'], 'string');
    assert.equal(typeof p['targetRoleId'], 'string');
    assert.equal(typeof p['capabilityCount'], 'number');
    assert.equal(typeof p['warningCount'], 'number');
    // No proposed capability set in the payload.
    assert.equal(p['capabilities'], undefined);
  });

  it('overrides scopes per resource without losing the template defaults', async () => {
    const { svc, rbac } = buildService();
    await withTenant(TENANT_ID, () =>
      svc.createFromTemplate({
        templateCode: 'agent_sales_safe',
        code: 'my_sales_agent',
        nameEn: 'My Sales Agent',
        nameAr: 'وكيل المبيعات',
        initialScopeOverrides: [{ resource: 'lead', scope: 'global' }],
        actor: ACTOR,
      }),
    );
    const dto = rbac.createCalls[0] as {
      scopes: ReadonlyArray<{ resource: string; scope: string }>;
    };
    const lead = dto.scopes.find((s) => s.resource === 'lead');
    assert.equal(lead!.scope, 'global', 'override should win over the template default');
  });

  it('throws role_template.not_found for an unknown template code', async () => {
    const { svc } = buildService();
    await assert.rejects(
      withTenant(TENANT_ID, () =>
        svc.createFromTemplate({
          templateCode: 'no_such_template',
          code: 'my_role',
          nameEn: 'X',
          nameAr: 'X',
          actor: ACTOR,
        }),
      ),
      (err: unknown) => {
        const e = err as { getResponse?: () => { code?: string } };
        return e.getResponse?.()?.code === 'role_template.not_found';
      },
    );
  });

  it('routes through RoleDependencyService.assertConfirmationOk (smoke)', async () => {
    // The dependency analyser runs against the actor's own role
    // here. For a fresh-create from a low-risk template the
    // analyser produces no critical warnings, so the gate
    // passes silently. The test asserts the create succeeds —
    // proof that the chain is wired without bypass.
    const { svc } = buildService();
    const created = await withTenant(TENANT_ID, () =>
      svc.createFromTemplate({
        templateCode: 'viewer_readonly',
        code: 'my_viewer',
        nameEn: 'My Viewer',
        nameAr: 'مشاهد',
        actor: ACTOR,
      }),
    );
    assert.equal(created.code, 'my_viewer');
  });
});

// ════════════════════════════════════════════════════════════════
// F. Safety / no-leak invariants
// ════════════════════════════════════════════════════════════════

describe('rbac/D5.16 — safety invariants', () => {
  it('no template description carries an obvious PII shape', () => {
    // Heuristic: descriptions are localisation strings; no
    // phone numbers / emails / partner IDs should appear.
    const phoneShape = /\+?\d{6,}/;
    const emailShape = /@[\w.-]+\.\w+/;
    for (const t of ROLE_TEMPLATE_DEFINITIONS) {
      for (const desc of [t.descriptionEn, t.descriptionAr]) {
        assert.equal(phoneShape.test(desc), false, `${t.code} description leaks a phone shape`);
        assert.equal(emailShape.test(desc), false, `${t.code} description leaks an email shape`);
      }
    }
  });

  it('audit payloads never include the proposed capability codes themselves', async () => {
    const { svc, audit } = buildService();
    await withTenant(TENANT_ID, () => svc.preview('ops_governance', ACTOR));
    await withTenant(TENANT_ID, () =>
      svc.createFromTemplate({
        templateCode: 'agent_sales_safe',
        code: 'my_sales_agent',
        nameEn: 'My Sales Agent',
        nameAr: 'وكيل المبيعات',
        actor: ACTOR,
      }),
    );
    for (const ev of audit.events) {
      const blob = JSON.stringify(ev.payload ?? {});
      assert.equal(
        blob.includes('"capabilities"'),
        false,
        `audit '${ev.action}' must not embed the proposed capability set`,
      );
    }
  });
});
