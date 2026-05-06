import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { requireTenantId } from '../tenants/tenant-context';

import type { RoleWithCapabilities } from './rbac.service';
// HOTFIX — import the pure helpers file directly (NOT
// `role-change-preview.service.ts`). The service file transitively
// pulls in `RoleDependencyService` → `RbacService`, which closes
// a CJS module-load cycle and crashes Nest DI at boot with
//   "Nest can't resolve dependencies of the RoleDependencyService
//   (PrismaService, ?, AuditService)".
// The helpers file has zero class imports and is safe to load
// from anywhere.
import { computeRiskSummary, type RoleRiskSummary } from './role-change-preview.helpers';

/**
 * Phase D5 — D5.15-B: role version history.
 *
 * Append-only governance surface. The runtime resolver does NOT
 * read this table; it exists to answer:
 *
 *   • "What did this role look like before?"
 *   • "Who changed it?"
 *   • "When did it change?"
 *   • "What changed?"
 *   • "Can we safely revert?"
 *
 * `recordVersion` is called by every RbacService write path
 * INSIDE the same transaction as the role write so the snapshot
 * + the role state can never disagree. The service skips no-op
 * writes (zero capability / scope / field-perm changes vs the
 * latest version) to keep the history compact.
 *
 * `revert` re-uses the D5.14 dependency-check + D5.15-A
 * change-preview chain — every revert is just a normal capability
 * write that happens to use a snapshot's capabilities as the
 * proposed set. Critical lockout warnings still require the typed-
 * confirmation phrase; system-role attempts still throw
 * `role.system_immutable` from the underlying RbacService.
 */

export type RoleVersionTriggerAction =
  | 'create'
  | 'update'
  | 'duplicate'
  | 'scopes'
  | 'field_permissions'
  | 'revert';

/**
 * Snapshot shape stored in the `snapshot` JSONB column. Structural
 * identifiers only — capability codes, resource + field strings,
 * scope strings, role metadata. NEVER row VALUES.
 */
export interface RoleVersionSnapshot {
  metadata: {
    code: string;
    nameEn: string;
    nameAr: string;
    level: number;
    description: string | null;
    isSystem: boolean;
    isActive: boolean;
  };
  capabilities: readonly string[];
  scopes: ReadonlyArray<{ resource: string; scope: string }>;
  fieldPermissions: ReadonlyArray<{
    resource: string;
    field: string;
    canRead: boolean;
    canWrite: boolean;
  }>;
}

/**
 * Diff stored in the `change_summary` JSONB column. Mirrors the
 * D5.15-A `RoleChangePreviewResult.changes` + `riskSummary` so the
 * History tab renders the diff without recomputation.
 */
export interface RoleVersionChangeSummary {
  grantedCapabilities: readonly string[];
  revokedCapabilities: readonly string[];
  fieldPermissionChanges: {
    readDeniedAdded: ReadonlyArray<{ resource: string; field: string }>;
    readDeniedRemoved: ReadonlyArray<{ resource: string; field: string }>;
    writeDeniedAdded: ReadonlyArray<{ resource: string; field: string }>;
    writeDeniedRemoved: ReadonlyArray<{ resource: string; field: string }>;
  };
  scopeChanges: {
    changed: ReadonlyArray<{ resource: string; from: string; to: string }>;
    added: ReadonlyArray<{ resource: string; scope: string }>;
    removed: ReadonlyArray<{ resource: string; scope: string }>;
  };
  riskFlags: RoleRiskSummary;
}

export interface RoleVersionListItem {
  readonly id: string;
  readonly versionNumber: number;
  readonly triggerAction: RoleVersionTriggerAction;
  readonly actor: {
    readonly userId: string | null;
    readonly name: string | null;
    readonly email: string | null;
  };
  readonly reason: string | null;
  readonly createdAt: string;
  readonly changeSummary: RoleVersionChangeSummary;
  readonly counts: {
    readonly grantedCapabilities: number;
    readonly revokedCapabilities: number;
    readonly fieldPermissionChanges: number;
    readonly scopeChanges: number;
  };
}

export interface RoleVersionDetail extends RoleVersionListItem {
  readonly snapshot: RoleVersionSnapshot;
}

export interface RoleVersionListResult {
  readonly items: readonly RoleVersionListItem[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

@Injectable()
export class RoleVersionService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly audit?: AuditService,
  ) {}

