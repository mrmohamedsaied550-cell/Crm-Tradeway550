import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';

import type { RoleScopeValue } from './rbac.dto';

/**
 * Phase C — C3: data-scope resolver.
 *
 * Translates a user's role-level scope (own / team / company /
 * country / global) into a Prisma `where` clause that ANDs into
 * every read path of a scoped resource. Today only the `lead`
 * resource is wired (this commit); C10 extends to captain /
 * followup / whatsapp.conversation reusing the same plumbing.
 *
 * Design rules:
 *
 *   • The 11 system roles seeded by C1 all default to `'global'`
 *     scope, so this service returns `null` (no extra filter) for
 *     them. The 469 existing tests therefore see zero behaviour
 *     change.
 *
 *   • An empty result set MUST be representable as a Prisma
 *     `where`. We use `{ id: { in: [] } }` for "match nothing"
 *     because `false` isn't a Prisma operator. Callers AND this
 *     into their existing `where`, so the row count is forced to
 *     zero without breaking the rest of the predicate.
 *
 *   • Reads happen inside `withTenant(tenantId, ...)` so RLS keeps
 *     even a malicious caller from sniffing other tenants' user /
 *     team / scope rows.
 *
 *   • The service is stateless except for the PrismaService dep —
 *     scope is resolved per-request, never cached, so admin role
 *     edits take effect on the next call without a session refresh.
 */

export interface ScopeUserClaims {
  /** User id (uuid) — the `sub` claim on AccessTokenClaims. */
  userId: string;
  /** Tenant id (uuid) — the `tid` claim. */
  tenantId: string;
  /** Role id (uuid) — the `rid` claim. */
  roleId: string;
}

export interface LeadScopeResolution {
  /** The configured scope for (role, 'lead'). */
  scope: RoleScopeValue;
  /**
   * The Prisma `where` to AND into list/findFirst calls. `null`
   * means no extra filter (`'global'` scope).
   */
  where: Prisma.LeadWhereInput | null;
}

@Injectable()
export class ScopeContextService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolve the calling user's scope for the `lead` resource and
   * return both the scope value and the Prisma `where` clause to
   * AND into list/findFirst queries.
   *
   * Empty result hint: every non-global path that finds zero
   * scoping rows (no team, no scope assignments) returns
   * `{ id: { in: [] } }` so the caller's query yields zero rows
   * deterministically.
   */
  async resolveLeadScope(claims: ScopeUserClaims): Promise<LeadScopeResolution> {
    return this.prisma.withTenant(claims.tenantId, async (tx) => {
      const row = await tx.roleScope.findUnique({
        where: { roleId_resource: { roleId: claims.roleId, resource: 'lead' } },
        select: { scope: true },
      });
      const scope = (row?.scope as RoleScopeValue | undefined) ?? 'global';

      if (scope === 'global') {
        return { scope, where: null };
      }

      if (scope === 'own') {
        return { scope, where: { assignedToId: claims.userId } };
      }

      if (scope === 'team') {
        const me = await tx.user.findUnique({
          where: { id: claims.userId },
          select: { teamId: true },
        });
        if (!me?.teamId) {
          // No team → cannot see anyone else's leads. Fallback to
          // 'own' so the user retains visibility on their own work
          // without leaking teammates' rows that don't exist.
          return { scope, where: { assignedToId: claims.userId } };
        }
        const teamMembers = await tx.user.findMany({
          where: { teamId: me.teamId },
          select: { id: true },
        });
        return {
          scope,
          where: { assignedToId: { in: teamMembers.map((u) => u.id) } },
        };
      }

      // company / country — both consult user_scope_assignments.
      const assignments = await tx.userScopeAssignment.findMany({
        where: { userId: claims.userId },
        select: { companyId: true, countryId: true },
      });
      if (assignments.length === 0) {
        return { scope, where: { id: { in: [] } } };
      }

      if (scope === 'company') {
        const companyIds = Array.from(
          new Set(
            assignments
              .map((a) => a.companyId)
              .filter((id): id is string => typeof id === 'string'),
          ),
        );
        if (companyIds.length === 0) {
          return { scope, where: { id: { in: [] } } };
        }
        return { scope, where: { companyId: { in: companyIds } } };
      }

      // country
      const countryIds = Array.from(
        new Set(
          assignments.map((a) => a.countryId).filter((id): id is string => typeof id === 'string'),
        ),
      );
      if (countryIds.length === 0) {
        return { scope, where: { id: { in: [] } } };
      }
      return { scope, where: { countryId: { in: countryIds } } };
    });
  }
}
