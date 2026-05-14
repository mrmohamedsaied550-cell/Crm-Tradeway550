import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { PermissionCacheService } from '../rbac/permission-cache.service';
import { requireTenantId } from '../tenants/tenant-context';

export interface CompanyAssignmentRow {
  id: string;
  code: string;
  name: string;
}

export interface CountryAssignmentRow {
  id: string;
  code: string;
  name: string;
  companyId: string;
}

export interface UserScopeAssignments {
  companies: CompanyAssignmentRow[];
  countries: CountryAssignmentRow[];
}

export interface PutUserScopeAssignmentsInput {
  companyIds?: readonly string[];
  countryIds?: readonly string[];
}

/** Sprint 8 (D8) — bulk endpoint shapes. */
export interface UserScopeCount {
  userId: string;
  companyCount: number;
  countryCount: number;
  hasAnyScope: boolean;
}

export interface UserScopeCountsResponse {
  items: UserScopeCount[];
}

export interface UserScopeAssignmentsForUser extends UserScopeAssignments {
  userId: string;
}

export interface UserScopeAssignmentsBulkResponse {
  items: UserScopeAssignmentsForUser[];
}

/**
 * Sprint 8 (D8) — caller-side ids cap. Mirrors the plan; protects
 * the API from a runaway query and the audit reviewer from a 10k-row
 * stack-trace. The cap is enforced on the parsed DTO so the
 * controller doesn't have to re-validate.
 */
export const SCOPE_BULK_MAX_IDS = 200;

/**
 * Phase C — C9: read + replace `user_scope_assignments` for a single
 * user in the active tenant.
 *
 * The data model stores one row per (user, company) and one row per
 * (user, country) — the same table, with company_id / country_id
 * mutually exclusive per row. C3's `ScopeContextService` consumes
 * those rows when resolving `company` / `country` scope, so any
 * change here takes effect on the user's NEXT request — no session
 * refresh required.
 *
 * The write path is replace-the-set:
 *   • the controller passes the FULL desired list per dimension;
 *   • the service computes the diff vs the current rows;
 *   • inside a single transaction, removed rows are deleted and added
 *     rows are created;
 *   • audit events (`user.scope.update` always; `user.scope.assign`
 *     when rows were added; `user.scope.revoke` when rows were
 *     removed) are appended in the same transaction so audit lands
 *     iff the write commits.
 *
 * Cross-tenant safety:
 *   • `assertUserInTenant` rejects ids the calling tenant can't see.
 *   • Each company / country id is verified against the active GUC
 *     (`assertCompanyInTenant` / `assertCountryInTenant`) before any
 *     write — RLS would also reject foreign rows, but the typed
 *     errors give the UI a clean shape (`{code,message}`).
 */
