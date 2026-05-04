/**
 * Phase C — C2: tests for the role-builder write surface.
 *
 * Covers:
 *   • System role immutability — every write path rejects with
 *     `role.system_immutable`.
 *   • Custom role CRUD — create, update metadata, replace caps,
 *     delete (with users-assigned guard).
 *   • Duplication — caps + scopes + field permissions all copied,
 *     produces non-system row.
 *   • Scope upserts — diffed audit payload.
 *   • Field-permission replacement.
 *   • Audit emission — every mutation lands a row in audit_events
 *     with the right action code + actor + payload shape.
 *   • Tenant isolation — RLS + service-layer filtering.
 *
 * Each test owns its custom roles + cleans them up in `after` so the
 * suite is re-run-safe against the shared default tenant.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { tenantContext } from '../tenants/tenant-context';

import { RbacService } from './rbac.service';

const DEFAULT_TENANT_CODE = 'trade_way_default';
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let prisma: PrismaClient;
let prismaSvc: PrismaService;
let svc: RbacService;
let tenantId: string;

/** Stable seeded user id we use as the audit actor. */
let actorUserId: string;

/** Codes created by individual tests; tracked so we can clean up. */
const createdCodes = new Set<string>();

function inDefaultTenant<T>(fn: () => Promise<T>): Promise<T> {
  return tenantContext.run({ tenantId, tenantCode: DEFAULT_TENANT_CODE, source: 'header' }, fn);
}

async function cleanupRoles(): Promise<void> {
  if (createdCodes.size === 0) return;
  const codes = Array.from(createdCodes);
  createdCodes.clear();
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.tenant_id = '${tenantId}'`);
    await tx.role.deleteMany({ where: { code: { in: codes }, tenantId } });
  });
}

async function getSeededRoleId(code: string): Promise<string> {
  const r = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.tenant_id = '${tenantId}'`);
    return tx.role.findUnique({
      where: { tenantId_code: { tenantId, code } },
      select: { id: true },
    });
  });
  assert.ok(r, `seeded role ${code} not found`);
  return r.id;
}

async function latestAuditEvent(action: string, entityId?: string) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.tenant_id = '${tenantId}'`);
    return tx.auditEvent.findFirst({
      where: { tenantId, action, ...(entityId && { entityId }) },
      orderBy: { createdAt: 'desc' },
    });
  });
}

before(async () => {
  prisma = new PrismaClient();
  await prisma.$connect();
  const tenant = await prisma.tenant.findUnique({ where: { code: DEFAULT_TENANT_CODE } });
  assert.ok(tenant, `seed precondition: tenant '${DEFAULT_TENANT_CODE}' must exist`);
  assert.ok(UUID_REGEX.test(tenant.id), 'tenant id is a uuid');
  tenantId = tenant.id;

  prismaSvc = new PrismaService();
  svc = new RbacService(prismaSvc, new AuditService(prismaSvc));

  // Pick any seeded user as the audit actor.
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.tenant_id = '${tenantId}'`);
    const u = await tx.user.findFirst({ select: { id: true } });
    assert.ok(u, 'seed precondition: at least one user must exist');
    actorUserId = u.id;
  });
});

after(async () => {
  await cleanupRoles();
  await prisma.$disconnect();
});

// ────────────────────────────────────────────────────────────────────
// System role immutability
// ────────────────────────────────────────────────────────────────────

describe('rbac C2 — system role immutability', () => {
  it('PATCH on a system role rejects with role.system_immutable', async () => {
    const id = await getSeededRoleId('ops_manager');
    await assert.rejects(
      inDefaultTenant(() => svc.updateRole(id, { nameEn: 'hacked' }, actorUserId)),
      (err: { response?: { code?: string } }) => err.response?.code === 'role.system_immutable',
    );
  });

  it('PATCH cannot change level / description / capabilities on a system role', async () => {
    const id = await getSeededRoleId('sales_agent');
    for (const body of [{ level: 5 }, { description: 'hacked' }, { capabilities: ['lead.read'] }]) {
      await assert.rejects(
        inDefaultTenant(() => svc.updateRole(id, body, actorUserId)),
        (err: { response?: { code?: string } }) => err.response?.code === 'role.system_immutable',
      );
    }
  });

  it('DELETE on a system role rejects with role.system_immutable', async () => {
    const id = await getSeededRoleId('viewer');
    await assert.rejects(
      inDefaultTenant(() => svc.deleteRole(id, actorUserId)),
      (err: { response?: { code?: string } }) => err.response?.code === 'role.system_immutable',
    );
  });

  it('PUT scopes on a system role rejects with role.system_immutable', async () => {
    const id = await getSeededRoleId('tl_sales');
    await assert.rejects(
      inDefaultTenant(() =>
        svc.putRoleScopes(id, { scopes: [{ resource: 'lead', scope: 'team' }] }, actorUserId),
      ),
      (err: { response?: { code?: string } }) => err.response?.code === 'role.system_immutable',
    );
  });

  it('PUT field-permissions on a system role rejects with role.system_immutable', async () => {
    const id = await getSeededRoleId('account_manager');
    await assert.rejects(
      inDefaultTenant(() =>
        svc.putRoleFieldPermissions(
          id,
          { permissions: [{ resource: 'lead', field: 'phone', canRead: false, canWrite: false }] },
          actorUserId,
        ),
      ),
      (err: { response?: { code?: string } }) => err.response?.code === 'role.system_immutable',
    );
  });
});