  /**
   * Append a version row inside an existing transaction. Called by
   * RbacService write paths after the role state has been updated.
   * Returns `null` when the proposed snapshot is identical to the
   * latest version (no-op skip — keeps the history compact).
   *
   * The diff is computed against the previous snapshot when one
   * exists; the first version after `create` is diffed against an
   * empty baseline so the History row reads "granted: <every cap
   * the role started with>".
   */
  async recordVersion(
    tx: Prisma.TransactionClient,
    tenantId: string,
    input: {
      readonly role: RoleWithCapabilities;
      readonly triggerAction: RoleVersionTriggerAction;
      readonly actorUserId: string | null;
      readonly reason?: string | null;
      /**
       * Set when the version is the result of a revert. Carries the
       * source version's id + number so the audit row can correlate
       * the revert to the snapshot it restored from.
       */
      readonly revertedFromVersionId?: string | null;
      readonly revertedFromVersionNumber?: number | null;
    },
  ): Promise<{ id: string; versionNumber: number } | null> {
    const snapshot = buildSnapshot(input.role);

    // Find the latest version for this role. Inside the same tx so
    // a concurrent write on the same role can't slip in between
    // the read and the insert (the (role_id, version_number)
    // unique constraint is the second line of defence).
    const latest = await tx.roleVersion.findFirst({
      where: { roleId: input.role.id },
      orderBy: { versionNumber: 'desc' },
      select: { id: true, versionNumber: true, snapshot: true },
    });

    const previousSnapshot = (latest?.snapshot ?? null) as RoleVersionSnapshot | null;

    // No-op skip — `update` / `scopes` / `field_permissions` paths
    // sometimes save without an effective change (e.g. an admin
    // re-saves the same capability set). Don't add a row in those
    // cases; revert / create / duplicate ALWAYS add a row even
    // when their snapshot happens to equal the previous (those
    // verbs carry a deliberate "this happened" audit value).
    if (
      previousSnapshot !== null &&
      input.triggerAction !== 'create' &&
      input.triggerAction !== 'duplicate' &&
      input.triggerAction !== 'revert' &&
      snapshotsEqual(previousSnapshot, snapshot)
    ) {
      return null;
    }

    // The diff is computed against the previous snapshot. We can't
    // call `changePreview.preview()` here because that compares
    // against the role's CURRENT state — which is now the new
    // state (the role write has already landed). Risk flags ride
    // through the shared `computeRiskSummary` helper so the History
    // tab and the Review-changes modal use the same vocabulary.
    const summary = computeChangeSummary(previousSnapshot, snapshot);

    const versionNumber = (latest?.versionNumber ?? 0) + 1;
    const created = await tx.roleVersion.create({
      data: {
        tenantId,
        roleId: input.role.id,
        versionNumber,
        actorUserId: input.actorUserId,
        reason: input.reason ?? null,
        triggerAction: input.triggerAction,
        snapshot: snapshot as unknown as Prisma.InputJsonValue,
        changeSummary: summary as unknown as Prisma.InputJsonValue,
      },
      select: { id: true, versionNumber: true },
    });

    // Best-effort audit emit. The role's existing `role.update` /
    // `role.capability.update` rows already cover the action; this
    // verb is a structured "version snapshot was written" handle
    // for the History tab + the audit governance feed.
    if (this.audit) {
      try {
        await this.audit.writeInTx(tx, tenantId, {
          action: 'rbac.role.version_created',
          entityType: 'role',
          entityId: input.role.id,
          actorUserId: input.actorUserId,
          payload: {
            targetRoleId: input.role.id,
            targetRoleCode: input.role.code,
            versionId: created.id,
            versionNumber: created.versionNumber,
            triggerAction: input.triggerAction,
            grantedCount: summary.grantedCapabilities.length,
            revokedCount: summary.revokedCapabilities.length,
            fieldChangeCount: countFieldChanges(summary.fieldPermissionChanges),
            scopeChangeCount: countScopeChanges(summary.scopeChanges),
            riskFlags: summary.riskFlags as unknown as Record<string, boolean>,
            ...(input.revertedFromVersionId !== undefined && input.revertedFromVersionId !== null
              ? { revertedFromVersionId: input.revertedFromVersionId }
              : {}),
            ...(input.revertedFromVersionNumber !== undefined &&
            input.revertedFromVersionNumber !== null
              ? { revertedFromVersionNumber: input.revertedFromVersionNumber }
              : {}),
          },
        });
      } catch {
        // Audit is best-effort. Never block the role write.
      }
    }

    return created;
  }

