import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';

import type { RoleScopeValue } from './rbac.dto';

/**
 * Phase C — C3 + C3.5: data-scope resolver.
 *
 * Translates a user's role-level scope (own / team / company /
 * country / global) into a Prisma `where` clause that ANDs into
 * every read path of a scoped resource.
 *
 * ─── Internal documentation ─────────────────────────────────────────
 *
 * SCOPE SEMANTICS (resource-agnostic; today only `lead` is wired):
 *
 *   global   No extra filter. The user sees every row in the tenant
 *            (subject to RLS at the DB layer). Used by admins and
 *            anyone whose role.code === 'super_admin' (bypass).
 *
 *   own      `{ assignedToId: userId }` — the row's owner equals the
 *            calling user. Implicitly EXCLUDES rows where
 *            `assignedToId IS NULL` (Prisma's eq-string predicate
 *            never matches null), which matches the explicit
 *            "unassigned excluded" rule below.
 *
 *   team     `{ assignedToId: { in: teamMemberIds } }` — the row is
 *            owned by anyone in the calling user's team. If the
 *            user has NO team (teamId IS NULL), the user effectively
 *            has no team-mates AND no broader path: we return an
 *            empty result rather than silently widening to global or
 *            silently narrowing to 'own'. Admins must put the user
 *            in a team before granting team scope. Implicitly
 *            EXCLUDES unassigned (NULL) rows.
 *
 *   company  `{ companyId: { in: assignedCompanyIds } }` — sourced
 *            from `user_scope_assignments`. Empty assignments → empty
 *            result. Implicitly excludes rows whose companyId is
 *            NULL because IN doesn't match nulls.
 *
 *   country  `{ countryId: { in: assignedCountryIds } }` — same
 *            shape as company, sourced from the country side of
 *            user_scope_assignments. Empty assignments → empty
 *            result.
 *
 * UNASSIGNED LEADS (the "rows with assignedToId IS NULL" bucket):
 *   own      excluded (the IN/eq predicate never matches null).
 *   team     excluded (same reason).
 *   global   included (no filter).
 *   company  included if the lead has a matching companyId regardless
 *            of assignment status (assignment is independent of
 *            company scope).
 *   country  included if the lead has a matching countryId.
 *
 * SUPER ADMIN BYPASS:
 *   When `role.code === 'super_admin'` we always return `{ scope:
 *   'global', where: null }`, ignoring the role_scopes table.
 *   Admins who deliberately demote super_admin's `lead` scope (a
 *   no-op today since system roles are immutable, but defended here
 *   anyway) still get global. Two reasons:
 *     1. Operational safety — super admins may need to recover
 *        misconfigured tenants.
 *     2. The seed marks super_admin `is_system = true`, and C2's
 *        guards block edits. Even so, defence in depth.
 *
 * USER-REQUEST CONTEXT ONLY:
 *   This service is for *user-driven HTTP requests*. Internal jobs
 *   (SLA breach scanner, distribution engine, ingestion pipeline)
 *   MUST NOT pass user claims here — they should query the data
 *   layer directly with a tenant context. The service does not
 *   short-circuit when called without claims; it's the caller's
 *   responsibility to skip the resolution. TODO C10: when other
 *   resources (Captain, FollowUp, WhatsApp.Conversation) get scope
 *   wiring, document each entry-point's user-vs-system context too.
 *
 * EXTENSION PLAN (C10):
 *   Sibling methods will land for the other scoped resources:
 *     resolveCaptainScope     → Prisma.CaptainWhereInput
 *     resolveFollowUpScope    → Prisma.LeadFollowUpWhereInput
 *     resolveConversationScope → Prisma.WhatsAppConversationWhereInput
 *   Each method shares the SCOPE VALUE resolution (one query for the
 *   role_scopes row) but builds its own resource-specific where
 *   clause from the same set of inputs (userIds for own/team,
 *   companyIds / countryIds for company/country). The internal
 *   helpers below (resolveScopeRow, getTeamMembers, getAssignments)
 *   are designed to be reused.
 *
 * Reporting endpoints (C11+) will use the same SCOPE VALUE but join
 * differently (e.g. aggregate over leads matching scope); the
 * resolver returns the SCOPE VALUE alongside the where so reporting
 * can re-derive what it needs.
 *
 * ─── End internal documentation ─────────────────────────────────────
 *
 * Implementation rules:
 *
 *   • The 11 system roles seeded by C1 all default to `'global'`
 *     scope, so this service returns `null` (no extra filter) for
 *     them. The 491 existing tests therefore see zero behaviour
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
   * means no extra filter (`'global'` scope, including the
   * super_admin bypass).
   */
  where: Prisma.LeadWhereInput | null;
}

/**
 * Resource-agnostic intermediate shape produced by the internal
 * resolver. C10's per-resource adapters consume this directly so
 * the SCOPE VALUE + ID lookups happen exactly once per request.
 */