// ────────────────────────────────────────────────────────────────────
// Custom role CRUD
// ────────────────────────────────────────────────────────────────────

describe('rbac C2 — custom role CRUD', () => {
  it('createRole — happy path with capabilities + custom scopes', async () => {
    const code = `c2_custom_${Date.now()}`;
    createdCodes.add(code);
    const created = await inDefaultTenant(() =>
      svc.createRole(
        {
          code,
          nameEn: 'Custom Reader',
          nameAr: 'قارئ مخصّص',
          level: 25,
          description: 'Test role',
          capabilities: ['lead.read', 'pipeline.read'],
          scopes: [{ resource: 'lead', scope: 'own' }],
          fieldPermissions: [{ resource: 'lead', field: 'phone', canRead: false, canWrite: false }],
        },
        actorUserId,
      ),
    );
    assert.equal(created.code, code);
    assert.equal(created.isSystem, false);
    assert.equal(created.level, 25);
    assert.equal(created.description, 'Test role');
    assert.deepEqual(new Set(created.capabilities), new Set(['lead.read', 'pipeline.read']));
    // Caller-supplied scope overrides 'global'; other resources default to 'global'.
    const scopeMap = new Map(created.scopes.map((s) => [s.resource, s.scope]));
    assert.equal(scopeMap.get('lead'), 'own');
    assert.equal(scopeMap.get('captain'), 'global');
    assert.equal(scopeMap.get('followup'), 'global');
    assert.equal(scopeMap.get('whatsapp.conversation'), 'global');
    assert.equal(created.fieldPermissions.length, 1);
    assert.equal(created.fieldPermissions[0]?.field, 'phone');

    const audit = await latestAuditEvent('role.create', created.id);
    assert.ok(audit, 'role.create audit event written');
    assert.equal(audit.actorUserId, actorUserId);
    const payload = audit.payload as { code: string; capabilityCount: number };
    assert.equal(payload.code, code);
    assert.equal(payload.capabilityCount, 2);
  });

  it('createRole — rejects when code collides with a system code', async () => {
    await assert.rejects(
      inDefaultTenant(() =>
        svc.createRole({ code: 'sales_agent', nameEn: 'X', nameAr: 'س', level: 30 }, actorUserId),
      ),
      (err: { response?: { code?: string } }) => err.response?.code === 'role.code_reserved',
    );
  });

  it('createRole — rejects when code is already used in this tenant', async () => {
    const code = `c2_dup_${Date.now()}`;
    createdCodes.add(code);
    await inDefaultTenant(() =>
      svc.createRole({ code, nameEn: 'X', nameAr: 'س', level: 30 }, actorUserId),
    );
    await assert.rejects(
      inDefaultTenant(() =>
        svc.createRole({ code, nameEn: 'X2', nameAr: 'س2', level: 30 }, actorUserId),
      ),
      (err: { response?: { code?: string } }) => err.response?.code === 'role.code_taken',
    );
  });

  it('createRole — rejects unknown capability codes', async () => {
    await assert.rejects(
      inDefaultTenant(() =>
        svc.createRole(
          {
            code: `c2_badcap_${Date.now()}`,
            nameEn: 'X',
            nameAr: 'س',
            level: 30,
            capabilities: ['lead.read', 'totally.fake.cap'],
          },
          actorUserId,
        ),
      ),
      (err: { response?: { code?: string } }) => err.response?.code === 'role.capability_unknown',
    );
  });

  it('updateRole — replaces capabilities with a granted+revoked audit entry', async () => {
    const code = `c2_capupdate_${Date.now()}`;
    createdCodes.add(code);
    const created = await inDefaultTenant(() =>
      svc.createRole(
        {
          code,
          nameEn: 'X',
          nameAr: 'س',
          level: 30,
          capabilities: ['lead.read', 'captain.read'],
        },
        actorUserId,
      ),
    );

    await inDefaultTenant(() =>
      svc.updateRole(created.id, { capabilities: ['lead.read', 'pipeline.read'] }, actorUserId),
    );

    const reloaded = await inDefaultTenant(() => svc.findRoleById(created.id));
    assert.deepEqual(new Set(reloaded?.capabilities), new Set(['lead.read', 'pipeline.read']));

    const audit = await latestAuditEvent('role.capability.update', created.id);
    assert.ok(audit, 'role.capability.update audit emitted');
    const payload = audit.payload as { granted: string[]; revoked: string[]; finalCount: number };
    assert.deepEqual(new Set(payload.granted), new Set(['pipeline.read']));
    assert.deepEqual(new Set(payload.revoked), new Set(['captain.read']));
    assert.equal(payload.finalCount, 2);
  });

  it('updateRole — patches metadata fields only and emits role.update audit', async () => {
    const code = `c2_meta_${Date.now()}`;
    createdCodes.add(code);
    const created = await inDefaultTenant(() =>
      svc.createRole({ code, nameEn: 'X', nameAr: 'س', level: 30 }, actorUserId),
    );

    await inDefaultTenant(() =>
      svc.updateRole(
        created.id,
        { nameEn: 'New name', level: 40, description: 'updated' },
        actorUserId,
      ),
    );

    const reloaded = await inDefaultTenant(() => svc.findRoleById(created.id));
    assert.equal(reloaded?.nameEn, 'New name');
    assert.equal(reloaded?.level, 40);
    assert.equal(reloaded?.description, 'updated');

    const audit = await latestAuditEvent('role.update', created.id);
    assert.ok(audit, 'role.update audit emitted');
    const payload = audit.payload as { nameEn?: string; level?: number };
    assert.equal(payload.nameEn, 'New name');
    assert.equal(payload.level, 40);
  });

  it('deleteRole — removes role + emits role.delete audit', async () => {
    const code = `c2_del_${Date.now()}`;
    const created = await inDefaultTenant(() =>
      svc.createRole({ code, nameEn: 'X', nameAr: 'س', level: 30 }, actorUserId),
    );

    await inDefaultTenant(() => svc.deleteRole(created.id, actorUserId));

    const reloaded = await inDefaultTenant(() => svc.findRoleById(created.id));
    assert.equal(reloaded, null);

    const audit = await latestAuditEvent('role.delete', created.id);
    assert.ok(audit);
    const payload = audit.payload as { code: string };
    assert.equal(payload.code, code);
  });

  it('deleteRole — rejects when users still reference the role', async () => {
    const code = `c2_used_${Date.now()}`;
    createdCodes.add(code);
    const created = await inDefaultTenant(() =>
      svc.createRole({ code, nameEn: 'X', nameAr: 'س', level: 30 }, actorUserId),
    );

    // Reassign the actor to the new role temporarily.
    let prevRoleId: string | null = null;
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL app.tenant_id = '${tenantId}'`);
      const u = await tx.user.findUniqueOrThrow({
        where: { id: actorUserId },
        select: { roleId: true },
      });
      prevRoleId = u.roleId;
      await tx.user.update({ where: { id: actorUserId }, data: { roleId: created.id } });
    });

    try {
      await assert.rejects(
        inDefaultTenant(() => svc.deleteRole(created.id, actorUserId)),
        (err: { response?: { code?: string } }) => err.response?.code === 'role.has_users',
      );
    } finally {
      // Restore the actor's original role so other tests aren't disturbed.
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL app.tenant_id = '${tenantId}'`);
        await tx.user.update({
          where: { id: actorUserId },
          data: { roleId: prevRoleId! },
        });
      });
    }
  });
});