  /**
   * List versions for a role in the active tenant. Returns latest
   * first; pagination via `limit` (default 25, max 100) + `offset`.
   *
   * The list shape carries structural metadata only — `snapshot`
   * is omitted (use the detail endpoint to fetch it).
   */
  async listVersions(input: {
    readonly roleId: string;
    readonly limit?: number;
    readonly offset?: number;
  }): Promise<RoleVersionListResult> {
    const tenantId = requireTenantId();
    const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);
    const offset = Math.max(input.offset ?? 0, 0);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const [rows, total] = await Promise.all([
        tx.roleVersion.findMany({
          where: { roleId: input.roleId },
          orderBy: { createdAt: 'desc' },
          take: limit,
          skip: offset,
          select: {
            id: true,
            versionNumber: true,
            triggerAction: true,
            actorUserId: true,
            actor: { select: { id: true, name: true, email: true } },
            reason: true,
            createdAt: true,
            changeSummary: true,
          },
        }),
        tx.roleVersion.count({ where: { roleId: input.roleId } }),
      ]);
      const items: RoleVersionListItem[] = rows.map((r) => {
        const summary = r.changeSummary as unknown as RoleVersionChangeSummary;
        return {
          id: r.id,
          versionNumber: r.versionNumber,
          triggerAction: r.triggerAction as RoleVersionTriggerAction,
          actor: {
            userId: r.actorUserId,
            name: r.actor?.name ?? null,
            email: r.actor?.email ?? null,
          },
          reason: r.reason,
          createdAt: r.createdAt.toISOString(),
          changeSummary: summary,
          counts: {
            grantedCapabilities: summary.grantedCapabilities.length,
            revokedCapabilities: summary.revokedCapabilities.length,
            fieldPermissionChanges: countFieldChanges(summary.fieldPermissionChanges),
            scopeChanges: countScopeChanges(summary.scopeChanges),
          },
        };
      });
      return { items, total, limit, offset };
    });
  }

  /**
   * Detail-endpoint read. Returns the FULL snapshot + change
   * summary. Throws `role_version.not_found` when the row is not
   * in the active tenant or does not exist.
   */
  async getVersion(input: {
    readonly roleId: string;
    readonly versionId: string;
  }): Promise<RoleVersionDetail> {
    const tenantId = requireTenantId();
    return this.prisma.withTenant(tenantId, async (tx) => {
      const row = await tx.roleVersion.findFirst({
        where: { id: input.versionId, roleId: input.roleId },
        select: {
          id: true,
          versionNumber: true,
          triggerAction: true,
          actorUserId: true,
          actor: { select: { id: true, name: true, email: true } },
          reason: true,
          createdAt: true,
          changeSummary: true,
          snapshot: true,
        },
      });
      if (!row) {
        throw new NotFoundException({
          code: 'role_version.not_found',
          message: `Version ${input.versionId} not found for role ${input.roleId}`,
        });
      }
      const summary = row.changeSummary as unknown as RoleVersionChangeSummary;
      return {
        id: row.id,
        versionNumber: row.versionNumber,
        triggerAction: row.triggerAction as RoleVersionTriggerAction,
        actor: {
          userId: row.actorUserId,
          name: row.actor?.name ?? null,
          email: row.actor?.email ?? null,
        },
        reason: row.reason,
        createdAt: row.createdAt.toISOString(),
        changeSummary: summary,
        snapshot: row.snapshot as unknown as RoleVersionSnapshot,
        counts: {
          grantedCapabilities: summary.grantedCapabilities.length,
          revokedCapabilities: summary.revokedCapabilities.length,
          fieldPermissionChanges: countFieldChanges(summary.fieldPermissionChanges),
          scopeChanges: countScopeChanges(summary.scopeChanges),
        },
      };
    });
  }

  /**
   * Outside-tx wrapper that opens its own `withTenant` block,
   * reloads the role, and appends a version row. Used by the
   * revert flow (which has already committed the underlying
   * scope / field-perm writes through their own tx and just
   * needs to mark the final state with the `revert` discriminator
   * + the source-version pointer).
   */
  async recordVersionStandalone(input: {
    readonly role: RoleWithCapabilities;
    readonly tenantId: string;
    readonly actorUserId: string | null;
    readonly triggerAction: RoleVersionTriggerAction;
    readonly reason?: string | null;
    readonly revertedFromVersionId?: string | null;
    readonly revertedFromVersionNumber?: number | null;
  }): Promise<{ id: string; versionNumber: number } | null> {
    return this.prisma.withTenant(input.tenantId, (tx) =>
      this.recordVersion(tx, input.tenantId, {
        role: input.role,
        triggerAction: input.triggerAction,
        actorUserId: input.actorUserId,
        reason: input.reason ?? null,
        revertedFromVersionId: input.revertedFromVersionId ?? null,
        revertedFromVersionNumber: input.revertedFromVersionNumber ?? null,
      }),
    );
  }

  /**
   * Best-effort audit emit for the `rbac.role.version_reverted`
   * verb. Called by the controller AFTER the revert PATCH lands.
   * Payload is metadata-only (counts + risk flags + revertedFromX).
   */
  async writeRevertAudit(input: {
    actorUserId: string;
    targetRoleId: string;
    targetRoleCode: string;
    revertedFromVersionId: string;
    revertedFromVersionNumber: number;
    newVersionNumber: number;
    grantedCount: number;
    revokedCount: number;
    fieldChangeCount: number;
    scopeChangeCount: number;
    riskFlags: RoleRiskSummary;
  }): Promise<void> {
    if (!this.audit) return;
    try {
      await this.audit.writeEvent({
        action: 'rbac.role.version_reverted',
        entityType: 'role',
        entityId: input.targetRoleId,
        actorUserId: input.actorUserId,
        payload: {
          targetRoleId: input.targetRoleId,
          targetRoleCode: input.targetRoleCode,
          revertedFromVersionId: input.revertedFromVersionId,
          revertedFromVersionNumber: input.revertedFromVersionNumber,
          newVersionNumber: input.newVersionNumber,
          grantedCount: input.grantedCount,
          revokedCount: input.revokedCount,
          fieldChangeCount: input.fieldChangeCount,
          scopeChangeCount: input.scopeChangeCount,
          riskFlags: input.riskFlags as unknown as Record<string, boolean>,
        },
      });
    } catch {
      // Audit is best-effort.
    }
  }
}