@Injectable()
export class UserScopeAssignmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    /**
     * Phase D5 — D5.1: optional permission-cache invalidator.
     * @Optional so existing tests build without wiring the RBAC
     * module. Active in production wiring.
     */
    @Optional() private readonly permissionCache?: PermissionCacheService,
  ) {}

  /** Read the current assignments for a user, joined to the entity rows. */
  async listForUser(userId: string): Promise<UserScopeAssignments> {
    const tenantId = requireTenantId();
    await this.assertUserInTenant(userId);

    return this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.userScopeAssignment.findMany({
        where: { userId },
        select: {
          companyId: true,
          countryId: true,
          company: { select: { id: true, code: true, name: true } },
          country: { select: { id: true, code: true, name: true, companyId: true } },
        },
      });

      const companies: CompanyAssignmentRow[] = [];
      const countries: CountryAssignmentRow[] = [];
      for (const r of rows) {
        if (r.company) {
          companies.push({ id: r.company.id, code: r.company.code, name: r.company.name });
        }
        if (r.country) {
          countries.push({
            id: r.country.id,
            code: r.country.code,
            name: r.country.name,
            companyId: r.country.companyId,
          });
        }
      }
      companies.sort((a, b) => a.name.localeCompare(b.name));
      countries.sort((a, b) => a.name.localeCompare(b.name));
      return { companies, countries };
    });
  }

  /**
   * Replace the user's assignments. Returns the new state so the UI
   * can re-render without a second round-trip.
   */
  async replaceForUser(
    userId: string,
    input: PutUserScopeAssignmentsInput,
    actorUserId: string,
  ): Promise<UserScopeAssignments> {
    const tenantId = requireTenantId();
    await this.assertUserInTenant(userId);

    const desiredCompanyIds = uniq(input.companyIds ?? []);
    const desiredCountryIds = uniq(input.countryIds ?? []);

    // Validate each id lives in the active tenant before opening the
    // write transaction — failing fast keeps the audit log free of
    // half-applied changes.
    for (const id of desiredCompanyIds) {
      await this.assertCompanyInTenant(id);
    }
    for (const id of desiredCountryIds) {
      await this.assertCountryInTenant(id);
    }

    return this.prisma.withTenant(tenantId, async (tx) => {
      const existing = await tx.userScopeAssignment.findMany({
        where: { userId },
        select: { id: true, companyId: true, countryId: true },
      });

      const existingCompanyIds = new Set<string>(
        existing.map((r) => r.companyId).filter((v): v is string => typeof v === 'string'),
      );
      const existingCountryIds = new Set<string>(
        existing.map((r) => r.countryId).filter((v): v is string => typeof v === 'string'),
      );

      const desiredCompanySet = new Set(desiredCompanyIds);
      const desiredCountrySet = new Set(desiredCountryIds);

      const addedCompanyIds = desiredCompanyIds.filter((id) => !existingCompanyIds.has(id));
      const removedCompanyIds = [...existingCompanyIds].filter((id) => !desiredCompanySet.has(id));
      const addedCountryIds = desiredCountryIds.filter((id) => !existingCountryIds.has(id));
      const removedCountryIds = [...existingCountryIds].filter((id) => !desiredCountrySet.has(id));

      const idsToDelete = existing
        .filter(
          (r) =>
            (r.companyId !== null && removedCompanyIds.includes(r.companyId)) ||
            (r.countryId !== null && removedCountryIds.includes(r.countryId)),
        )
        .map((r) => r.id);

      if (idsToDelete.length > 0) {
        await tx.userScopeAssignment.deleteMany({ where: { id: { in: idsToDelete } } });
      }

      if (addedCompanyIds.length > 0) {
        await tx.userScopeAssignment.createMany({
          data: addedCompanyIds.map((companyId) => ({
            tenantId,
            userId,
            companyId,
            countryId: null,
          })),
          skipDuplicates: true,
        });
      }
      if (addedCountryIds.length > 0) {
        await tx.userScopeAssignment.createMany({
          data: addedCountryIds.map((countryId) => ({
            tenantId,
            userId,
            companyId: null,
            countryId,
          })),
          skipDuplicates: true,
        });
      }

      const before = {
        companyIds: [...existingCompanyIds].sort(),
        countryIds: [...existingCountryIds].sort(),
      };
      const after = {
        companyIds: [...desiredCompanyIds].sort(),
        countryIds: [...desiredCountryIds].sort(),
      };

      // Always emit a single update event with the full before/after
      // so the audit log carries the intent of the operation. The
      // assign / revoke events below carry only the diff so reviewers
      // can scan additions / removals without diffing payloads by hand.
      await this.audit.writeInTx(tx, tenantId, {
        action: 'user.scope.update',
        entityType: 'user',
        entityId: userId,
        actorUserId,
        payload: { targetUserId: userId, before, after },
      });

      if (addedCompanyIds.length > 0 || addedCountryIds.length > 0) {
        await this.audit.writeInTx(tx, tenantId, {
          action: 'user.scope.assign',
          entityType: 'user',
          entityId: userId,
          actorUserId,
          payload: {
            targetUserId: userId,
            companyIds: [...addedCompanyIds].sort(),
            countryIds: [...addedCountryIds].sort(),
          },
        });
      }
      if (removedCompanyIds.length > 0 || removedCountryIds.length > 0) {
        await this.audit.writeInTx(tx, tenantId, {
          action: 'user.scope.revoke',
          entityType: 'user',
          entityId: userId,
          actorUserId,
          payload: {
            targetUserId: userId,
            companyIds: [...removedCompanyIds].sort(),
            countryIds: [...removedCountryIds].sort(),
          },
        });
      }

      // Read back the joined rows for the response — same shape as
      // listForUser, sourced from the same transaction so the caller
      // sees the post-commit state immediately.
      const rows = await tx.userScopeAssignment.findMany({
        where: { userId },
        select: {
          company: { select: { id: true, code: true, name: true } },
          country: { select: { id: true, code: true, name: true, companyId: true } },
        },
      });
      const companies: CompanyAssignmentRow[] = [];
      const countries: CountryAssignmentRow[] = [];
      for (const r of rows) {
        if (r.company) {
          companies.push({ id: r.company.id, code: r.company.code, name: r.company.name });
        }
        if (r.country) {
          countries.push({
            id: r.country.id,
            code: r.country.code,
            name: r.country.name,
            companyId: r.country.companyId,
          });
        }
      }
      companies.sort((a, b) => a.name.localeCompare(b.name));
      countries.sort((a, b) => a.name.localeCompare(b.name));
      // Phase D5 — D5.1: company/country assignments feed the
      // PermissionResolverService.userScopes block. Invalidate so
      // the user's next request sees the new set.
      this.permissionCache?.invalidateUser(userId, tenantId);
      return { companies, countries };
    });
  }

  // ───────────────────────────────────────────────────────────────────
  // private guards
  // ───────────────────────────────────────────────────────────────────

  private async assertUserInTenant(userId: string): Promise<void> {
    const tenantId = requireTenantId();
    const row = await this.prisma.withTenant(tenantId, (tx) =>
      tx.user.findUnique({ where: { id: userId }, select: { id: true } }),
    );
    if (!row) {
      throw new NotFoundException({
        code: 'user.not_found',
        message: `User ${userId} is not defined in the active tenant`,
      });
    }
  }

  private async assertCompanyInTenant(companyId: string): Promise<void> {
    const tenantId = requireTenantId();
    const row = await this.prisma.withTenant(tenantId, (tx) =>
      tx.company.findUnique({ where: { id: companyId }, select: { id: true, isActive: true } }),
    );
    if (!row) {
      throw new BadRequestException({
        code: 'company.not_in_tenant',
        message: `Company ${companyId} is not defined in the active tenant`,
      });
    }
    if (!row.isActive) {
      throw new BadRequestException({
        code: 'company.inactive',
        message: `Company ${companyId} is not active`,
      });
    }
  }

  private async assertCountryInTenant(countryId: string): Promise<void> {
    const tenantId = requireTenantId();
    const row = await this.prisma.withTenant(tenantId, (tx) =>
      tx.country.findUnique({ where: { id: countryId }, select: { id: true, isActive: true } }),
    );
    if (!row) {
      throw new BadRequestException({
        code: 'country.not_in_tenant',
        message: `Country ${countryId} is not defined in the active tenant`,
      });
    }
    if (!row.isActive) {
      throw new BadRequestException({
        code: 'country.inactive',
        message: `Country ${countryId} is not active`,
      });
    }
  }

  // ───────────────────────────────────────────────────────────────────
  // Sprint 8 (D8) — Bulk read endpoints (capability-gated by users.read
  // at the controller level; tenant + RLS enforced by withTenant).
  // ───────────────────────────────────────────────────────────────────

  /**
   * Return per-user scope counts for the visible user population.
   *
   * If `ids` is omitted the response covers every user the active
   * tenant can see (filtered down by RLS to the caller's scope).
   * Users with zero assignments are included with `hasAnyScope=false`
   * — the whole point of this endpoint is the Organization KPI
   * "Users without scope", which requires the zero-rows case to be
   * a real row, not a missing one.
   *
   * One Postgres trip: a single SELECT against `users` LEFT JOINs
   * `user_scope_assignments` and groups by user_id. Prisma can't
   * model the left-join-with-aggregation directly, so we issue two
   * cheap queries inside the same `withTenant` block:
   *   1. fetch the visible user ids (respects RLS / caller scope);
   *   2. fetch the per-user counts from user_scope_assignments;
   * then merge on the server. Both queries are O(N) in the visible
   * user count; no per-user round-trip.
   */
  async listScopeCounts(input: { ids?: readonly string[] }): Promise<UserScopeCountsResponse> {
    const tenantId = requireTenantId();
    const filterIds = input.ids ? uniq(input.ids) : null;
    if (filterIds && filterIds.length > SCOPE_BULK_MAX_IDS) {
      throw new BadRequestException({
        code: 'scope.bulk.too_many_ids',
        message: `At most ${SCOPE_BULK_MAX_IDS} ids per request`,
      });
    }

    return this.prisma.withTenant(tenantId, async (tx) => {
      const users = await tx.user.findMany({
        where: filterIds ? { id: { in: [...filterIds] } } : {},
        select: { id: true },
      });

      const userIds = users.map((u) => u.id);
      if (userIds.length === 0) return { items: [] };

      const assignments = await tx.userScopeAssignment.findMany({
        where: { userId: { in: userIds } },
        select: { userId: true, companyId: true, countryId: true },
      });

      const countsByUser = new Map<string, { companyCount: number; countryCount: number }>();
      for (const a of assignments) {
        const cur = countsByUser.get(a.userId) ?? { companyCount: 0, countryCount: 0 };
        if (a.companyId !== null) cur.companyCount += 1;
        if (a.countryId !== null) cur.countryCount += 1;
        countsByUser.set(a.userId, cur);
      }

      const items: UserScopeCount[] = userIds.map((userId) => {
        const c = countsByUser.get(userId);
        const companyCount = c?.companyCount ?? 0;
        const countryCount = c?.countryCount ?? 0;
        return {
          userId,
          companyCount,
          countryCount,
          hasAnyScope: companyCount > 0 || countryCount > 0,
        };
      });
      return { items };
    });
  }

  /**
   * Return full scope assignments grouped per user for a given id
   * list. Bulk variant of `listForUser` used by the Organization
   * People table to render a scope chip without making N requests.
   *
   * `ids` is required for this endpoint — a bulk fetch without a
   * filter would risk a huge payload. The cap is enforced; the
   * caller must page if they need more.
   */
  async listAssignmentsBulk(input: {
    ids: readonly string[];
  }): Promise<UserScopeAssignmentsBulkResponse> {
    const tenantId = requireTenantId();
    const filterIds = uniq(input.ids);
    if (filterIds.length === 0) return { items: [] };
    if (filterIds.length > SCOPE_BULK_MAX_IDS) {
      throw new BadRequestException({
        code: 'scope.bulk.too_many_ids',
        message: `At most ${SCOPE_BULK_MAX_IDS} ids per request`,
      });
    }

    return this.prisma.withTenant(tenantId, async (tx) => {
      // Confirm every requested id belongs to the active tenant
      // before fetching assignments — RLS would filter foreign rows
      // anyway, but this lets us return a clean response that
      // contains exactly the visible subset (silently dropping
      // unknown ids rather than 404ing the whole batch).
      const visible = await tx.user.findMany({
        where: { id: { in: [...filterIds] } },
        select: { id: true },
      });
      const visibleIds = visible.map((u) => u.id);
      if (visibleIds.length === 0) return { items: [] };

      const rows = await tx.userScopeAssignment.findMany({
        where: { userId: { in: visibleIds } },
        select: {
          userId: true,
          company: { select: { id: true, code: true, name: true } },
          country: { select: { id: true, code: true, name: true, companyId: true } },
        },
      });

      const byUser = new Map<string, UserScopeAssignmentsForUser>();
      for (const id of visibleIds) {
        byUser.set(id, { userId: id, companies: [], countries: [] });
      }
      for (const r of rows) {
        const bucket = byUser.get(r.userId);
        if (!bucket) continue;
        if (r.company) {
          bucket.companies.push({ id: r.company.id, code: r.company.code, name: r.company.name });
        }
        if (r.country) {
          bucket.countries.push({
            id: r.country.id,
            code: r.country.code,
            name: r.country.name,
            companyId: r.country.companyId,
          });
        }
      }
      for (const bucket of byUser.values()) {
        bucket.companies.sort((a, b) => a.name.localeCompare(b.name));
        bucket.countries.sort((a, b) => a.name.localeCompare(b.name));
      }
      return { items: [...byUser.values()] };
    });
  }
}

function uniq(ids: readonly string[]): string[] {
  return Array.from(new Set(ids));
}