// ────────────────────────────────────────────────────────────────────
// Duplicate
// ────────────────────────────────────────────────────────────────────

describe('rbac C2 — duplicate', () => {
  it('duplicateRole — clones a system role with caps + scopes + field perms; isSystem=false', async () => {
    const sourceId = await getSeededRoleId('sales_agent');
    const code = `c2_clone_sales_${Date.now()}`;
    createdCodes.add(code);
    const cloned = await inDefaultTenant(() =>
      svc.duplicateRole(
        sourceId,
        { code, nameEn: 'Cloned Sales', nameAr: 'مبيعات مستنسخة' },
        actorUserId,
      ),
    );
    assert.equal(cloned.isSystem, false, 'clone is non-system');
    assert.equal(cloned.code, code);

    // sales_agent has 3 deny rows seeded by C1 (lead.id, attribution.campaign,
    // source). They must transfer.
    const fields = new Set(cloned.fieldPermissions.map((p) => `${p.resource}::${p.field}`));
    assert.ok(fields.has('lead::id'));
    assert.ok(fields.has('lead::attribution.campaign'));
    assert.ok(fields.has('lead::source'));

    // Capabilities + scopes count must match the source.
    const source = await inDefaultTenant(() => svc.findRoleById(sourceId));
    assert.equal(cloned.capabilities.length, source!.capabilities.length);
    assert.equal(cloned.scopes.length, source!.scopes.length);

    const audit = await latestAuditEvent('role.duplicate', cloned.id);
    assert.ok(audit, 'role.duplicate audit emitted');
    const payload = audit.payload as { sourceRoleId: string; sourceCode: string };
    assert.equal(payload.sourceRoleId, sourceId);
    assert.equal(payload.sourceCode, 'sales_agent');
  });

  it('duplicateRole — rejects new code that collides with a system code', async () => {
    const sourceId = await getSeededRoleId('viewer');
    await assert.rejects(
      inDefaultTenant(() =>
        svc.duplicateRole(sourceId, { code: 'sales_agent', nameEn: 'X', nameAr: 'س' }, actorUserId),
      ),
      (err: { response?: { code?: string } }) => err.response?.code === 'role.code_reserved',
    );
  });
});