// ─── helpers (pure) ──────────────────────────────────────────────

export function buildSnapshot(role: RoleWithCapabilities): RoleVersionSnapshot {
  return {
    metadata: {
      code: role.code,
      nameEn: role.nameEn,
      nameAr: role.nameAr,
      level: role.level,
      description: role.description,
      isSystem: role.isSystem,
      isActive: role.isActive,
    },
    capabilities: [...role.capabilities].sort(),
    scopes: role.scopes
      .map((s) => ({ resource: s.resource, scope: s.scope }))
      .sort((a, b) => a.resource.localeCompare(b.resource)),
    fieldPermissions: role.fieldPermissions
      .map((p) => ({
        resource: p.resource,
        field: p.field,
        canRead: p.canRead,
        canWrite: p.canWrite,
      }))
      .sort((a, b) =>
        a.resource === b.resource
          ? a.field.localeCompare(b.field)
          : a.resource.localeCompare(b.resource),
      ),
  };
}

function snapshotsEqual(a: RoleVersionSnapshot, b: RoleVersionSnapshot): boolean {
  // Snapshots are produced by `buildSnapshot` which sorts every
  // array, so a structural deep-equal is enough.
  return JSON.stringify(a) === JSON.stringify(b);
}

export function computeChangeSummary(
  previous: RoleVersionSnapshot | null,
  next: RoleVersionSnapshot,
): RoleVersionChangeSummary {
  const prevCaps = new Set(previous?.capabilities ?? []);
  const nextCaps = new Set(next.capabilities);
  const granted: string[] = [];
  const revoked: string[] = [];
  for (const c of nextCaps) if (!prevCaps.has(c)) granted.push(c);
  for (const c of prevCaps) if (!nextCaps.has(c)) revoked.push(c);
  granted.sort();
  revoked.sort();

  const fieldChanges = diffFieldPermissions(
    previous?.fieldPermissions ?? [],
    next.fieldPermissions,
  );

  const scopeChanges = diffScopes(previous?.scopes ?? [], next.scopes);

  // Risk flags ride the same helper the change-preview surface
  // uses, so History rows and the Review modal use one vocabulary.
  const riskFlags = computeRiskSummary({
    capabilityChanges: {
      granted,
      revoked,
      unchangedCount: prevCaps.size - revoked.length,
    },
    fieldChanges,
  });

  return {
    grantedCapabilities: granted,
    revokedCapabilities: revoked,
    fieldPermissionChanges: fieldChanges,
    scopeChanges,
    riskFlags,
  };
}

