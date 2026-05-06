import { Injectable, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import type { ScopeUserClaims } from '../rbac/scope-context.service';
import { WhatsAppVisibilityService } from '../rbac/whatsapp-visibility.service';
import { requireTenantId } from '../tenants/tenant-context';

/**
 * C40 — Audit service.
 *
 * `writeEvent` appends a row to `audit_events` for non-lead-scoped
 * admin actions (bonus / competition / follow-up CRUD). It never
 * raises — audit failures are warned and swallowed so a downstream
 * write doesn't fail because the audit log briefly chokes.
 *
 * `list` returns a unified, normalized stream of `audit_events` plus
 * `lead_activities` (the lead-scoped audit trail authored elsewhere
 * — assignment / handover / sla_breach / note / stage_change /
 * auto_assignment), sorted desc by timestamp. Limited to a sensible
 * default; pagination via the `before` cursor.
 */

export interface AuditRow {
  source: 'audit_event' | 'lead_activity';
  id: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  actorUserId: string | null;
  payload: Prisma.JsonValue | null;
  createdAt: Date;
}

@Injectable()
export class AuditService {
  constructor(
    private readonly prisma: PrismaService,
    /**
     * Phase D5 — D5.12-B: WhatsApp activity payload redactor.
     * Applied to lead-activity rows in the unified audit feed so
     * `whatsapp_handover` / `whatsapp_handover_summary` payloads
     * don't leak prior-owner identity or handover summary text
     * via the `/audit` endpoint. @Optional so legacy fixtures
     * keep compiling; production wiring (the @Global RbacModule)
     * always provides it.
     */
    @Optional() private readonly whatsappVisibility?: WhatsAppVisibilityService,
  ) {}

  /**
   * Append an audit row inside an existing transaction (so the audit
   * lands or rolls back with the parent write).
   */
  async writeInTx(
    tx: Prisma.TransactionClient,
    tenantId: string,
    input: {
      action: string;
      entityType?: string | null;
      entityId?: string | null;
      payload?: Prisma.InputJsonValue;
      actorUserId?: string | null;
    },
  ): Promise<void> {
    await tx.auditEvent.create({
      data: {
        tenantId,
        action: input.action,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        ...(input.payload !== undefined && { payload: input.payload }),
        actorUserId: input.actorUserId ?? null,
      },
    });
  }

  /** Best-effort write outside a transaction. Failures are swallowed. */
  async writeEvent(input: {
    action: string;
    entityType?: string | null;
    entityId?: string | null;
    payload?: Prisma.InputJsonValue;
    actorUserId?: string | null;
  }): Promise<void> {
    const tenantId = requireTenantId();
    try {
      await this.prisma.withTenant(tenantId, (tx) => this.writeInTx(tx, tenantId, input));
    } catch {
      // Audit must not break the parent operation. The triggering
      // service has already returned its result by the time this runs.
    }
  }

  /**
   * P2-04 — pre-context audit write.
   *
   * Identical to `writeEvent`, but takes the `tenantId` explicitly so
   * authentication flows (login / refresh / logout / lockout) — which
   * run BEFORE the tenant-context middleware has set
   * AsyncLocalStorage — can still record an audit row. Failures are
   * swallowed so an audit outage never breaks the auth path.
   */
  async writeForTenant(
    tenantId: string,
    input: {
      action: string;
      entityType?: string | null;
      entityId?: string | null;
      payload?: Prisma.InputJsonValue;
      actorUserId?: string | null;
    },
  ): Promise<void> {
    try {
      await this.prisma.withTenant(tenantId, (tx) => this.writeInTx(tx, tenantId, input));
    } catch {
      // see writeEvent
    }
  }

  /**
   * P2-04 — accept an `action` filter on the unified audit feed.
   *
   * Three shapes:
   *   - exact match  (e.g. `?action=auth.login.success`)
   *   - prefix match (e.g. `?action=auth.*`)  — convenient for "show
   *     me everything auth-related" without the caller having to OR
   *     a dozen specific verbs together.
   *   - allow-listed actionPrefix group (D5.11) — caller passes the
   *     allow-list KEY (e.g. `'rbac'`, `'tenant_export'`) and the
   *     service translates it to the canonical prefix string. This
   *     is the path the admin audit chips use.
   *
   * D5.11 — the optional `entityId` filter narrows to one specific
   * audit_event row (e.g. "all rbac.role.previewed events for role
   * X"). Lead activities have no entityId column — when the filter
   * is set the activities half is dropped (saves a query when the
   * caller wants a non-lead-scoped view).
   */
  async list(
    opts: {
      limit?: number;
      before?: Date;
      action?: string;
      /**
       * D5.11 — list of allow-listed action prefixes. Each prefix
       * is ORed into the `audit_events.action` filter via
       * `startsWith`. Resolved from `AUDIT_ACTION_GROUPS` by the
       * controller; the service never accepts a free-form prefix.
       */
      actionPrefixes?: readonly string[];
      entityId?: string;
      /**
       * D5.12-B — caller's scope claims. When supplied, the
       * lead-activity half of the stream gets the WhatsApp
       * handover-payload redaction (sub-keys `fromUserId` /
       * `toUserId` / `summary` are nulled when the role's
       * `whatsapp.conversation` deny rules require it). When
       * absent (system-context callers, tests), the rows pass
       * through unchanged — the audit field-redaction
       * interceptor at the controller layer is the fallback gate.
       */
      userClaims?: ScopeUserClaims;
    } = {},
  ): Promise<AuditRow[]> {
    const tenantId = requireTenantId();
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
    const filter = parseActionFilter(opts.action);
    const entityIdFilter = opts.entityId?.trim();
    const safePrefixes = (opts.actionPrefixes ?? []).filter((p) => p.length > 0);
    const hasGroupFilter = safePrefixes.length > 0;
    return this.prisma.withTenant(tenantId, async (tx) => {
      const eventWhere: Prisma.AuditEventWhereInput = {
        ...(opts.before && { createdAt: { lt: opts.before } }),
        ...(filter.kind === 'exact' && { action: filter.value }),
        ...(filter.kind === 'prefix' && { action: { startsWith: filter.value } }),
        ...(hasGroupFilter && {
          OR: safePrefixes.map((p) => ({ action: { startsWith: p } })),
        }),
        ...(entityIdFilter && entityIdFilter.length > 0 && { entityId: entityIdFilter }),
      };
      // For lead_activities the action is `lead.<type>`, so prefix
      // filters on that half of the stream are mapped to a `type`
      // filter where it makes sense, and the row is dropped entirely
      // when the filter is for a non-lead namespace (e.g. `auth.*`).
      // D5.11 — entityId filter AND group-prefix filter ALSO drop
      // the activities half: lead_activities has its own `leadId`
      // column (not `entityId`), and the governance-event prefixes
      // we accept (rbac.*, role.*, user.scope.*, *.export.*) are
      // all in `audit_events`.
      const activitiesEnabled =
        !entityIdFilter &&
        !hasGroupFilter &&
        (filter.kind === 'none' ||
          (filter.kind === 'exact' && filter.value.startsWith('lead.')) ||
          (filter.kind === 'prefix' && 'lead.'.startsWith(filter.value)));
      const activityWhere: Prisma.LeadActivityWhereInput = {
        ...(opts.before && { createdAt: { lt: opts.before } }),
        ...(filter.kind === 'exact' &&
          filter.value.startsWith('lead.') && { type: filter.value.slice('lead.'.length) }),
        ...(filter.kind === 'prefix' &&
          filter.value.startsWith('lead.') && {
            type: { startsWith: filter.value.slice('lead.'.length) },
          }),
      };
      const [events, activities] = await Promise.all([
        tx.auditEvent.findMany({
          where: eventWhere,
          orderBy: { createdAt: 'desc' },
          take: limit,
        }),
        activitiesEnabled
          ? tx.leadActivity.findMany({
              where: activityWhere,
              orderBy: { createdAt: 'desc' },
              take: limit,
              select: {
                id: true,
                type: true,
                body: true,
                payload: true,
                createdAt: true,
                createdById: true,
                leadId: true,
              },
            })
          : Promise.resolve([]),
      ]);

      const rows: AuditRow[] = [
        ...events.map<AuditRow>((e) => ({
          source: 'audit_event',
          id: e.id,
          action: e.action,
          entityType: e.entityType,
          entityId: e.entityId,
          actorUserId: e.actorUserId,
          payload: e.payload as Prisma.JsonValue | null,
          createdAt: e.createdAt,
        })),
        ...activities.map<AuditRow>((a) => ({
          source: 'lead_activity',
          id: a.id,
          action: `lead.${a.type}`,
          entityType: 'lead',
          entityId: a.leadId,
          actorUserId: a.createdById,
          payload: (() => {
            const extra = a.payload && typeof a.payload === 'object' ? a.payload : {};
            return a.body !== null
              ? { body: a.body, ...(extra as Record<string, unknown>) }
              : a.payload;
          })() as Prisma.JsonValue | null,
          createdAt: a.createdAt,
        })),
      ];

      rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      const sliced = rows.slice(0, limit);
      // D5.12-B — apply WhatsApp activity payload redaction to
      // every audit row whose payload carries a
      // `whatsapp_handover` / `whatsapp_handover_summary` event.
      // The redactor mutates ONLY the payload sub-keys
      // (`fromUserId` / `toUserId` / `summary` / `body`) — every
      // other column passes through. Surgical, no row-count
      // change.
      if (this.whatsappVisibility && opts.userClaims) {
        const visibility = await this.whatsappVisibility.resolveConversationVisibility(
          opts.userClaims,
        );
        const helper = this.whatsappVisibility;
        return sliced.map((r) => helper.applyAuditRowPayload(r, visibility));
      }
      return sliced;
    });
  }
}

type ActionFilter =
  | { kind: 'none' }
  | { kind: 'exact'; value: string }
  | { kind: 'prefix'; value: string };

/** Parse `?action=auth.*` / `?action=auth.login.success` / undefined. */
function parseActionFilter(action: string | undefined): ActionFilter {
  if (!action || action.trim().length === 0) return { kind: 'none' };
  const trimmed = action.trim();
  if (trimmed.endsWith('.*')) {
    const prefix = trimmed.slice(0, -1); // keep the trailing dot
    return { kind: 'prefix', value: prefix };
  }
  return { kind: 'exact', value: trimmed };
}