// ────────────────────────────────────────────────────────────────────
// Scopes
// ────────────────────────────────────────────────────────────────────

describe('rbac C2 — scope updates', () => {
  it('putRoleScopes — upserts the scope rows + emits a diff audit', async () => {
    const code = `c2_scopes_${Date.now()}`;
    createdCodes.add(code);
    const created = await inDefaultTenant(() =>
      svc.createRole({ code, nameEn: 'X', nameAr: 'س', level: 30 }, actorUserId),
    );

    const result = await inDefaultTenant(() =>
      svc.putRoleScopes(
        created.id,
        {
          scopes: [
            { resource: 'lead', scope: 'team' },
            { resource: 'captain', scope: 'company' },
          ],
        },
        actorUserId,
      ),
    );
    const m = new Map(result.map((r) => [r.resource, r.scope]));
    assert.equal(m.get('lead'), 'team');
    assert.equal(m.get('captain'), 'company');
    // Resources NOT in the body keep their existing rows ('global' from create).
    assert.equal(m.get('followup'), 'global');
    assert.equal(m.get('whatsapp.conversation'), 'global');

    const audit = await latestAuditEvent('role.scope.update', created.id);
    assert.ok(audit, 'role.scope.update audit emitted');
    const payload = audit.payload as {
      changes: Array<{ resource: string; from: string | null; to: string }>;
    };
    const byResource = new Map(payload.changes.map((c) => [c.resource, c]));
    assert.equal(byResource.get('lead')?.from, 'global');
    assert.equal(byResource.get('lead')?.to, 'team');
    assert.equal(byResource.get('captain')?.to, 'company');
  });
});

// ────────────────────────────────────────────────────────────────────
// Field permissions
// ────────────────────────────────────────────────────────────────────

describe('rbac C2 — field permission updates', () => {
  it('putRoleFieldPermissions — replaces the set + emits a before/after audit', async () => {
    const code = `c2_fields_${Date.now()}`;
    createdCodes.add(code);
    const created = await inDefaultTenant(() =>
      svc.createRole(
        {
          code,
          nameEn: 'X',
          nameAr: 'س',
          level: 30,
          fieldPermissions: [{ resource: 'lead', field: 'phone', canRead: false, canWrite: false }],
        },
        actorUserId,
      ),
    );

    const result = await inDefaultTenant(() =>
      svc.putRoleFieldPermissions(
        created.id,
        {
          permissions: [
            { resource: 'lead', field: 'email', canRead: true, canWrite: false },
            { resource: 'lead', field: 'attribution.campaign', canRead: false, canWrite: false },
          ],
        },
        actorUserId,
      ),
    );
    assert.equal(result.length, 2);

    const reloaded = await inDefaultTenant(() => svc.findRoleById(created.id));
    const finalSet = new Set(reloaded?.fieldPermissions.map((p) => `${p.resource}::${p.field}`));
    assert.ok(!finalSet.has('lead::phone'), 'phone deny dropped');
    assert.ok(finalSet.has('lead::email'));
    assert.ok(finalSet.has('lead::attribution.campaign'));

    const audit = await latestAuditEvent('role.field.update', created.id);
    assert.ok(audit, 'role.field.update audit emitted');
    const payload = audit.payload as {
      beforeCount: number;
      afterCount: number;
    };
    assert.equal(payload.beforeCount, 1);
    assert.equal(payload.afterCount, 2);
  });
});