function diffFieldPermissions(
  before: ReadonlyArray<{ resource: string; field: string; canRead: boolean; canWrite: boolean }>,
  after: ReadonlyArray<{ resource: string; field: string; canRead: boolean; canWrite: boolean }>,
): RoleVersionChangeSummary['fieldPermissionChanges'] {
  const beforeReadDenied = collectDenied(before, 'read');
  const beforeWriteDenied = collectDenied(before, 'write');
  const afterReadDenied = collectDenied(after, 'read');
  const afterWriteDenied = collectDenied(after, 'write');
  return {
    readDeniedAdded: setDiff(afterReadDenied, beforeReadDenied),
    readDeniedRemoved: setDiff(beforeReadDenied, afterReadDenied),
    writeDeniedAdded: setDiff(afterWriteDenied, beforeWriteDenied),
    writeDeniedRemoved: setDiff(beforeWriteDenied, afterWriteDenied),
  };
}

function collectDenied(
  rows: ReadonlyArray<{ resource: string; field: string; canRead: boolean; canWrite: boolean }>,
  axis: 'read' | 'write',
): Map<string, { resource: string; field: string }> {
  const m = new Map<string, { resource: string; field: string }>();
  for (const r of rows) {
    const denied = axis === 'read' ? !r.canRead : !r.canWrite;
    if (denied) {
      const key = `${r.resource}::${r.field}`;
      if (!m.has(key)) m.set(key, { resource: r.resource, field: r.field });
    }
  }
  return m;
}

function setDiff(
  a: Map<string, { resource: string; field: string }>,
  b: Map<string, { resource: string; field: string }>,
): ReadonlyArray<{ resource: string; field: string }> {
  const out: Array<{ resource: string; field: string }> = [];
  for (const [key, pair] of a) {
    if (!b.has(key)) out.push(pair);
  }
  out.sort((x, y) =>
    x.resource === y.resource
      ? x.field.localeCompare(y.field)
      : x.resource.localeCompare(y.resource),
  );
  return out;
}

function diffScopes(
  before: ReadonlyArray<{ resource: string; scope: string }>,
  after: ReadonlyArray<{ resource: string; scope: string }>,
): RoleVersionChangeSummary['scopeChanges'] {
  const beforeMap = new Map(before.map((s) => [s.resource, s.scope]));
  const afterMap = new Map(after.map((s) => [s.resource, s.scope]));
  const changed: Array<{ resource: string; from: string; to: string }> = [];
  const added: Array<{ resource: string; scope: string }> = [];
  const removed: Array<{ resource: string; scope: string }> = [];
  for (const [resource, scope] of afterMap) {
    const prev = beforeMap.get(resource);
    if (prev === undefined) added.push({ resource, scope });
    else if (prev !== scope) changed.push({ resource, from: prev, to: scope });
  }
  for (const [resource, scope] of beforeMap) {
    if (!afterMap.has(resource)) removed.push({ resource, scope });
  }
  changed.sort((a, b) => a.resource.localeCompare(b.resource));
  added.sort((a, b) => a.resource.localeCompare(b.resource));
  removed.sort((a, b) => a.resource.localeCompare(b.resource));
  return { changed, added, removed };
}

function countFieldChanges(c: RoleVersionChangeSummary['fieldPermissionChanges']): number {
  return (
    c.readDeniedAdded.length +
    c.readDeniedRemoved.length +
    c.writeDeniedAdded.length +
    c.writeDeniedRemoved.length
  );
}

function countScopeChanges(c: RoleVersionChangeSummary['scopeChanges']): number {
  return c.changed.length + c.added.length + c.removed.length;
}