interface ScopeFilter {
  scope: RoleScopeValue;
  /** When 'own' or 'team': user ids to match against assignedToId. */
  userIds?: readonly string[];
  /** When 'company': company ids assigned to the user. */
  companyIds?: readonly string[];
  /** When 'country': country ids assigned to the user. */
  countryIds?: readonly string[];
  /**
   * True when the scope demands a deterministic empty result (no
   * team, no scope assignments). Adapters translate this to
   * `{ id: { in: [] } }`.
   */
  isEmpty?: boolean;
}

/** Hardcoded bypass — see "SUPER ADMIN BYPASS" in the file header. */
const SUPER_ADMIN_CODE = 'super_admin';

@Injectable()
export class ScopeContextService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolve the calling user's scope for the `lead` resource and
   * return both the scope value and the Prisma `where` clause to
   * AND into list/findFirst queries.
   *
   * USER-REQUEST CONTEXT ONLY. See file-level docs.
   */
  async resolveLeadScope(claims: ScopeUserClaims): Promise<LeadScopeResolution> {
    const filter = await this.resolveScopeFilter(claims, 'lead');
    return { scope: filter.scope, where: this.toLeadWhere(filter) };
  }

  // ───────────────────────────────────────────────────────────────────
  // Internal — resource-agnostic resolver + per-resource adapters
  // ───────────────────────────────────────────────────────────────────

  /**
   * Resolve the SCOPE VALUE + the input ids needed by any resource
   * adapter. One DB round-trip set; adapters do no further IO.
   */
  private async resolveScopeFilter(
    claims: ScopeUserClaims,
    resource: 'lead' | 'captain' | 'followup' | 'whatsapp.conversation',
  ): Promise<ScopeFilter> {
    return this.prisma.withTenant(claims.tenantId, async (tx) => {
      // 1. Super admin bypass — short-circuit before consulting
      //    role_scopes. See header docs for rationale.
      const role = await tx.role.findUnique({
        where: { id: claims.roleId },
        select: { code: true },
      });
      if (role?.code === SUPER_ADMIN_CODE) {
        return { scope: 'global' as RoleScopeValue };
      }

      // 2. Look up the role's scope for the requested resource. Falls
      //    back to 'global' so a misseeded role can't lock the user
      //    out of every resource.
      const scopeRow = await tx.roleScope.findUnique({
        where: { roleId_resource: { roleId: claims.roleId, resource } },
        select: { scope: true },
      });
      const scope = (scopeRow?.scope as RoleScopeValue | undefined) ?? 'global';

      if (scope === 'global' || scope === 'own') {
        return { scope, ...(scope === 'own' && { userIds: [claims.userId] }) };
      }

      if (scope === 'team') {
        const me = await tx.user.findUnique({
          where: { id: claims.userId },
          select: { teamId: true },
        });
        if (!me?.teamId) {
          // C3.5: a user on team scope without a team gets ZERO
          // visibility — no fallback to 'own'. Admins must place
          // the user in a team first.
          return { scope, isEmpty: true };
        }
        const teamMembers = await tx.user.findMany({
          where: { teamId: me.teamId },
          select: { id: true },
        });
        return { scope, userIds: teamMembers.map((u) => u.id) };
      }

      // company / country — both consult user_scope_assignments.
      const assignments = await tx.userScopeAssignment.findMany({
        where: { userId: claims.userId },
        select: { companyId: true, countryId: true },
      });
      if (assignments.length === 0) {
        return { scope, isEmpty: true };
      }

      if (scope === 'company') {
        const companyIds = Array.from(
          new Set(
            assignments
              .map((a) => a.companyId)
              .filter((id): id is string => typeof id === 'string'),
          ),
        );
        return companyIds.length > 0 ? { scope, companyIds } : { scope, isEmpty: true };
      }

      // country
      const countryIds = Array.from(
        new Set(
          assignments.map((a) => a.countryId).filter((id): id is string => typeof id === 'string'),
        ),
      );
      return countryIds.length > 0 ? { scope, countryIds } : { scope, isEmpty: true };
    });
  }

  /**
   * Build a Prisma `where` for the `Lead` table from a generic
   * ScopeFilter. Returns `null` when no filter is needed (global +
   * super-admin bypass). Future resources (Captain, FollowUp,
   * WhatsAppConversation) will have sibling adapters under the
   * same internal contract.
   */
  private toLeadWhere(filter: ScopeFilter): Prisma.LeadWhereInput | null {
    if (filter.isEmpty) return { id: { in: [] } };
    if (filter.scope === 'global') return null;
    if (filter.scope === 'own' || filter.scope === 'team') {
      const ids = filter.userIds ?? [];
      // C3.5 — explicit `not: null` documents intent: own/team
      // exclude unassigned leads. The IN/eq predicate already
      // skips nulls, but spelling it out makes the semantic
      // obvious in code review and audit reads.
      return { assignedToId: { in: ids as string[] }, NOT: { assignedToId: null } };
    }
    if (filter.scope === 'company') {
      return { companyId: { in: (filter.companyIds ?? []) as string[] } };
    }
    if (filter.scope === 'country') {
      return { countryId: { in: (filter.countryIds ?? []) as string[] } };
    }
    return null;
  }
}
