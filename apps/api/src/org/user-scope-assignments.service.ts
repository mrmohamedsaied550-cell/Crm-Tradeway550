import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
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
}

function uniq(ids: readonly string[]): string[] {
  return Array.from(new Set(ids));
}
